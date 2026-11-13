# selfhost-node-docker: non-obvious things
- Vite inlines `import.meta.env.VITE_*` into the SSR bundle too; once inlined (even as `""`) the `process.env` fallback in `site.ts` is dead code.
- Docker `ARG X` + `ENV X=$X` and compose `${X:-}` turn "unset" into `""`, so every `?? default` is bypassed. Use `||`.
- `email-send.server.ts` computes `SENDING_DOMAIN` when the module loads: a bad env value crashes every importer (auth-email hook, email queue, password reset).
- `src/start.ts` and `canonical-host.ts` skip wrapping/redirects only for `/api/public/hooks/`; new self-authenticating endpoints must live there.
- An unknown GET to `/api/public/hooks/*` returns 200 SPA HTML (POST-only handlers), not 405.
- Route files use `@/` aliases and can't be imported by `node --test`; only alias-free `src/lib/*` is unit-testable.
- `main` = verbatim import commit 42df455; all feature work is on the branch.
- An empty `NODE_ENV` silently selects the Stripe sandbox key.
