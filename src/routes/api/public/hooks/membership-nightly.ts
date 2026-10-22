import { createFileRoute } from "@tanstack/react-router";

/**
 * Nightly membership maintenance:
 *  - applies scheduled price changes whose notice period has elapsed
 *  - auto-resumes pauses that reached their resume date, and reminds 3 days out
 */
export const Route = createFileRoute("/api/public/hooks/membership-nightly")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { authorizeCron } = await import("@/lib/scheduler.server");
        if (!authorizeCron(request)) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        try {
          const { applyDuePriceChanges, runPauseMaintenance } = await import(
            "@/lib/pause-apply.server"
          );
          const { runDunningSweep } = await import("@/lib/dunning.server");
          const prices = await applyDuePriceChanges();
          const pauses = await runPauseMaintenance();
          // Mid-grace reminder and final notice for failed payments, on each
          // gym's own grace period.
          const dunning = await runDunningSweep();
          // Trials are the warmest leads in the gym: nudge before the window
          // closes rather than letting them lapse in silence.
          const { runTrialEndingReminders } = await import("@/lib/trial-reminder.server");
          const trials = await runTrialEndingReminders();
          // Data retention: anonymise records of members who left longer ago
          // than the gym's retention period, and scrub waivers past their own
          // longer clock. Every run and action is logged.
          // Bring older subscriptions onto an application fee that covers
          // Stripe's cost as well as the platform's margin. Subscriptions made
          // before this claimed only the 1%, so the PLATFORM was paying each
          // gym's card fees out of its own balance. Changes the split only --
          // the member's charge is identical -- and applies from their next
          // invoice, so nothing is ever taken back.
          let fees: any = { checked: 0, updated: 0, skipped: 0 };
          try {
            const { realignApplicationFees } = await import("@/lib/fee-realign.server");
            fees = await realignApplicationFees({});
          } catch (e: any) {
            console.error("[membership-nightly] fee realign failed", e);
            fees = { checked: 0, updated: 0, skipped: 0, error: e?.message };
          }
          const { runRetentionSweep } = await import("@/lib/data-retention.server");
          let retention: any = { gyms: 0, anonymised: 0, waivers: 0, notices: 0, failed: 0 };
          try {
            retention = await runRetentionSweep();
          } catch (e: any) {
            console.error("[membership-nightly] retention sweep failed", e);
            retention = { gyms: 0, anonymised: 0, waivers: 0, notices: 0, failed: 1, error: e?.message };
          }
          const failed = prices.failed + pauses.failed + (retention.failed ?? 0);
          return new Response(
            JSON.stringify({ success: failed === 0, prices, pauses, dunning, trials, fees, retention }),
            {
              status: failed === 0 ? 200 : 500,
              headers: { "Content-Type": "application/json" },
            },
          );


        } catch (e: any) {
          console.error("[membership-nightly]", e);
          return new Response(JSON.stringify({ success: false, error: e?.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
