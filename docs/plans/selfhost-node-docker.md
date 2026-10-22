# Feature: selfhost-node-docker
Status: IMPLEMENTING
Note (2026-10-22): /check-feasibility was skipped at the user's explicit request. T3 is where the riskiest
assumptions (Nitro entry, node-server preset) get tested first.

Move the Sthenos app off Lovable/Cloudflare and onto a self-hosted Node server in Docker
(Hetzner later). The work happens in a **new repo** at `/home/mivas/kapsaliscms/sthenos-app`,
created from the original at `/home/mivas/kapsaliscms/repo`. **The original repo is never
modified.** The project keeps using the hosted Supabase project that another person owns.
That person applies the dashboard changes listed in the runbook (T13).

## Decisions taken (from the user, 2026-10-22)
- D1: Option A. One full-stack TanStack Start app on a Node server, with no frontend/backend split and no Netlify.
- D2: Email provider is **Resend**.
- D3: The MCP server and the Lovable OAuth consent page are **dropped**.
- D4: Supabase stays hosted and is owned by a third party. This repo only reads keys from env vars. Every
  dashboard/SQL change is written down for the owner in `deploy/README.md`.
- D5: The production domain is not chosen yet and no server exists. Every domain is env-driven, and the
  deploy job is disabled until the repo variable `DEPLOY_ENABLED=true` is set.
- D6: The new repo starts with **fresh git history** (one import commit), built from `git archive HEAD`, so no
  past commit or untracked file such as `.env` is carried over.
- D7: AI moves from the Lovable gateway (Gemini) to the **Anthropic API** (`@anthropic-ai/sdk`, already a
  dependency). The model comes from env `ANTHROPIC_MODEL` (default `claude-opus-5-5`; amended at T8 per the claude-api skill: the default is the current Opus, and downgrading for cost is the user's call via `ANTHROPIC_MODEL`).

## Baseline (measured on the original repo, 2026-10-22)
- `npm test` → 12 pass / 0 fail.
- `node scripts/security-gate.mjs` → "Security gate passed (5 checks)".
- `node scripts/authorisation-gate.mjs` → "176 server functions checked, all guarded".
- `npx tsc --noEmit -p .` → exit 0.
- `npm run lint` → **7441 problems already** (almost all prettier). Lint is NOT a CI gate. The rule for this
  plan: every file this plan creates or edits must pass `npx eslint <file>` with 0 errors.
- CI (`.github/workflows/security-gate.yml`) runs security-gate, `npm test` and authorisation-gate.

## Requirements
- R1: The new repo exists at `/home/mivas/kapsaliscms/sthenos-app` with its own git history, holds every
  tracked file of the original at HEAD except `.lovable/`, and the original repo stays byte-identical (`git -C repo status` empty, HEAD unchanged).
- R2: No source or config file in the new repo references Lovable, or Cloudflare as a build/hosting target:
  `grep -rniE "lovable|wrangler|cloudflare" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=docs --exclude=package-lock.json . | grep -viE "turnstile|challenges\.cloudflare\.com"`
  returns nothing. (Amended during T3: `package-lock.json` legitimately lists `wrangler`/`@cloudflare/*` as optional peers of
  nitro → env-runner, and Cloudflare **Turnstile** (signup captcha in `rate-limit.server.ts`, `TurnstileWidget.tsx`) is a runtime service that stays.)
- R3: `npm run build` produces a Node server at `.output/server/index.mjs`. Running it with `node` serves the
  app's HTML on `/` and `{"ok":true}` on `GET /api/public/health`.
- R4: Platform Stripe billing (`stripe.server.ts`) talks to `https://api.stripe.com` directly with the real secret
  keys `STRIPE_SANDBOX_API_KEY` / `STRIPE_LIVE_API_KEY`, with no gateway and no `LOVABLE_API_KEY`.
- R5: All outgoing email (transactional sends and the pgmq queue worker) goes through one Resend adapter,
  `src/lib/email-provider.server.ts`. It keeps the existing behaviour for 429 (retry with Retry-After), 403
  (dead-letter queue) and "domain not verified", and sets `List-Unsubscribe` headers when an unsubscribe token is given.
  **Amendment (found in T5):** Lovable's API also appended exactly ONE visible footer to every send ("You received this email
  because of an action on <from display name>" + an Unsubscribe link built from the token). The app relies on that (see the
  "SINGLE FOOTER" comment in `email-send.server.ts`). Resend adds none, so the adapter appends that single footer (HTML + text)
  whenever `unsubscribeUrl` is given. The display name is HTML-escaped.
- R6: Supabase auth emails come from a **Supabase Send Email Hook** at `POST /api/public/hooks/auth-email`.
  The hook verifies the Standard Webhooks signature against `SEND_EMAIL_HOOK_SECRET`, renders the existing
  React Email templates and enqueues to `auth_emails` as today.
- R7: Cron/worker endpoints (`/api/public/hooks/{membership-nightly,retention-nightly,scheduled-workflows,email-queue}`)
  accept ONLY `Authorization: Bearer <CRON_SECRET>`, compared in constant time. The Supabase publishable/anon key (public)
  and the service-role key are no longer accepted.
- R8: The Sensei AI feature (`askSensei`) calls the Anthropic Messages API with `ANTHROPIC_API_KEY`. It keeps the
  return shape `{ reply: string | null, error: string | null }` and the existing GDPR anonymisation.
- R9: Google sign-in on `/login` uses `supabase.auth.signInWithOAuth({ provider: "google" })` directly, and the
  browser Supabase client stores its session in plain `localStorage`.
- R10: The MCP server, MCP tools, `/.well-known/oauth-protected-resource`, `/.lovable/oauth/consent` and
  `/lovable/email/auth/preview` are removed.
- R11: No hard-coded production domain is left outside the single fallback in `src/lib/site.ts`. Sender domain,
  root domain and the www→apex redirect come from env (`EMAIL_SENDING_DOMAIN`, `VITE_PUBLIC_SITE_URL`, `CANONICAL_HOST`).
- R12: A multi-stage `Dockerfile` builds a non-root runtime image. `docker-compose.yml` runs `app` + `caddy`,
  and Caddy handles HTTPS for `$APP_DOMAIN` and proxies to `app:3000`.
- R13: GitHub Actions: every push/PR to `main` runs every check (security-gate, test, authorisation-gate, typecheck,
  build). Pushes to `main` also build and push the image to GHCR. A deploy job SSHes to the server and runs
  `docker compose pull && up -d`, but only when the repo variable `DEPLOY_ENABLED == 'true'`.
- R14: `deploy/README.md` is a runbook covering the Hetzner setup, DNS, every env var, the Supabase-owner checklist,
  the Stripe dashboard webhooks and the Resend domain setup. The repo also gets a `CLAUDE.md` with its commands.

## Acceptance criteria
- AC1 (R1): `git -C /home/mivas/kapsaliscms/repo status --porcelain` is empty and `git -C repo rev-parse HEAD` = `1a342e3…`
  before and after. `git -C sthenos-app log --oneline | wc -l` = 1 after T1. `test ! -e sthenos-app/.lovable`.
- AC2 (R2): the grep from R2 prints nothing.
- AC3 (R3): after `npm run build`, `PORT=3000 node .output/server/index.mjs` (env from `.env.example` with dummy values)
  gives `curl -s localhost:3000/api/public/health` = `{"ok":true}` and `curl -s -o /dev/null -w '%{http_code}' localhost:3000/login` = `200`.
- AC4 (R4): `scripts/tests/stripe-client.test.mjs` proves `createStripeClient("sandbox")` sends its request to host
  `api.stripe.com` with `Authorization: Bearer <STRIPE_SANDBOX_API_KEY>`, and that it throws when the key is missing.
- AC5 (R5): `scripts/tests/email-provider.test.mjs` proves: a success returns the Resend id; HTTP 429 throws
  `EmailProviderError` with `status 429` and `retryAfterSeconds` from the header; 403 throws with `status 403`; the
  `List-Unsubscribe` header is set when `unsubscribeToken` is passed and absent otherwise; the API key never appears in thrown error messages.
- AC6 (R6): `scripts/tests/auth-email-hook.test.mjs` proves: a correctly signed Supabase payload is accepted and mapped
  (`recovery` → `confirmationUrl` = `<SUPABASE_URL>/auth/v1/verify?token=<token_hash>&type=recovery&redirect_to=<redirect_to>`);
  a bad signature is rejected; a timestamp older than 5 minutes is rejected; an unknown `email_action_type` is rejected.
- AC7 (R7): `scripts/tests/cron-auth.test.mjs` proves the correct secret is accepted, while the publishable key, the service-role key,
  an empty header and a missing `CRON_SECRET` env are all rejected. It must FAIL against the original `authorizeCron`
  (see the test-first note in T7).
- AC8 (R8): `scripts/tests/sensei-llm.test.mjs` proves the request to a fake Anthropic client carries `system`, `model`
  from env, `max_tokens`, and messages that start with a `user` role; a 429 maps to "Rate limit hit. Try again in a moment.";
  an empty reply maps to "Empty response from AI.".
- AC9 (R9, R10): `grep -rn "integrations/lovable\|previewAuthStorage\|mcp" src` prints nothing.
- AC10 (R11): `grep -rn "sthenos\.live" src --include=*.ts --include=*.tsx | grep -v email-templates` prints exactly three
  lines: `src/lib/site.ts` CANONICAL_ORIGIN, plus the doc comment (line ~12) and the `PLACEHOLDER_ADDRESSES` entry in `src/lib/email-send.server.ts`.
- AC11 (R12): `docker build -t sthenos-app:local .` succeeds; `docker run --rm sthenos-app:local id -u` ≠ `0`;
  `APP_DOMAIN=localhost docker compose up -d` and then `curl -sk https://localhost/api/public/health` = `{"ok":true}`.
- AC12 (R13): `.github/workflows/ci.yml` exists; `npx --yes @action-validator/cli .github/workflows/ci.yml` exits 0;
  the deploy job has `if: vars.DEPLOY_ENABLED == 'true' && github.ref == 'refs/heads/main'`.
- AC13 (R14): `deploy/README.md` contains every env var listed in `.env.example` (checked by
  `scripts/tests/env-docs.test.mjs`) and the sections listed in T13.
- AC14 (all): final run in a clean checkout (`git worktree add`) of the final commit: `npm ci`, security-gate,
  `npm test`, authorisation-gate, `npx tsc --noEmit`, `npm run build` all pass, with output pasted.

## Design

### Runtime
- Build stack: `@tanstack/react-start` (1.168) + `nitro` 3 beta (already a dependency), using `nitro/vite` with
  `preset: "node-server"`. Output goes to `.output/` (server at `.output/server/index.mjs`, which listens on `PORT`, default 3000).
- The `@lovable.dev/vite-tanstack-config` wrapper is replaced by an explicit `vite.config.ts` that lists the plugins the
  wrapper's comment says it provided: `tanstackStart({ server: { entry: "server" } })`, `nitro({ preset: "node-server" })`,
  `viteReact()`, `tailwindcss()`, `tsConfigPaths()`. Also kept: the existing `entities` aliases and `resolve.dedupe: ["react","react-dom"]`.
- `src/server.ts` keeps its default export `{ fetch(request) }` (Nitro's TanStack Start integration calls it). The Cloudflare
  `env`/`ctx` parameters become optional and unused.
- `VITE_*` vars are inlined **at build time**, so they become Docker build args (`VITE_SUPABASE_URL`,
  `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID`, `VITE_PUBLIC_SITE_URL`). Server-only secrets are read from
  `process.env` at runtime and never baked in.

### Request flow in production
`Browser → Caddy :443 (TLS, Let's Encrypt) → app:3000 (Node) → Supabase (hosted) / Stripe / Resend / Anthropic`.
`Supabase pg_cron → https://<domain>/api/public/hooks/* (Bearer CRON_SECRET)`.
`Supabase Auth → https://<domain>/api/public/hooks/auth-email (Standard Webhooks signature)`.
`Stripe → /api/public/payments/webhook?env=sandbox|live` and `/api/public/stripe/connect-webhook`.

### Route changes
| Old | New |
|---|---|
| `src/routes/lovable/email/auth/webhook.ts` | `src/routes/api/public/hooks/auth-email.ts` |
| `src/routes/lovable/email/queue/process.ts` | `src/routes/api/public/hooks/email-queue.ts` |
| `src/routes/lovable/email/auth/preview.ts` | deleted |
| `src/routes/mcp.ts`, `src/routes/[.mcp]/`, `src/routes/[.well-known]/oauth-protected-resource.ts`, `src/routes/[.]lovable.oauth.consent.tsx`, `src/lib/mcp/` | deleted |
| — | `src/routes/api/public/health.ts` (`GET` → `{"ok":true}`) |

`src/start.ts` and `src/server.ts` currently skip their error wrapping/redirect for paths starting with `/lovable/`.
That prefix becomes `/api/public/hooks/`.

### New modules (alias-free on purpose, so `node --test --experimental-strip-types` can import them directly; same pattern as the existing `platform-fee.test.mjs`)
- `src/lib/cron-auth.server.ts`: `authorizeCron(request: Request, env = process.env): boolean`. Uses `node:crypto` `timingSafeEqual` on equal-length buffers.
- `src/lib/email-provider.server.ts`: `sendEmail(input, opts?)` → `{ messageId }`; `class EmailProviderError extends Error { status: number | null; retryAfterSeconds: number | null }`. Calls `POST https://api.resend.com/emails` with `fetch` (no `resend` SDK, so tests can stub `globalThis.fetch`). Body: `from, to, subject, html, text, reply_to?, headers?, tags: [{name:"label",value}, {name:"purpose",value}]`. Header `Idempotency-Key` when given. Error messages never contain the API key.
- `src/lib/auth-email-hook.ts`: `verifyAndParseHook(rawBody, headers, secret, now?)` → `{ webhookId, emailType, email, newEmail?, templateProps }`. Implements Standard Webhooks verification itself (HMAC-SHA256 over `${id}.${timestamp}.${body}`, base64 secret after stripping the `v1,whsec_` prefix, ±300 s tolerance, any of the space-separated `v1,<sig>` values may match) so no new dependency is needed.
- `src/lib/sensei-llm.server.ts`: `callSensei({ client, model, system, messages })` → `{ reply, error }`. `client` is an `Anthropic`-shaped object (`messages.create`), injected so tests can pass a fake.

### Env vars (complete list; `.env.example` is rewritten to exactly this)
Build-time: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID`, `VITE_PUBLIC_SITE_URL`.
Runtime: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_SANDBOX_API_KEY`, `STRIPE_LIVE_API_KEY`, `PAYMENTS_SANDBOX_WEBHOOK_SECRET`, `PAYMENTS_LIVE_WEBHOOK_SECRET`,
`RESEND_API_KEY`, `EMAIL_SENDING_DOMAIN`, `EMAIL_SENDING_LOCAL_PART`, `EMAIL_SENDING_VERIFIED`, `SEND_EMAIL_HOOK_SECRET`,
`CRON_SECRET`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `APP_URL`, `CANONICAL_HOST`, `PORT`, `NODE_ENV`.
Compose-only: `APP_DOMAIN`, `IMAGE_TAG`, `GHCR_OWNER`.
Removed: `LOVABLE_API_KEY`, `LOVABLE_SEND_URL`, `SUPABASE_ANON_KEY` (only used by the old `authorizeCron`).

### Migrations
None. The schema is unchanged. The cron jobs that call the app are not in the migrations (Lovable created them at runtime).
The owner repoints them with `deploy/supabase/repoint-cron.sql` (T13), which is **not** a migration because it contains a
URL and a secret. It reads both from psql variables, so the file itself holds no secret.

## Task breakdown
Commands for every task are run from `/home/mivas/kapsaliscms/sthenos-app` unless stated otherwise.
"Checks" = `node scripts/security-gate.mjs && npm test && node scripts/authorisation-gate.mjs && npx tsc --noEmit -p .`
plus `npx eslint <every file touched in the task>`. From T3 on, also run `npm run build`. Paste the output of each.

- **T1 (R1): create the new repo.**
  1. Record `git -C /home/mivas/kapsaliscms/repo rev-parse HEAD` and `git -C … status --porcelain`.
  2. `git -C /home/mivas/kapsaliscms/repo archive HEAD | tar -x -C /home/mivas/kapsaliscms/sthenos-app`. The `docs/plans/` file
     already in the target is preserved because archive has no `docs/` dir. Check with `git -C repo ls-files docs | wc -l` = 0 first;
     if it is not 0, stop and update this plan.
  3. `rm -rf .lovable .env`, then `git init -b main`.
     **Amendment (2026-10-22, found during T1):** `.env` is TRACKED in the original (commits ebdf5e0, a3929c4). It holds only
     public values (Supabase URL, project id, publishable key). Per D6 it is deleted and never committed here, so R1 now reads
     "every tracked file except `.lovable/` and `.env`".
     **Amendment:** the original `package-lock.json` is out of sync with `package.json` (no `nitro` entry; Lovable's real lock is
     `bun.lock`), so `npm ci` fails with ERESOLVE (it resolves `@tanstack/react-start@1.169.3`, which has peerOptional `vite>=8`, against `vite ^7`).
     Fix: change `package.json` `"@tanstack/react-start": "^1.167.50"` → `"~1.168.10"` (the version the original's working node_modules
     runs), then `npm install` (no `--force`/`--legacy-peer-deps`) to regenerate `package-lock.json`, then `npm ci` must succeed.
     **Refinement (verified in a scratch dir):** that alone still fails `npm ci`, because `@hookform/resolvers@5.9.2` declares ~25 optional
     peers (ajv, ajv-formats…) and npm's install/ci disagree on them. So also pin `"@hookform/resolvers": "~5.2.2"` (the version in Lovable's
     `bun.lock`, with only the `react-hook-form` peer). Generate the lock with **npm 10** (`npx -y npm@10.9.4 install`), which is what
     Node 22 in CI/Docker ships. Verified: `npm ci` then passes with both npm 10.9.4 and npm 11.6.1.
     Commit this as a second commit, "Sync package-lock with package.json", so the import commit stays verbatim.
     AC1 therefore becomes "log has 2 commits after T1".
     **Amendment:** a branch-guard hook forbids edits on `main`, so work happens on `feature/selfhost-node-docker` (created before the
     first commit). After the import commit, `git branch main <import-sha>` creates `main` at the verbatim import.
  4. Run the Checks (baseline must match the Baseline section; build is not yet expected to be Node).
  5. Commit "Import from Lovable repo @<sha>".
  Done when AC1 holds and the Checks output is pasted.

- **T2 (R10): delete the MCP server and Lovable preview/consent routes.**
  Delete `src/routes/mcp.ts`, `src/routes/[.mcp]/`, `src/routes/[.well-known]/oauth-protected-resource.ts`,
  `src/routes/[.]lovable.oauth.consent.tsx`, `src/routes/lovable/email/auth/preview.ts`, `src/lib/mcp/`.
  Remove `mcpPlugin` from `vite.config.ts`, uninstall `@lovable.dev/mcp-js`. Check `src/routes/llms[.]txt.ts`, `robots[.]txt.ts`
  and `sitemap[.]xml.ts` for links to `/mcp` and remove them. `routeTree.gen.ts` is regenerated by the router plugin. Run
  `npx vite build` once so it regenerates, then commit the regenerated file.
  Test: AC9's grep for `mcp`, plus Checks.

- **T3 (R3, R2): switch the build to Node and drop the Lovable/Cloudflare build config.**
  Rewrite `vite.config.ts` as described in Design → Runtime. Delete `wrangler.jsonc`. Uninstall
  `@lovable.dev/vite-tanstack-config` and `@cloudflare/vite-plugin`. The plugins the new config imports (`@vitejs/plugin-react`,
  `@tailwindcss/vite`, `vite-tsconfig-paths`, `@tanstack/react-start`, `nitro`) are already in package.json, so add nothing.
  Remove `.gitignore` lines for `.wrangler/` and `.dev.vars`. Delete `bun.lock` and `bunfig.toml` (npm + `package-lock.json` is the only package manager).
  Make `src/server.ts`'s `fetch(request, env?, ctx?)` params optional. Add `src/routes/api/public/health.ts`.
  Add `"start": "node .output/server/index.mjs"` to package.json scripts.
  If Nitro does not pick up `src/server.ts` as the entry, read `node_modules/@tanstack/react-start` docs for the Nitro
  integration and record the actual mechanism in this plan before changing anything else.
  Test: AC3 (commands and curl output pasted), plus Checks.

- **T4 (R4): direct Stripe client.**
  In `src/lib/stripe.server.ts`, `createStripeClient(env)` becomes
  `new Stripe(getConnectionApiKey(env), { apiVersion: "2026-03-25.dahlia" as any, httpClient: Stripe.createFetchHttpClient() })`.
  It keeps a fetch-based transport like before, which also lets the test stub `fetch`.
  Delete `GATEWAY_STRIPE_BASE` and the `Lovable-API-Key`/`X-Connection-Api-Key` header code, and update the doc comment (it currently says never to use the key directly).
  Leave `getStripeEnv`, `verifyStripeWebhook` and every caller unchanged.
  New test `scripts/tests/stripe-client.test.mjs`: stub `globalThis.fetch` to record the request and return `{"object":"list","data":[]}`,
  call `stripe.customers.list({limit:1})`, and assert the URL host is `api.stripe.com` and the auth header is `Bearer <key>`; also test the missing-key throw.
  Show the test FAILING on the T3 commit first (gateway host) and passing after.

- **T5 (R5): Resend adapter.**
  **Amendment:** do NOT uninstall `@lovable.dev/email-js` in T5, because `src/routes/lovable/email/auth/webhook.ts` still imports
  `parseEmailWebhookPayload` from it. T6 removes that import and uninstalls the package.
  Create `src/lib/email-provider.server.ts` (Design). Replace `sendLovableEmail` in `src/lib/email-send.server.ts` (around line 645) and in
  the queue worker with `sendEmail`. Map: `to, from, subject, html, text, replyTo, idempotencyKey, unsubscribeToken`,
  plus `tags` from `label`/`purpose`. When `unsubscribeToken` is set, set headers `List-Unsubscribe: <${PUBLIC_SITE_URL}/unsubscribe?token=${token}>`
  and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Check that `src/routes/unsubscribe.tsx` reads `token` from the query
  string; if it uses another param name, use that one. Keep `isDomainNotVerified()` and extend its match to Resend's 403 message
  ("domain is not verified"). Replace `apiKey()` with `process.env.RESEND_API_KEY`. Uninstall `@lovable.dev/email-js`.
  Test: AC5 via `scripts/tests/email-provider.test.mjs`, plus Checks.

- **T6 (R6, R11): Supabase Send Email Hook.**
  Create `src/lib/auth-email-hook.ts` (Design). Move `src/routes/lovable/email/auth/webhook.ts` to `src/routes/api/public/hooks/auth-email.ts`, with
  route id `/api/public/hooks/auth-email`. Replace `verifyWebhookRequest`/`parseEmailWebhookPayload` with `verifyAndParseHook`.
  The Supabase payload is `{ user: { email, new_email? }, email_data: { token, token_hash, redirect_to, email_action_type, site_url, token_new, token_hash_new } }`.
  Map it as follows:
  `confirmationUrl = ${SUPABASE_URL}/auth/v1/verify?token=${token_hash}&type=${email_action_type}&redirect_to=${encodeURIComponent(redirect_to)}`;
  `token` → `token`; `email` → `user.email`; `newEmail` → `user.new_email`; `run_id` → the `webhook-id` header.
  Accepted `email_action_type` values: `signup, invite, magiclink, recovery, email_change, reauthentication`. Anything else → 400.
  For `email_change`, send ONE email to `user.new_email` using `token_hash_new` when it is present; otherwise use `token_hash`.
  Record this choice in the edge-cases section; it matches Supabase's default when "secure email change" is off.
  Respond `200 {}` on success (Supabase requires a 2xx within 5 s; the route only enqueues). Constants `SENDER_DOMAIN/ROOT_DOMAIN/FROM_DOMAIN`
  come from `SENDING_DOMAIN` (import from `email-send.server.ts`) and `PUBLIC_SITE_URL`.
  Uninstall `@lovable.dev/webhooks-js`.
  Test: AC6 via `scripts/tests/auth-email-hook.test.mjs`, which builds signed payloads with `node:crypto`, plus Checks.

- **T7 (R7): cron secret.**
  Test first:
  (a) Move the current `authorizeCron` body from `src/lib/scheduler.server.ts` verbatim into the new alias-free file `src/lib/cron-auth.server.ts`,
      and re-export it from `scheduler.server.ts` (`export { authorizeCron } from "./cron-auth.server"`).
  (b) Write `scripts/tests/cron-auth.test.mjs` importing `../../src/lib/cron-auth.server.ts`, run it, and paste the FAILURE (the publishable key is accepted).
  (c) Rewrite `cron-auth.server.ts` per Design, run it again, and paste the pass.
  Move `src/routes/lovable/email/queue/process.ts` to `src/routes/api/public/hooks/email-queue.ts` and replace its service-role bearer check
  (around line 79) with `authorizeCron`. Change the `/lovable/` prefix checks in `src/start.ts` and `src/server.ts` to `/api/public/hooks/`.
  Test: AC7, plus Checks.

- **T8 (R8): Anthropic for Sensei.**
  Before writing code, load the `claude-api` skill and confirm the model id and the `messages.create` params.
  Create `src/lib/sensei-llm.server.ts` (Design). In `src/lib/sensei.functions.ts` around lines 600–710, replace the `LOVABLE_API_KEY` check with `ANTHROPIC_API_KEY`
  ("AI is not configured." when missing) and the fetch with `callSensei({ client: new Anthropic(), model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5", system, messages })`.
  Drop leading `assistant` messages so the first message is `user`. Use `max_tokens: 16000` (amended: thinking is always on for Opus 5.5,
  and 1024 risks truncation). The reply is the joined `text` blocks; thinking blocks are ignored. Use `client.beta.messages.create` with
  `betas: ["server-side-fallback-2026-06-01"], fallbacks: [{ model: "claude-opus-4-8" }]` (refusal fallback, array form; the installed SDK 0.106 types only the array form, and its header must be the 2026-06-01 one). `stop_reason === "refusal"`
  → "Sensei can't answer that one." Do not send `thinking`, `temperature` or a prefill.
  Error mapping: `Anthropic.RateLimitError` → "Rate limit hit. Try again in a moment."; any other API error → `AI error (<status>).`;
  thrown network error → "Sensei is unavailable right now.". Remove the "AI credits exhausted…Settings → Workspace" Lovable message.
  Do NOT touch the anonymisation (`ai-aggregate`, `tokeniseNames`) code.
  Test: AC8 via `scripts/tests/sensei-llm.test.mjs` (fake client), plus Checks.

- **T9 (R9, R2): Google sign-in and session storage.**
  In `src/routes/login.tsx` (around line 123), replace `lovable.auth.signInWithOAuth("google", { redirect_uri })` with
  `supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: <same redirect target the old code built> } })`.
  Keep the existing error handling and toast text. Delete `src/integrations/lovable/`. In `src/integrations/supabase/client.ts` replace
  `brokeredPreviewStorage()` with `typeof window !== "undefined" ? window.localStorage : undefined`, and delete `previewAuthStorage.ts`.
  Uninstall `@lovable.dev/cloud-auth-js`.
  Test: AC9 grep, plus Checks, plus a manual check: build, run with real `VITE_SUPABASE_*`, open `/login`, click Google, and confirm the browser
  is redirected to `<SUPABASE_URL>/auth/v1/authorize?provider=google…`. Paste the URL. If the keys are not available yet, mark this
  sub-step PENDING-KEYS in this plan instead of claiming it.

- **T10 (R2, R11): sweep for leftover Lovable references and hard-coded domains.**
  Run the R2 grep and the AC10 grep. Fix each hit:
  - "Connect Supabase in Lovable Cloud" → "Set it in the environment" in `src/integrations/supabase/*`.
  - `server.ts` www redirect: only active when `process.env.CANONICAL_HOST` is set; it redirects `www.${CANONICAL_HOST}` → `CANONICAL_HOST`.
  - `src/lib/email-send.server.ts` `normaliseDomain` fallback `"notify.sthenos.live"` → `` `notify.${new URL(PUBLIC_SITE_URL).hostname}` ``
    (`PUBLIC_SITE_URL` is already imported there).
  - Rename `package.json` `"name"` to `"sthenos-app"`.
  - Rewrite `.env.example` to the Design env list, with a one-line comment each.
  Test: AC2 and AC10 output pasted, plus Checks.

- **T11 (R12): Docker and Caddy.**
  `Dockerfile`:
  - Stage `build` (`node:22-bookworm-slim`): `ARG` for each build-time VITE_ var, `npm ci`, `npm run build`.
  - Stage `runtime` (`node:22-bookworm-slim`): `ENV NODE_ENV=production PORT=3000`, `COPY --from=build /app/.output ./.output`, `USER node`,
    `EXPOSE 3000`, `HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:3000/api/public/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`,
    `CMD ["node", ".output/server/index.mjs"]`.
  `.dockerignore`: `node_modules`, `.output`, `.git`, `.env*` (keep `!.env.example`), `e2e`, `docs`.
  `docker-compose.yml`:
  - `app`: `image: ghcr.io/${GHCR_OWNER}/sthenos-app:${IMAGE_TAG:-latest}`, `build: .`, `env_file: .env`, `restart: unless-stopped`, no `ports`.
  - `caddy`: `caddy:2.10`, ports `80:80`, `443:443`, `443:443/udp`, mounts `./deploy/Caddyfile:/etc/caddy/Caddyfile:ro` and volumes `caddy_data`, `caddy_config`, env `APP_DOMAIN`.
  `deploy/Caddyfile`: `{$APP_DOMAIN} { encode zstd gzip; reverse_proxy app:3000 }`.
  Test: AC11 with every command's output pasted (use a `.env` filled with dummy values, then delete it; never commit it).

- **T12 (R13): CI/CD.**
  Replace `.github/workflows/security-gate.yml` with `.github/workflows/ci.yml`, keeping the three existing jobs unchanged and adding:
  - `typecheck` (`npm ci && npx tsc --noEmit -p .`);
  - `build` (`npm ci && npm run build`, with dummy VITE_ values);
  - `image` (needs all checks; only on `push` to `main`): `docker/login-action` to GHCR with `GITHUB_TOKEN`, then `docker/build-push-action` with
    build-args from repo **variables** `vars.VITE_*`, tags `ghcr.io/${{ github.repository_owner }}/sthenos-app:${{ github.sha }}` and `:latest`;
    `permissions: packages: write`;
  - `deploy` (needs `image`; `if: vars.DEPLOY_ENABLED == 'true' && github.ref == 'refs/heads/main'`): `appleboy/ssh-action` pinned to a full
    commit SHA, using secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, running
    `cd /opt/sthenos && IMAGE_TAG=${{ github.sha }} docker compose pull app && IMAGE_TAG=${{ github.sha }} docker compose up -d`.
  Pin every action to a full commit SHA.
  Test: AC12 (validator output pasted).

- **T13 (R14): runbook, owner checklist, CLAUDE.md.**
  `deploy/README.md` sections:
  1. Server: Hetzner CX22 (or larger) Ubuntu 24.04, SSH key only, `deploy` user in the `docker` group, Hetzner Cloud Firewall allowing 22/80/443,
     `unattended-upgrades`, Docker Engine + compose plugin, `/opt/sthenos` holding `docker-compose.yml`, `deploy/Caddyfile` and `.env` (chmod 600).
  2. DNS: A/AAAA for `APP_DOMAIN` (and `www`) → server IP.
  3. Env vars: a table with every var from the Design list, where to get it, and build-time or runtime.
  4. Supabase owner checklist: Auth → URL Configuration (Site URL + redirect URLs for the new domain); Auth → Providers → Google (needs a Google
     Cloud OAuth client with redirect `<SUPABASE_URL>/auth/v1/callback`); Auth → Hooks → Send Email hook = HTTPS
     `https://<domain>/api/public/hooks/auth-email`, then copy the generated secret into `SEND_EMAIL_HOOK_SECRET` and disable the old Lovable hook;
     run `select jobid, jobname, schedule, command from cron.job;` and send the output to the app owner; run `deploy/supabase/repoint-cron.sql`.
  5. `deploy/supabase/repoint-cron.sql`: reads `:app_url` and `:cron_secret` psql variables, upserts the vault secret `app_cron_secret`, and for each of
     `process-email-queue`, `membership-nightly`, `retention-nightly`, `scheduled-workflows` runs `cron.unschedule` (if present) and then `cron.schedule`
     with `net.http_post(url := :'app_url' || '/api/public/hooks/<name>', headers := jsonb_build_object('Authorization','Bearer '|| (select decrypted_secret from vault.decrypted_secrets where name='app_cron_secret'), 'Content-Type','application/json'))`.
     Schedules: copy them from the owner's `cron.job` output. Until that output arrives, the file states the schedules as the psql variables
     `:sched_email_queue`, `:sched_membership`, `:sched_retention`, `:sched_workflows` with no defaults, so the owner cannot run it with guessed times. `process-email-queue` keeps its rate-limit/queue-non-empty guard: copy its existing
     `command` body and change only the URL and auth header.
  6. Stripe: the endpoints `…/api/public/payments/webhook?env=live` (and `?env=sandbox` in test mode) → `PAYMENTS_*_WEBHOOK_SECRET`;
     `…/api/public/stripe/connect-webhook` → `STRIPE_WEBHOOK_SECRET`. Confirm `STRIPE_*_API_KEY` belong to the same Stripe account that holds the
     platform price ids stored in the DB (these were previously reached through Lovable's connector).
  7. Resend: add the domain `EMAIL_SENDING_DOMAIN`, publish its DNS records, and set `EMAIL_SENDING_VERIFIED=true` once verified.
  8. First deploy and rollback: `IMAGE_TAG=<previous sha> docker compose up -d`.
  `CLAUDE.md`: commands (`npm ci`, `npm run dev`, `npm test`, the two gate scripts, `npx tsc --noEmit -p .`, `npm run build`, `npm start`,
  `docker compose up`), the lint baseline note, and "no migrations are generated here; the schema is owned by the Supabase project".
  Test: AC13 via `scripts/tests/env-docs.test.mjs`, which parses `.env.example` var names and asserts each appears in `deploy/README.md`.

- **T14 (all): final verification.** `git worktree add ../sthenos-verify HEAD`, then `npm ci` and every command in AC14 there, plus AC2/AC9/AC10
  greps and AC1 against the original repo. Paste all output. Remove the worktree afterwards.

## Edge cases & unhappy paths
- Missing env at runtime: every adapter throws or returns its existing "not configured" error with the var NAME only, never a value.
  The health route does not depend on any secret, so the container stays healthy and the logs show the misconfiguration.
- `CRON_SECRET` unset → every hook returns 401 (fail closed). Tested in AC7.
- `CRON_SECRET` length differs from the provided token → rejected without calling `timingSafeEqual` (which would throw).
- Auth hook: bad signature → 401; stale timestamp (>300 s) → 401; unknown action → 400; missing `webhook-id` → 400; enqueue RPC error →
  500 (Supabase then shows the user an error rather than silently sending nothing).
- `email_change` with secure email change ON: only the new address gets an email (decision in T6). If the owner has secure email
  change enabled, the old address is not notified. This is documented in the runbook as a known limitation.
- Resend 429 → `EmailProviderError.retryAfterSeconds` drives the existing queue cooldown. 403 → dead-letter queue (existing logic).
  Resend 5xx → existing retry budget.
- Resend/Stripe/Anthropic errors must never include API keys or URL-embedded secrets in logs or `email_send_log` rows (global learned rule).
  AC5 asserts this for the email adapter.
- Sensei history starting with an assistant turn → leading assistant turns are dropped. If nothing is left → "Empty response from AI."
  without calling the API.
- `www.` requests when `CANONICAL_HOST` is unset → served as-is, with no redirect loop.
- The build without `VITE_*` args still succeeds, but the browser cannot reach Supabase. CI passes dummy values and the runbook says the real ones are mandatory.
- The deploy job with `DEPLOY_ENABLED` unset → skipped, not failed.

## Out of scope
- Provisioning the Hetzner server, buying or choosing the domain, and creating GHCR/GitHub repo settings (the runbook documents them; the user does them).
- Applying any Supabase dashboard/SQL change or obtaining keys (Supabase owner / user).
- Splitting frontend and backend, Netlify, and self-hosting Supabase.
- Re-implementing MCP.
- Fixing the 7441 pre-existing lint problems.
- Migrating Stripe data or price ids between accounts.
- Changing the schema or migrations.

## Progress
- [x] T1 — new repo at sthenos-app (commits 42df455 import, 192389c lock sync; `.env` excluded; pins `@hookform/resolvers ~5.2.2`, `@tanstack/react-start ~1.168.10`) — verified by controller: `npm ci` exit 0, security-gate pass, `npm test` 12/12, authorisation-gate 176 guarded, `tsc` exit 0, original repo clean at 1a342e3.
- [x] T2 — deleted src/routes/{mcp.ts,[.mcp]/,[.well-known]/oauth-protected-resource.ts,[.]lovable.oauth.consent.tsx,lovable/email/auth/preview.ts}, src/lib/mcp/; vite.config.ts; package.json/lock; routeTree.gen.ts (commit 9e7458e) — verified by controller: npm ci 0, security-gate pass, npm test 12/12, authz 176 guarded, tsc 0, eslint vite.config.ts 0, AC9 `mcp` grep empty.
- [x] T3 — vite.config.ts (plain Vite + nitro node-server; react/react-query dedupe), src/server.ts (optional env/ctx), src/routes/api/public/health.ts, package.json `start`, removed wrangler.jsonc/bun.lock/bunfig.toml/.gitignore wrangler lines (commits dc12c7a, 79667dc) — verified by controller: clean `npm ci` + `npm run build` exit 0, `.output/nitro.json` preset node-server, `node .output/server/index.mjs` → health `{"ok":true}`, `/` 200, `/login` 200 (after router's 307 search-param normalisation), `/mcp` 404; security-gate pass, test 12/12, authz 176, tsc 0, eslint on new/rewritten files 0. Known: src/server.ts has 3 pre-existing prettier errors (lines 15, 82, 99) → fix in T10.
- [x] T4 — src/lib/stripe.server.ts (direct `new Stripe(key, {httpClient: createFetchHttpClient()})`, gateway removed), scripts/tests/stripe-client.test.mjs (2 tests) — verified by controller: test fails on pre-change code with LOVABLE_API_KEY set (`actual: 'connector-gateway.lovable.dev', expected: 'api.stripe.com'`), passes after; npm test 14/14, tsc 0, security-gate pass, authz 176. Pre-existing lint in stripe.server.ts (`as any` apiVersion, prettier line 24) left as is.
- [x] T5 — src/lib/email-provider.server.ts (Resend adapter + single unsubscribe footer), src/lib/email-send.server.ts, src/routes/lovable/email/queue/process.ts, scripts/tests/email-provider.test.mjs (18 tests) (commit ec9f44e) — tests written first (module-not-found, then 4 footer tests red before the footer existed); verified by controller: npm ci 0, npm test 32/32, tsc 0, build 0, security-gate pass, authz 176, eslint on new files 0. `@lovable.dev/email-js` kept until T6 (auth webhook import).
- [x] T6 — src/lib/auth-email-hook.ts (Standard Webhooks verify + Supabase payload mapping), src/routes/api/public/hooks/auth-email.ts (moved from lovable/email/auth/webhook.ts), src/start.ts + src/server.ts (hook prefix), uninstalled @lovable.dev/email-js + webhooks-js, scripts/tests/auth-email-hook.test.mjs (9 tests a–i) (commit 1ad64a8) — red first (module missing); verified by controller: npm ci 0, build 0, npm test 41/41, tsc 0, security-gate pass, authz 176, eslint new files 0. Agent smoke test: unsigned → 400, bad signature → 401. Route also requires SUPABASE_URL (500 if missing).
- [x] T7 — src/lib/cron-auth.server.ts (CRON_SECRET only, ≥16 chars, timingSafeEqual), scheduler.server.ts re-export, src/routes/api/public/hooks/email-queue.ts (moved from lovable/email/queue/process.ts; authorizeCron), start.ts/server.ts prefix, scripts/tests/cron-auth.test.mjs (12 tests) (commit c7a7c94) — red first against the verbatim old body (5 fail: publishable/anon/service-role accepted, secret rejected); verified by controller: npm ci 0, build 0, npm test 53/53, tsc 0, security-gate pass, authz 176. Agent smoke test: publishable → 401, service-role → 401, no auth → 401, correct secret → passes auth.

## Follow-ups found during implementation (out of scope; not fixed here)
- F1 (pre-existing bug): `src/routes/cancellations.tsx:68` and `src/routes/profile.tsx:276` POST to `/lovable/email/transactional/send`. No such route ever existed in the original repo's history, and the templates it names (`cancellation-requested/-confirmed/-dismissed`) don't exist either, so these member emails already fail silently in production (404 swallowed by `catch {}`). Fix it as its own feature, using `sendEmail` from a guarded server function.
- F2: `npm audit` reports ~26–31 vulnerabilities (6 critical) in the dependency tree. Triage before production.
- F3: the email-queue worker ignores the error from its `email_send_state` read, so an unreachable DB looks like an empty queue (200). Pre-existing.
- T10 must also handle these R2 hits found in T7's grep: the `lovable.app` pattern in the redirect allowlist in `src/lib/password-reset.server.ts:9`, and the og:image/twitter:image URLs in `src/routes/__root.tsx:95-96`, which point at a Lovable preview screenshot.

- [x] T8 — src/lib/sensei-llm.server.ts (Anthropic beta.messages.create, default model claude-opus-5-5, max_tokens 16000, refusal fallback array form → claude-opus-4-8 with beta server-side-fallback-2026-06-01, typed error mapping), src/lib/sensei.functions.ts wiring, scripts/tests/sensei-llm.test.mjs (10 tests) (commit 73ed044) — red first (module missing); verified by controller: npm ci 0, npm test 63/63, tsc 0, build 0, security-gate pass, authz 176 (askSensei still guarded), eslint new files 0. Not verified against the live API (no key); first real call should be checked after deploy.
