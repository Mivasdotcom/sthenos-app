# Multi-stage build: the build stage compiles the app, the runtime stage ships only
# the self-contained Nitro server in .output/ and runs as the unprivileged "node" user.
# Both stages use the same base tag so the Node and npm versions match.

# --- Build stage -------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# VITE_* values are inlined into the client bundle AT BUILD TIME, so they must be
# present while `npm run build` runs. They are set as ENV in this stage only; the
# runtime stage never sees them. Do not put server secrets here.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_SUPABASE_PROJECT_ID
ARG VITE_PUBLIC_SITE_URL
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY \
    VITE_SUPABASE_PROJECT_ID=$VITE_SUPABASE_PROJECT_ID \
    VITE_PUBLIC_SITE_URL=$VITE_PUBLIC_SITE_URL

RUN npm run build

# --- Runtime stage -----------------------------------------------------------
FROM node:22-bookworm-slim

# Server secrets (SUPABASE_SERVICE_ROLE_KEY, STRIPE_*, RESEND_API_KEY, ...) are NOT
# baked into the image. They are read from process.env at container start, supplied
# by docker compose via env_file.
ENV NODE_ENV=production PORT=3000
WORKDIR /app

COPY --from=build --chown=node:node /app/.output ./.output

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/public/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", ".output/server/index.mjs"]
