# Sthenos deployment runbook

This runbook takes the app from an empty Hetzner server to a live site. It has
two audiences:

- **App owner**: a developer who runs the server, the GitHub repository and the
  DNS. Sections 1 to 12.
- **Supabase owner**: a separate person who owns the Supabase project. Section 6
  is written for them. Send them that section and the output they need to return.

Conventions used below:

- Replace every `<ANGLE_BRACKET>` value with your own. Never paste real secrets
  into this file, into chat, into tickets or into commits.
- `<APP_DOMAIN>` is the bare host, for example `sthenos.live`. No `https://`.
- Commands prefixed with `$` are typed in a shell. Run them where the comment says.

---

## 1. Overview

```
                      ┌──────────────────────────── Hetzner server (Docker) ───────────────────────────┐
                      │                                                                                 │
Browser ──HTTPS──▶  Caddy (80/443, Let's Encrypt)  ──▶  app (Node, port 3000)  ──▶  Supabase (DB, Auth, Vault)
                      │                                         │
                      └─────────────────────────────────────────┼──▶  Stripe (payments, webhooks in)
                                                                ├──▶  Resend (email out)
                                                                └──▶  Anthropic (Sensei AI)

pg_cron (inside Supabase) ──HTTPS POST + Bearer CRON_SECRET──▶  app /api/public/hooks/*
Supabase Auth ──Send Email hook (signed POST)──▶  app /api/public/hooks/auth-email
```

- The browser only talks to Caddy. Caddy terminates HTTPS and forwards to `app`.
- The app is stateless. Its data lives in Supabase.
- Supabase calls the app in two ways: its Auth hook for sign-in emails, and
  pg_cron jobs for the scheduled work.
- Images are built by GitHub Actions and pushed to GitHub Container Registry
  (`ghcr.io/<owner>/sthenos-app`). The server only pulls them.

---

## 2. Server (Hetzner)

### 2.1 Create the server

1. Log in to the Hetzner Cloud Console. Create or select a project.
2. Click **Add Server** and choose:
   - **Location**: Nuremberg (`nbg1`) or Falkenstein (`fsn1`). Our privacy notice
     says data is stored in Germany; keep it in one of these two.
   - **Image**: Ubuntu 24.04.
   - **Type**: CX22 or larger.
   - **Networking**: Public IPv4 and IPv6 both enabled.
   - **SSH keys**: add your public key (`~/.ssh/id_ed25519.pub`). Do not use a
     password.
   - **Name**: for example `sthenos-prod-1`.
3. Note the **IPv4** address. Note the **IPv6** address too. Hetzner shows a
   `/64` network; the server's own address ends in `::1`.

From your laptop, confirm you can log in as root:

```bash
$ ssh root@<SERVER_IPV4>
```

Every command in the rest of this section runs on the server as root unless
stated otherwise.

### 2.2 Create the `deploy` user

```bash
# adduser does not ask for a password because the account uses the SSH key only.
$ adduser --disabled-password --gecos "" deploy

# Copy root's authorised keys so the deploy user can log in with the same key.
$ install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
$ install -m 600 -o deploy -g deploy /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
```

The `deploy` user joins the `docker` group in section 2.5, after Docker is
installed. Without that group `deploy` cannot run Docker commands.

### 2.3 Disable password SSH

Keep your current root session open while you do this. Test a second session
before you close it.

```bash
$ cat > /etc/ssh/sshd_config.d/99-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
$ sshd -t && systemctl reload ssh
```

From your laptop, in a new terminal, confirm `ssh deploy@<SERVER_IPV4>` works
before you close the root session.

### 2.4 Hetzner Cloud Firewall

Hetzner's firewall runs outside the server, so it is the first line of defence.

1. In the Cloud Console open **Firewalls** → **Create Firewall**. Name it
   `sthenos-web`.
2. Add these **inbound** rules, source `Any IPv4` and `Any IPv6`:

   | Protocol | Port | Why              |
   |----------|------|------------------|
   | TCP      | 22   | SSH              |
   | TCP      | 80   | HTTP, redirects and certificate challenges |
   | TCP      | 443  | HTTPS            |
   | UDP      | 443  | HTTP/3 (QUIC)    |

   Optional: restrict port 22 to your own IP address.
3. Leave outbound unrestricted. The app calls Supabase, Stripe, Resend and
   Anthropic.
4. Under **Apply to**, select the `sthenos-prod-1` server. The rules do nothing
   until the firewall is applied.

Check from your laptop. Port 8080 should time out:

```bash
$ nc -vz -w 5 <SERVER_IPV4> 8080
```

### 2.5 Updates, then Docker

Automatic security updates:

```bash
$ apt-get update
$ apt-get install -y unattended-upgrades
$ dpkg-reconfigure -f noninteractive unattended-upgrades
```

Docker Engine and the Compose plugin, from Docker's official apt repository
(Ubuntu packages are older):

```bash
$ apt-get install -y ca-certificates curl
$ install -m 0755 -d /etc/apt/keyrings
$ curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
$ chmod a+r /etc/apt/keyrings/docker.asc
$ echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
$ apt-get update
$ apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Let `deploy` run Docker, then check the versions:

```bash
$ usermod -aG docker deploy
$ docker compose version
$ docker run --rm hello-world
```

Expected: `Docker Compose version v2.x` and a "Hello from Docker!" message.

### 2.6 Create `/opt/sthenos`

```bash
$ install -d -m 755 -o deploy -g deploy /opt/sthenos
$ install -d -m 755 -o deploy -g deploy /opt/sthenos/deploy
```

From your laptop, in a checkout of this repository, copy the two files the
server needs. The server never builds from source, so it needs no other code:

```bash
$ scp docker-compose.yml deploy@<SERVER_IPV4>:/opt/sthenos/docker-compose.yml
$ scp deploy/Caddyfile deploy@<SERVER_IPV4>:/opt/sthenos/deploy/Caddyfile
```

Create the runtime `.env` on the server, as `deploy`. Use the values from
section 4. Restrict its permissions straight away:

```bash
$ ssh deploy@<SERVER_IPV4>
deploy@server:~$ cd /opt/sthenos
deploy@server:/opt/sthenos$ umask 077
deploy@server:/opt/sthenos$ nano .env          # paste values from section 4
deploy@server:/opt/sthenos$ chmod 600 .env
deploy@server:/opt/sthenos$ ls -l .env
```

Expected: `-rw------- 1 deploy deploy ... .env`.

Rules for `.env`:

- Write `KEY=value` with no surrounding quotes. `.env.example` shows `KEY=""`
  as a placeholder; do not copy the quotes.
- Set `NODE_ENV=production` and `PORT=3000` explicitly. Do not leave them empty.
  An empty `NODE_ENV` overrides the image's `production` default, and the app
  then uses the sandbox Stripe key.
- `.env` is the only copy of the runtime secrets on the server. Keep a copy in
  your password manager. It is never committed to git.

### 2.7 Log in to GitHub Container Registry

The image is private by default, so the server needs a read-only token. Create
a GitHub classic personal access token with **only** the `read:packages`
scope (GitHub → Settings → Developer settings → Personal access tokens).

Run this as `deploy`, so the login is stored in `deploy`'s Docker config. The
CI deploy job runs as `deploy`:

```bash
deploy@server:~$ read -rs GHCR_TOKEN && echo
deploy@server:~$ echo "$GHCR_TOKEN" | docker login ghcr.io -u <GITHUB_USERNAME> --password-stdin
deploy@server:~$ unset GHCR_TOKEN
```

Expected: `Login Succeeded`.

Trade-off: you can instead make the package public (GitHub → your profile →
Packages → sthenos-app → Package settings → Change visibility). Then no token is
needed on the server, but anyone can pull the image and read the compiled
server code it contains. The browser bundle is public anyway. Choose private
unless you are sure you want the image public.

---

## 3. DNS

Point the domain at the server. Do this before the first deploy: Caddy asks
Let's Encrypt for a certificate, and that fails until DNS resolves.

| Type | Name                | Value                                                    |
|------|---------------------|----------------------------------------------------------|
| A    | `<APP_DOMAIN>`      | `<SERVER_IPV4>`                                          |
| AAAA | `<APP_DOMAIN>`      | the server's IPv6 address (ends in `::1`)                |

Check from your laptop. Both should print the server address (the IPv6 line
only if you created the AAAA record):

```bash
$ dig +short A <APP_DOMAIN>
$ dig +short AAAA <APP_DOMAIN>
```

`www`: the app's `CANONICAL_HOST` setting redirects `www.<CANONICAL_HOST>` to
the apex. For that redirect to be reachable, `deploy/Caddyfile` must also serve
the `www` host, because Caddy only obtains certificates for hosts it serves. The
current `deploy/Caddyfile` serves only `{$APP_DOMAIN}`. Until it is changed,
do not create a `www` record and leave `CANONICAL_HOST` unset. See section 12.

Wait until `dig` shows the server address before the first deploy.

---

## 4. Environment variables

Every variable in `.env.example` is listed here. The "Where it goes" column
says which of three places it is set:

- **repo variable**: a GitHub repository variable (Settings → Secrets and
  variables → Actions → Variables). The image build reads these. They are
  inlined into the browser bundle, so they must be public-safe.
- **server `.env`**: `/opt/sthenos/.env` on the server, read by the app container
  at start and by Compose for `${…}` substitution.
- **compose shell**: exported in the shell that runs `docker compose`. CI sets
  these for each deploy. Manual deploys set them by hand (section 9).

| Name | Where it goes | Where to get it | Required? |
|------|---------------|-----------------|-----------|
| `VITE_SUPABASE_URL` | repo variable (build time) | Supabase → Project Settings → API → Project URL (`https://<project-ref>.supabase.co`) | Yes |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | repo variable (build time) | Supabase → Project Settings → API → Publishable key (anon key) | Yes |
| `VITE_SUPABASE_PROJECT_ID` | repo variable (build time) | Supabase → Project Settings → General → Reference ID | Yes |
| `VITE_PUBLIC_SITE_URL` | repo variable (build time) and server `.env` | The canonical public origin, `https://<APP_DOMAIN>`. The server also reads it at runtime as a fallback. | Yes |
| `SUPABASE_URL` | server `.env` | Same value as `VITE_SUPABASE_URL` | Yes |
| `SUPABASE_PUBLISHABLE_KEY` | server `.env` | Same value as `VITE_SUPABASE_PUBLISHABLE_KEY` | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | server `.env` | Supabase → Project Settings → API → `service_role` key. It bypasses row-level security. Never put it in a repo variable or in the browser. | Yes |
| `STRIPE_SECRET_KEY` | server `.env` | Stripe → Developers → API keys → Secret key of the **platform** account, used for Connect (member dues). Use the live key (`sk_live_…`) in production. | Yes, for member dues |
| `STRIPE_WEBHOOK_SECRET` | server `.env` | Signing secret of the **Connect** webhook endpoint (section 7.2, `whsec_…`) | Yes, for member dues |
| `STRIPE_SANDBOX_API_KEY` | server `.env` | Stripe → Developers → API keys in **test mode** (`sk_test_…`) | Yes (sandbox fallback is used whenever live mode is not selected) |
| `STRIPE_LIVE_API_KEY` | server `.env` | Stripe → Developers → API keys in **live mode** (`sk_live_…`). The owner must confirm it is the account that holds the platform price IDs (section 7.1). | Yes, for live billing |
| `PAYMENTS_SANDBOX_WEBHOOK_SECRET` | server `.env` | Signing secret of the test-mode platform endpoint `…/api/public/payments/webhook?env=sandbox` (section 7.1) | Yes, if the sandbox endpoint exists |
| `PAYMENTS_LIVE_WEBHOOK_SECRET` | server `.env` | Signing secret of the live-mode platform endpoint `…/api/public/payments/webhook?env=live` (section 7.1) | Yes, for live billing |
| `RESEND_API_KEY` | server `.env` | Resend → API Keys → create a key with sending access | Yes |
| `EMAIL_SENDING_DOMAIN` | server `.env` | The domain you add in Resend (section 8). Default if unset: `notify.<site host>`. | Yes (set it explicitly) |
| `EMAIL_SENDING_LOCAL_PART` | server `.env` | The part before `@` for the sender address. Default `noreply`. | No |
| `EMAIL_SENDING_VERIFIED` | server `.env` | Set to `true` only after Resend shows the domain as verified (section 8). Until then the app checks DNS itself. | Yes, after verification |
| `SEND_EMAIL_HOOK_SECRET` | server `.env` | Generated in Supabase → Authentication → Hooks → Send Email (section 6c). Format `v1,whsec_…`. Copy it exactly. | Yes |
| `CRON_SECRET` | server `.env` **and** Supabase Vault (section 6e) | Generate with `openssl rand -hex 32`. At least 16 characters. Must be identical on both sides. | Yes |
| `ANTHROPIC_API_KEY` | server `.env` | Anthropic Console → API keys | Yes, for Sensei AI |
| `ANTHROPIC_MODEL` | server `.env` | Model name. Default if unset: `claude-opus-5-5`. | No |
| `APP_URL` | server `.env` | `https://<APP_DOMAIN>`. Used for redirects and links, and takes precedence over `SITE_URL`. | Recommended |
| `SITE_URL` | server `.env` | Fallback origin when `APP_URL` is unset. Set it to the same value. | No (if `APP_URL` is set) |
| `CANONICAL_HOST` | server `.env` | The apex host, e.g. `<APP_DOMAIN>`, for the `www` redirect. Leave unset until the Caddyfile serves `www` (section 3). | No |
| `TURNSTILE_SECRET_KEY` | server `.env` | Cloudflare dashboard → Turnstile → your widget → Secret key. Unset disables the bot check on public forms. | Required before go-live (section 12) |
| `PORT` | server `.env` | `3000`. The image default is 3000; Caddy proxies to `app:3000`. | Yes, set it to `3000` |
| `NODE_ENV` | server `.env` | `production`. Anything else selects sandbox Stripe. | Yes, set it to `production` |
| `APP_DOMAIN` | server `.env` (compose reads it for Caddy) | The bare domain, e.g. `<APP_DOMAIN>`. Compose refuses to start without it. | Yes |
| `IMAGE_TAG` | compose shell (CI sets it; manual deploys set it) | The git commit SHA of the image to run. Default `latest`. | Manual deploys: yes |
| `GHCR_OWNER` | compose shell (CI sets it; manual deploys set it) | The GitHub owner in lowercase, e.g. `<owner-lowercase>`. Default `local`, which will not pull. | Manual deploys: yes |

Notes:

- `VITE_SITE_URL` is also read by the server code as a fallback for `SITE_URL`.
  It is not in `.env.example`. Set `SITE_URL` (or `APP_URL`) instead.
- The Supabase Vault secret `app_cron_secret` holds the same value as
  `CRON_SECRET`. Section 6e puts it there.

Generate the secrets you create yourself:

```bash
$ openssl rand -hex 32     # CRON_SECRET
```

---

## 5. GitHub setup

Do this in the repository settings. Order matters: enable deploys last.

### 5.1 Repository variables

Settings → Secrets and variables → Actions → **Variables** tab → New repository
variable. Create these four. The image build fails if any is missing.

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_SUPABASE_PROJECT_ID`
- `VITE_PUBLIC_SITE_URL`

Values as in section 4.

### 5.2 Environment `production`

Settings → Environments → New environment → name it exactly `production`. Add
protection rules if you want a manual approval before deploys. The deploy job
refers to this environment.

### 5.3 Secrets

Settings → Secrets and variables → Actions → **Secrets** tab, or the
`production` environment's secrets. Create these three:

- `DEPLOY_HOST`: the server IPv4 address (or `<APP_DOMAIN>` once DNS points there).
- `DEPLOY_USER`: `deploy`.
- `DEPLOY_SSH_KEY`: a private key that can log in as `deploy`. Create a
  dedicated key for CI, not your personal key:

  ```bash
  $ ssh-keygen -t ed25519 -C "github-actions-deploy" -f ./sthenos-deploy-key -N ""
  $ ssh-copy-id -i ./sthenos-deploy-key.pub deploy@<SERVER_IPV4>
  ```

  Paste the full contents of `sthenos-deploy-key` (the private key, including the
  BEGIN and END lines) into the secret. Then delete the local key files.

### 5.4 Enable deploys last

Only after the first manual deploy in section 9 works, create the repository
variable `DEPLOY_ENABLED` with the value `true`. Until then, CI builds and pushes
the image on every push to `main`, but skips the deploy job.

Each push to `main` then runs: tests → image build and push → SSH deploy.

---

## 6. Supabase owner checklist

> **For the Supabase project owner.** This section is for you. The app owner
> needs the results of steps (c), (d) and (e) and will give you the values they
> ask for. Never send secrets in chat. Use the password manager the two of you share.

Replace `<APP_DOMAIN>` with the domain, e.g. `sthenos.live`.

### (a) Auth → URL Configuration

Supabase dashboard → **Authentication** → **URL Configuration**:

1. **Site URL**: `https://<APP_DOMAIN>`
2. **Redirect URLs**, add each on its own line:
   - `https://<APP_DOMAIN>/**`
   - `http://localhost:3000/**` (for local development only)
3. Save.

### (b) Auth → Providers → Google

1. Supabase dashboard → **Authentication** → **Sign In / Providers** → **Google**.
2. Turn it **on**.
3. Enter the **Client ID** and **Client secret** of a Google Cloud OAuth client.
   The app owner creates that client in Google Cloud Console (APIs & Services →
   Credentials → Create credentials → OAuth client ID → Web application). Its
   **Authorised redirect URI** must be exactly:

   ```
   https://<SUPABASE_PROJECT_REF>.supabase.co/auth/v1/callback
   ```

   `<SUPABASE_PROJECT_REF>` is the Reference ID from Project Settings → General.
4. Save.

### (c) Auth → Hooks → Send Email hook

Do this step only **after** the new app is live and answers the health check
(section 9). Until the switch, sign-in emails are sent by the old setup.
**Auth emails stop until the app answers the hook.** Plan a short window.

1. Supabase dashboard → **Authentication** → **Hooks** → **Send Email**.
2. Type: **HTTPS**. URL:

   ```
   https://<APP_DOMAIN>/api/public/hooks/auth-email
   ```

3. Click **Generate secret**. Copy the value. It has the form `v1,whsec_…`.
   Send it to the app owner by the shared password manager. The app owner puts it
   in `SEND_EMAIL_HOOK_SECRET` in `/opt/sthenos/.env` and restarts the app.
4. Save the hook.
5. Remove or disable the **old hook that points at Lovable** (the previous
   Lovable URL), so that auth emails are not sent through the old host.

The app checks the signature, so a wrong secret produces failed sign-in emails.
Test it with a password reset (section 9).

### (d) Send the current cron jobs to the app owner

In the Supabase SQL editor, run:

```sql
select jobid, jobname, schedule, command from cron.job order by jobid;
```

Send the **app owner** the result, with the `command` column redacted:

- Keep `jobid`, `jobname` and `schedule` as they are.
- Replace every token, password, key or `Bearer …` value in `command` with
  `[REDACTED]`. The old Lovable jobs may contain a service-role key.
- Keep the host name, so the app owner can see which job calls which URL.

The app owner needs the `schedule` of each job to fill in step (e).

### (e) Repoint the cron jobs

The script is `deploy/supabase/repoint-cron.sql` in the repository. It:

- stores `CRON_SECRET` in Supabase Vault as `app_cron_secret`;
- removes the old HTTP cron jobs (Lovable host or `/api/public/hooks/` in the
  command, plus the four known names). SQL-only jobs such as
  `enforce-overdue-grace` are not touched;
- schedules four jobs that call the app. Each reads the token from Vault at run
  time, so the token never appears in `cron.job`.

Prerequisites:

- `psql` installed on your machine.
- Run this only after step (c) and after the app passes the smoke checks in
  section 9.
- `schedules` come from the step (d) output. For example, the email queue is
  usually `5 seconds`, which needs pg_cron 1.5 or later.

Run it from a checkout of the repository. Use the database connection string
from Supabase → Project Settings → Database (use the **direct** or **session
pooler** string, not the transaction pooler). Avoid putting secrets on the
command line history:

```bash
$ read -rs DB_URL && export DB_URL          # paste the connection string, press Enter
$ read -rs CRON_SECRET && export CRON_SECRET   # paste CRON_SECRET from the app owner
$ psql "$DB_URL" -v ON_ERROR_STOP=1 \
    -v app_url=https://<APP_DOMAIN> \
    -v cron_secret="$CRON_SECRET" \
    -v sched_email_queue='5 seconds' \
    -v sched_membership='<SCHEDULE_FROM_STEP_D>' \
    -v sched_retention='<SCHEDULE_FROM_STEP_D>' \
    -v sched_workflows='<SCHEDULE_FROM_STEP_D>' \
    -f deploy/supabase/repoint-cron.sql
$ unset DB_URL CRON_SECRET
```

Replace `'5 seconds'` with the schedule of `process-email-queue` from step (d)
if it differs. Keep the quotes.

Notes:

- `app_url` has no trailing slash.
- The script is idempotent: running it again updates the Vault secret and
  replaces the four jobs.
- `ON_ERROR_STOP=1` plus `BEGIN`/`COMMIT` means a failure changes nothing.
- The script ends by printing `cron.job`. Send the output to the app owner (the
  `command` column is safe to send: it contains no secret).

Check it yourself:

```sql
select jobname, schedule from cron.job order by jobid;
```

Expected: `enforce-overdue-grace` plus the four new jobs (`process-email-queue`,
`membership-nightly`, `retention-nightly`, `scheduled-workflows`).

### (f) Clean up the old Lovable Vault secret

After the switch works (section 9), the old Lovable-era secret can go. List
the names first, then delete:

```sql
select id, name from vault.secrets order by name;
delete from vault.secrets where name = 'email_queue_service_role_key';
```

Deleting a secret cannot be undone. Only delete it once the queue has drained
on the new app.

---

## 7. Stripe

There are two separate webhook endpoints, and two separate sets of keys:

- **Platform billing** (the gym's subscription to Sthenos). Handled at
  `/api/public/payments/webhook?env=sandbox|live`. Uses `PAYMENTS_*_WEBHOOK_SECRET`
  and `STRIPE_SANDBOX_API_KEY` / `STRIPE_LIVE_API_KEY`. Previously this went
  through Lovable's Stripe connector.
- **Member dues** (gyms charge their own members through their own Stripe
  Connect accounts). Handled at `/api/public/stripe/connect-webhook`. Uses
  `STRIPE_WEBHOOK_SECRET` and `STRIPE_SECRET_KEY`.

### 7.1 Platform billing endpoints

**Before you start, confirm the keys match the data.** The platform price IDs
stored in the database must exist in the Stripe account the keys belong to. If
they do not, checkout fails. Check one live price ID from the database:

```bash
$ read -rs STRIPE_LIVE_API_KEY && export STRIPE_LIVE_API_KEY
$ curl -s https://api.stripe.com/v1/prices/<PRICE_ID_FROM_DB> -u "$STRIPE_LIVE_API_KEY:" | head -c 300; echo
$ unset STRIPE_LIVE_API_KEY
```

Expected: JSON with `"object": "price"`. An error such as `No such price` means
the key belongs to a different account, or to test mode while the price is live.
Fix the key before going on.

Create the endpoints in the Stripe Dashboard → **Developers** → **Webhooks**:

1. **Live mode** (toggle top right) → **Add endpoint**
   - Endpoint URL: `https://<APP_DOMAIN>/api/public/payments/webhook?env=live`
   - Events, select exactly these four:
     - `checkout.session.completed`
     - `customer.subscription.created`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
   - Create. Click **Reveal** on the signing secret (`whsec_…`) and put it in
     `PAYMENTS_LIVE_WEBHOOK_SECRET`.
2. **Test mode** → **Add endpoint**
   - Endpoint URL: `https://<APP_DOMAIN>/api/public/payments/webhook?env=sandbox`
   - The same four events.
   - Put its signing secret in `PAYMENTS_SANDBOX_WEBHOOK_SECRET`.

The platform endpoint ignores events that are not platform subscriptions
(`metadata.type = "platform"`). A signed event that the app ignores still returns
200.

### 7.2 Member dues (Connect) endpoint

1. Stripe Dashboard → **Developers** → **Webhooks** → **Add endpoint** (live mode).
2. Turn on **Listen to events on Connected accounts**. Member dues events come
   from the gyms' connected accounts, not the platform account.
3. Endpoint URL: `https://<APP_DOMAIN>/api/public/stripe/connect-webhook`
4. Events, select exactly these:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.paid`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
   - `account.updated`
   - `capability.updated`
   - `charge.refunded`
   - `charge.refund.updated`
   - `refund.updated`
   - `charge.dispute.created`
   - `charge.dispute.updated`
   - `charge.dispute.closed`
   - `payment_method.detached`
5. Create. Reveal the signing secret (`whsec_…`) and put it in
   `STRIPE_WEBHOOK_SECRET`.

Set `STRIPE_SECRET_KEY` to the **platform** account's secret key for the same
mode (live key in production).

### 7.3 Test the endpoints

Use the dashboard, not the Stripe CLI, for the production endpoints. `stripe listen`
signs with its own temporary secret, so a `stripe listen` test does not prove the
endpoint secret is right.

1. Open the endpoint in the dashboard → **Send test webhook** → choose
   `customer.subscription.updated` → **Send test webhook**.
2. Expected: the response is `200`. A `400 Invalid signature` means the signing
   secret in `.env` does not match this endpoint. Fix `.env`, then restart the
   app (`docker compose up -d`).
3. Check the logs: `docker compose logs --tail=50 app`. Expect no
   `Invalid signature` and no `handler error` lines.

---

## 8. Resend (platform email)

1. Resend dashboard → **Domains** → **Add domain**.
2. Name: `EMAIL_SENDING_DOMAIN`, default `notify.<APP_DOMAIN>`. If Resend offers
   an EU region, pick it. Note: Resend processes email in the US; see the
   follow-ups in section 12.
3. Resend shows DNS records. Copy them **exactly** into your DNS provider. Names
   and values differ per domain, so use the ones Resend shows you. There are
   usually three: one MX record, one SPF TXT record and one DKIM TXT record
   (`resend._domainkey…`). Add them as the Resend page lists them.
4. Back in Resend, click **Verify DNS records**. This can take a few minutes up
   to a few hours.
5. Once every record shows verified, set in `/opt/sthenos/.env`:

   ```
   EMAIL_SENDING_DOMAIN=notify.<APP_DOMAIN>
   EMAIL_SENDING_VERIFIED=true
   ```

   Then restart the app: `docker compose up -d` (section 9).
6. Create an API key with sending access and put it in `RESEND_API_KEY`.

Check DNS from your laptop:

```bash
$ dig +short TXT notify.<APP_DOMAIN>
$ dig +short MX notify.<APP_DOMAIN>
```

Expected: the records Resend listed. Empty output means DNS has not propagated
yet; wait before you verify.

---

## 9. First deploy and smoke checks

### 9.1 Deploy

Option A, through CI (preferred once everything is in place):

1. Set `RESEND_API_KEY` and the other server secrets in `/opt/sthenos/.env`
   first. The app starts without some of them, but emails and payments will not work.
2. Push or merge to `main`. The workflow runs tests, builds and pushes the image,
   then SSHes to the server and runs:

   ```bash
   cd /opt/sthenos
   export IMAGE_TAG=<sha> GHCR_OWNER=<owner-lowercase>
   docker compose pull app
   docker compose up -d --remove-orphans
   docker image prune -f
   ```

3. Set `DEPLOY_ENABLED=true` (section 5.4) only after this works manually.

Option B, manually on the server (use this first):

```bash
deploy@server:~$ cd /opt/sthenos
deploy@server:/opt/sthenos$ export IMAGE_TAG=<sha> GHCR_OWNER=<owner-lowercase>
deploy@server:/opt/sthenos$ docker compose pull app
deploy@server:/opt/sthenos$ docker compose up -d
deploy@server:/opt/sthenos$ docker compose ps
```

`<sha>` is the full 40-character commit SHA of a commit on `main` that the
image job built. Find it in the Actions run, or with `git rev-parse origin/main`
on your laptop. The package `ghcr.io/<owner-lowercase>/sthenos-app:<sha>` must
exist. If `docker compose pull` says `denied` or `not found`, see section 2.7
and check that the image job ran.

`docker compose up -d` also starts Caddy. The first start fetches the
certificate, which can take up to a minute. Watch it:

```bash
deploy@server:/opt/sthenos$ docker compose logs -f caddy
```

Expected: a line about obtaining a certificate for `<APP_DOMAIN>`, then
`certificate obtained successfully`. Stop with Ctrl+C.

### 9.2 Smoke checks

Run each one and check the output.

1. **Health**:

   ```bash
   $ curl -fsS https://<APP_DOMAIN>/api/public/health; echo
   ```

   Expected: `{"ok":true}`.

2. **Hooks reject calls without the token**. This is safe: no job runs.

   ```bash
   $ curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<APP_DOMAIN>/api/public/hooks/retention-nightly
   ```

   Expected: `401`.

3. **Email queue, with the token**. This drains the queue once, which is what it
   is for:

   ```bash
   $ curl -s -X POST https://<APP_DOMAIN>/api/public/hooks/email-queue \
       -H "Authorization: Bearer $CRON_SECRET"; echo
   ```

   Expected: JSON such as `{"processed":0}` or `{"skipped":true,"reason":"rate_limited"}`.
   `CRON_SECRET` must be exported in this shell, or replace it with the value.

4. **Sign-in**: open `https://<APP_DOMAIN>` in a browser, and sign in with an
   existing account (or Google, if enabled).

5. **Password reset email**: on the sign-in page, request a password reset for a
   test account. The email must arrive. If it does not, check
   `docker compose logs --tail=100 app` for `Auth email hook` errors. A
   `Server configuration error` means `SEND_EMAIL_HOOK_SECRET` or `SUPABASE_URL`
   is missing.

6. **Queue drains**: after a few minutes, check the logs for errors:

   ```bash
   deploy@server:/opt/sthenos$ docker compose logs --since=15m app | grep -i -E "error|fail" | tail -20
   ```

   Expected: no output, or only expected notices.

7. **Sensei**: as a gym staff member, ask one Sensei question. An answer means
   `ANTHROPIC_API_KEY` works. An error means the key or model name is wrong.

Checks 1 to 3 can run as soon as the containers are up. Checks 5 and 6 need the
Supabase owner to finish section 6 (c) and (e) first, because the auth emails
and the cron jobs only reach the new app after that switch. Run 1 to 3, hand
over to the Supabase owner, then run 4 to 7.

---

## 10. Rollback

Keep the SHA of the last known-good release. CI tags each image with the commit
SHA, and `:latest` moves with every release, so `:latest` is not a rollback target.

List the images on the server:

```bash
deploy@server:/opt/sthenos$ docker image ls ghcr.io/<owner-lowercase>/sthenos-app
```

Roll back:

```bash
deploy@server:/opt/sthenos$ export IMAGE_TAG=<previous-sha> GHCR_OWNER=<owner-lowercase>
deploy@server:/opt/sthenos$ docker compose pull app
deploy@server:/opt/sthenos$ docker compose up -d
```

The `pull` is needed if the old image was removed locally. Without it, Compose
can try to build from the `build:` section and fail, because the server has no
source code.

Rollback changes only the app. The database schema is owned by Supabase. If a
release changed the database, roll back that change in Supabase too.

If CI deploys are enabled, a rollback done by hand is overwritten by the next
push to `main`. Fix forward, or disable `DEPLOY_ENABLED` first.

---

## 11. Operations

| Task | Command (on the server, in `/opt/sthenos`) |
|------|---------------------------------------------|
| Status | `docker compose ps` |
| App logs (live) | `docker compose logs -f app` |
| Last 100 lines of app logs | `docker compose logs --tail=100 app` |
| Caddy logs | `docker compose logs --tail=100 caddy` |
| Restart the app | `docker compose restart app` |
| Apply a changed `.env` | `docker compose up -d` (restart alone does not reload `.env`) |
| Disk usage | `docker system df` |
| Remove unused images | `docker image prune -f` (CI already runs this) |

**Certificates.** Caddy renews the Let's Encrypt certificate on its own, before
it expires. Its state is in the `caddy_data` volume. Do not delete that volume:
Let's Encrypt limits how many certificates you can request.

**Backups.** Supabase owns the database, so its backups and point-in-time recovery
are configured in the Supabase project. The server is stateless apart from the
`caddy_data` volume, which only holds certificates. If the server is lost, make
a new one and redo sections 2 to 9. Keep the `.env` copy in your password manager,
because the server is the only place it lives.

**Updates.** Each push to `main` (with deploys enabled) updates the app. The
operating system updates itself through `unattended-upgrades`.

---

## 12. Known follow-ups before go-live

These are open items. Do not treat the site as launched until each is decided.

- **F1**: Cancellation emails call an endpoint that does not exist.
- **F2**: `npm audit` reports vulnerabilities in dependencies.
- **F3**: The email worker treats a database read error as an empty queue, so a
  failed read looks like "nothing to send".
- **F4**: Legal review of the privacy text. It names Hetzner, Supabase, Resend
  and Anthropic. Resend and Anthropic process data in the United States.
- **Turnstile**: set `TURNSTILE_SECRET_KEY` for the captcha on public forms.
  Without it the check is disabled.
- **www**: `deploy/Caddyfile` serves only `{$APP_DOMAIN}`, so a `www` record and
  `CANONICAL_HOST` do not work yet (section 3).
