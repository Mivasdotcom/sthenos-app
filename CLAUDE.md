# Sthenos app

Sthenos is a gym management app: members, dojos, plans, payments (Stripe Connect and platform billing), email (Resend) and an AI assistant (Sensei). It is a TanStack Start app built as a Node server and shipped as a Docker image. Data and auth live in a Supabase project.

Deployment: `deploy/README.md` (runbook). Supabase cron repoint: `deploy/supabase/repoint-cron.sql`.

## Commands

```bash
npm ci                                  # install (uses the lockfile)
npm run dev                             # Vite dev server
npm test                                # node --test over scripts/tests/*.test.mjs
node scripts/security-gate.mjs          # signup and tenancy invariants
node scripts/authorisation-gate.mjs     # every server function is guarded
npx tsc --noEmit -p .                   # typecheck
npm run build                           # production build to .output/
npm start                               # node .output/server/index.mjs (port 3000)
docker compose up -d                    # needs .env and APP_DOMAIN set (see deploy/README.md)
```

## CI

The CI-equivalent check set is the five jobs in `.github/workflows/ci.yml`:

1. `security-gate`: `node scripts/security-gate.mjs`
2. `test`: `npm test`
3. `authorisation`: `node scripts/authorisation-gate.mjs`
4. `typecheck`: `npx tsc --noEmit -p .`
5. `build`: `npm run build` (with dummy `VITE_*` values)

Run all five before calling a task done. Lint is not one of them.

## Lint

- Lint only the files you touched: `npx eslint <files you touched>`.
- Repo-wide `npm run lint` has a large pre-existing prettier backlog. It is not a CI gate; do not try to clear it inside a feature change.

## Tests

- Tests use `node --test` with `--experimental-strip-types`. Files are `scripts/tests/*.test.mjs`.
- Test modules must import alias-free code. Do not import anything through `@/`; use relative paths such as `../../src/lib/x.ts`.
- New behaviour needs new tests, including at least one unhappy path.

## Dependencies

- Change the lockfile with npm 10: `npx -y npm@10.9.4 install <pkg>`. npm 11 drops optional wasm dependencies from the lockfile and breaks `npm ci`.

## Database

- The schema is owned by the Supabase project. The files in `supabase/migrations/` are historical. Nothing in this repository applies them.
- Changes to the database are made in the Supabase project by its owner. See the Supabase owner checklist in `deploy/README.md`.

## Secrets

- Never commit `.env` (it is in `.gitignore`). `.env.example` holds empty placeholders only.
- Server secrets are read from `process.env` at runtime. They must never go into `VITE_*` variables, which are inlined into the browser bundle.
