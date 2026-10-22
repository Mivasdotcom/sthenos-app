// Server-only pricing helpers shared by price changes and pauses.
//
// GOVERNING RULE: a member's charge never changes mid-cycle. Every Stripe
// reprice here is issued with `proration_behavior: "none"` and
// `billing_cycle_anchor: "unchanged"`, so the new amount can only appear on the
// member's NEXT renewal invoice — never as a surprise charge today.

import type Stripe from "stripe";

/** The price this member actually pays: their locked-in price, else the plan's. */
export function effectivePriceCents(member: {
  plan_price_cents?: number | null;
  dojo_plans?: { price_cents?: number | null } | null;
}): number {
  const locked = member?.plan_price_cents;
  if (locked != null) return Number(locked);
  return Number(member?.dojo_plans?.price_cents ?? 0);
}

/** True when this member is on an older price than the plan's current one. */
export function isGrandfathered(member: {
  plan_price_cents?: number | null;
  dojo_plans?: { price_cents?: number | null } | null;
}): boolean {
  const locked = member?.plan_price_cents;
  if (locked == null) return false;
  return Number(locked) !== Number(member?.dojo_plans?.price_cents ?? locked);
}

export type RepriceOutcome = {
  changed: boolean;
  priceId: string | null;
  /** When the new amount first bills. */
  effectiveAt: string | null;
};

/**
 * Move a live dues subscription onto a new amount, taking effect at the next
 * renewal. Verifies with Stripe before the caller writes any local state.
 */
export async function repriceSubscriptionAtRenewal(args: {
  stripe: Stripe;
  subscriptionId: string;
  unitAmountCents: number;
  currency: string;
  interval: "month" | "year";
  productName: string;
  metadata?: Record<string, string>;
}): Promise<RepriceOutcome> {
  const { duesRequestOptions, subscriptionPeriodEnd, getConnectErrorMessage } = await import(
    "@/lib/stripe-connect.server"
  );
  const opts = duesRequestOptions();
  const stripe = args.stripe;

  try {
    const sub: any = await stripe.subscriptions.retrieve(
      args.subscriptionId,
      undefined,
      opts,
    );
    const item = sub?.items?.data?.[0];
    if (!item) return { changed: false, priceId: null, effectiveAt: null };
    if (Number(item.price?.unit_amount) === args.unitAmountCents) {
      return { changed: false, priceId: item.price?.id ?? null, effectiveAt: subscriptionPeriodEnd(sub) };
    }

    const price = await stripe.prices.create(
      {
        currency: args.currency,
        unit_amount: args.unitAmountCents,
        recurring: { interval: args.interval },
        product_data: { name: args.productName },
        metadata: args.metadata ?? {},
      } as any,
      opts,
    );

    await stripe.subscriptions.update(
      args.subscriptionId,
      {
        items: [{ id: item.id, price: price.id }],
        // Never charge mid-cycle for a gym-initiated price change.
        proration_behavior: "none",
        billing_cycle_anchor: "unchanged",
      } as any,
      opts,
    );

    const after: any = await stripe.subscriptions.retrieve(
      args.subscriptionId,
      undefined,
      opts,
    );
    const activePrice = after?.items?.data?.[0]?.price?.id;
    if (activePrice !== price.id) {
      throw new Error("the new price is not active on the subscription");
    }
    return {
      changed: true,
      priceId: price.id,
      effectiveAt: subscriptionPeriodEnd(after),
    };
  } catch (e) {
    throw new Error(
      `Stripe would not move this subscription onto the new price, so nothing was changed: ${getConnectErrorMessage(e)}`,
    );
  }
}
