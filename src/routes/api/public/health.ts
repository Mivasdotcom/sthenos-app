import { createFileRoute } from "@tanstack/react-router";

// Liveness probe. Must not read env vars or secrets so it works in any deployment.
export const Route = createFileRoute("/api/public/health")({
  server: {
    handlers: {
      GET: async () => Response.json({ ok: true }),
    },
  },
});
