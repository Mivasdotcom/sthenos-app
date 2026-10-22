import { createFileRoute } from "@tanstack/react-router";
import type { StripeEnv } from "@/lib/stripe.server";
import { verifyStripeWebhook } from "@/lib/stripe.server";

// Gateway (Lovable connector) webhook for the PLATFORM's own Stripe
// account. Only handles metadata.type === "platform" events for the
// platform_subscriptions table. Member-dues events go to the BYOK Connect
// webhook at /api/public/stripe/connect-webhook.

function isPlatform(md: any): boolean {
  return md && md.type === "platform" && md.dojoId;
}

async function upsertPlatformSubscription(
  supabaseAdmin: any,
  sub: any,
  env: StripeEnv,
) {
  const md = sub.metadata ?? {};
  if (!isPlatform(md)) return;
  const item = sub.items?.data?.[0];
  const priceLookup = item?.price?.lookup_key ?? item?.price?.id ?? null;
  const periodStart = item?.current_period_start ?? sub.current_period_start;
  const periodEnd = item?.current_period_end ?? sub.current_period_end;
  await supabaseAdmin.from("platform_subscriptions").upsert(
    {
      dojo_id: md.dojoId,
      stripe_subscription_id: sub.id,
      stripe_customer_id: typeof sub.customer === "string" ? sub.customer : null,
      status: sub.status,
      price_id: priceLookup,
      current_period_start: periodStart ? new Date(periodStart * 1000).toISOString() : null,
      current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      cancel_at_period_end: !!sub.cancel_at_period_end,
      environment: env,
    },
    { onConflict: "dojo_id" },
  );
}

export const Route = createFileRoute("/api/public/payments/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const rawEnv = new URL(request.url).searchParams.get("env");
        if (rawEnv !== "sandbox" && rawEnv !== "live") {
          return Response.json({ received: true, ignored: "invalid env" });
        }
        const env: StripeEnv = rawEnv;

        let event: { type: string; data: { object: any }; id: string };
        try {
          event = await verifyStripeWebhook(request, env);
        } catch (e) {
          console.error("Platform webhook verify failed:", e);
          return new Response("Invalid signature", { status: 400 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        try {
          switch (event.type) {
            case "checkout.session.completed": {
              const s = event.data.object;
              if (isPlatform(s.metadata ?? {}) && typeof s.customer === "string") {
                await supabaseAdmin
                  .from("platform_subscriptions")
                  .upsert(
                    {
                      dojo_id: s.metadata.dojoId,
                      stripe_customer_id: s.customer,
                      status: "active",
                      environment: env,
                    },
                    { onConflict: "dojo_id" },
                  );
              }
              break;
            }
            case "customer.subscription.created":
            case "customer.subscription.updated":
              await upsertPlatformSubscription(supabaseAdmin, event.data.object, env);
              break;
            case "customer.subscription.deleted": {
              const sub = event.data.object;
              if (isPlatform(sub.metadata ?? {})) {
                await supabaseAdmin
                  .from("platform_subscriptions")
                  .update({ status: "canceled" })
                  .eq("stripe_subscription_id", sub.id);
              }
              break;
            }
            default:
              console.log("Platform webhook: unhandled event", event.type);
          }
        } catch (e) {
          console.error("Platform webhook handler error", event.type, e);
          return new Response("Handler error", { status: 500 });
        }
        return Response.json({ received: true });
      },
    },
  },
});
