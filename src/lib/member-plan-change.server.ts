/**
 * Moving a member's live Stripe subscription onto a different plan.
 *
 * Before this existed, changing a member's plan in the admin rewrote
 * `members.selected_plan_id` and nothing else. The database said the new plan
 * and Stripe carried on billing the old one -- indefinitely, and with nothing
 * on any screen to show the two disagreed. An adult accidentally enrolled on
 * the kids plan and corrected in the admin would have kept paying the kids
 * price forever.
 *
 * The new price takes effect from the member's NEXT charge, never
 * retroactively and never with a proration invoice: a plan change made by the
 * gym should not surprise anyone with an out-of-cycle bill.
 */
import { PLATFORM_FEE_PERCENT } from "@/lib/platform-fee";

const LIVE = ["active", "trialing", "past_due", "unpaid", "incomplete"] as const;

export type RepriceResult =
  | { changed: false; reason: "no_live_subscription" | "one_time_plan" }
  | { changed: true; subscriptionIds: string[]; chargeCents: number; currency: string };

export async function moveMemberSubscriptionToPlan(params: {
  dojoId: string;
  memberId: string;
  planId: string;
}): Promise<RepriceResult> {
  const { dojoId, memberId, planId } = params;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: subs } = await supabaseAdmin
    .from("member_subscriptions")
    .select("id, stripe_subscription_id, status")
    .eq("dojo_id", dojoId)
    .eq("member_id", memberId)
    .in("status", LIVE);
  const live = ((subs ?? []) as any[]).filter((s) => s.stripe_subscription_id);
  // A cash payer, or someone who never finished checkout: nothing in Stripe
  // to move, so the database change alone is the whole change.
  if (live.length === 0) return { changed: false, reason: "no_live_subscription" };

  const { data: plan, error: planErr } = await supabaseAdmin
    .from("dojo_plans")
    .select("id, name, price_cents, currency, interval")
    .eq("id", planId)
    .eq("dojo_id", dojoId)
    .maybeSingle();
  if (planErr) throw planErr;
  if (!plan) throw new Error("That plan doesn't belong to this gym.");
  if (plan.interval === "one_time") return { changed: false, reason: "one_time_plan" };

  const { data: dojo } = await supabaseAdmin
    .from("dojos")
    .select("pass_platform_fee_to_members, stripe_account_id")
    .eq("id", dojoId)
    .maybeSingle();
  if (!dojo?.stripe_account_id) {
    throw new Error("This gym hasn't finished payment setup, so its subscriptions can't be changed.");
  }

  // Charge exactly what a brand-new member on this plan would be charged. When
  // the gym passes the platform fee on, that is the plan price PLUS the fee --
  // the stored Stripe price on the plan is the pre-fee figure, which is why
  // simply swapping to it would under-charge and silently stop passing the
  // fee through.
  const passFee = !!dojo.pass_platform_fee_to_members;
  const chargeCents = passFee
    ? plan.price_cents + Math.round((plan.price_cents * PLATFORM_FEE_PERCENT) / 100)
    : plan.price_cents;
  const currency = String(plan.currency || "eur").toLowerCase();

  const { getPlatformStripe, getConnectErrorMessage, duesRequestOptions, hasStripeSecret } =
    await import("@/lib/stripe-connect.server");
  if (!hasStripeSecret()) throw new Error("Stripe isn't configured.");
  const stripe = getPlatformStripe();
  // Dues subscriptions live on the PLATFORM account (destination charges).
  const opts = duesRequestOptions();

  const moved: string[] = [];
  try {
    for (const s of live) {
      const sub: any = await stripe.subscriptions.retrieve(s.stripe_subscription_id, undefined, opts);
      const item = sub?.items?.data?.[0];
      if (!item) throw new Error(`subscription ${s.stripe_subscription_id} has no items`);

      const price = await stripe.prices.create(
        {
          currency,
          unit_amount: chargeCents,
          recurring: { interval: plan.interval as "month" | "year" },
          product_data: {
            name: passFee
              ? `${plan.name} (includes ${PLATFORM_FEE_PERCENT}% platform fee)`
              : plan.name,
          },
          metadata: { dojo_id: dojoId, dojo_plan_id: plan.id, member_id: memberId },
        } as any,
        opts,
      );

      await stripe.subscriptions.update(
        s.stripe_subscription_id,
        {
          items: [{ id: item.id, price: price.id }],
          // From the next charge only. No out-of-cycle invoice for a change
          // the member didn't make themselves.
          proration_behavior: "none",
          metadata: { ...(sub.metadata ?? {}), planId: plan.id },
        } as any,
        opts,
      );

      // Trust nothing until Stripe confirms the new price is actually live.
      const check: any = await stripe.subscriptions.retrieve(s.stripe_subscription_id, undefined, opts);
      if (check?.items?.data?.[0]?.price?.id !== price.id) {
        throw new Error("the new price is not active on the subscription");
      }
      moved.push(s.stripe_subscription_id);
    }
  } catch (e) {
    throw new Error(`Stripe would not move the subscription: ${getConnectErrorMessage(e)}`);
  }

  await supabaseAdmin
    .from("member_subscriptions")
    .update({ plan_id: plan.id, updated_at: new Date().toISOString() })
    .in(
      "stripe_subscription_id",
      moved,
    );

  return { changed: true, subscriptionIds: moved, chargeCents, currency };
}
