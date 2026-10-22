import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { SITE_URL } from "@/lib/site";
import {
  createStripeClient,
  getStripeEnv,
  getStripeErrorMessage,
} from "@/lib/stripe.server";

/**
 * Platform SaaS billing — the gym (dojo) pays the platform (Sthenos) for
 * SaaS access. Runs against the platform's single Stripe account through
 * the Lovable connector gateway. Tagged with metadata.type = "platform" so
 * `/api/public/payments/webhook` (gateway webhook) can route the events.
 *
 * Note: member-dues charges use `payments.functions.ts` (BYOK Connect).
 */

const STAFF_ROLES = new Set(["owner", "manager", "admin"]);

export const createPlatformCheckoutSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; priceLookupKey: string; returnPath?: string }) =>
    z
      .object({
        dojoId: z.string().uuid(),
        priceLookupKey: z.string().min(1),
        returnPath: z.string().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: mem } = await context.supabase
      .from("dojo_memberships")
      .select("role")
      .eq("user_id", context.userId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (!mem || !STAFF_ROLES.has(mem.role)) {
      return { url: null as string | null, error: "Not allowed" };
    }

    const env = getStripeEnv();
    const stripe = createStripeClient(env);

    try {
      const prices = await stripe.prices.list({ lookup_keys: [data.priceLookupKey], limit: 1 });
      if (!prices.data.length) return { url: null, error: "Price not found" };
      const price = prices.data[0];

      const origin = (
        process.env.APP_URL ?? process.env.SITE_URL ?? SITE_URL
      ).replace(/\/$/, "");
      const returnPath = data.returnPath ?? "/settings/payments";

      const session = await stripe.checkout.sessions.create({
        mode: price.type === "recurring" ? "subscription" : "payment",
        line_items: [{ price: price.id, quantity: 1 }],
        success_url: `${origin}${returnPath}?platform=success`,
        cancel_url: `${origin}${returnPath}?platform=cancelled`,
        metadata: { type: "platform", dojoId: data.dojoId, env },
        ...(price.type === "recurring"
          ? {
              subscription_data: {
                metadata: { type: "platform", dojoId: data.dojoId },
              },
            }
          : {}),
      });
      return { url: session.url, error: null as string | null };
    } catch (e) {
      return { url: null, error: getStripeErrorMessage(e) };
    }
  });
