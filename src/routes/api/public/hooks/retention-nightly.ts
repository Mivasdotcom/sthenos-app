import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/retention-nightly")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { authorizeCron, recomputeRetentionForAllDojos } = await import(
          "@/lib/scheduler.server"
        );
        if (!authorizeCron(request)) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        try {
          const result = await recomputeRetentionForAllDojos();
          return new Response(JSON.stringify({ success: true, ...result }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e: any) {
          console.error("[retention-nightly]", e);
          return new Response(JSON.stringify({ success: false, error: e?.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
