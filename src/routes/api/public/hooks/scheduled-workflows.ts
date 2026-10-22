import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/scheduled-workflows")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { authorizeCron, runDueScheduledWorkflows } = await import(
          "@/lib/scheduler.server"
        );
        if (!authorizeCron(request)) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        try {
          const result = await runDueScheduledWorkflows();
          return new Response(JSON.stringify({ success: true, ...result }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e: any) {
          console.error("[scheduled-workflows]", e);
          return new Response(JSON.stringify({ success: false, error: e?.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
