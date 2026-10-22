// Server-only helpers for explicit family management actions (remove a member,
// change the payer). Billing behaviour is unchanged: exactly one designated
// payer is charged the discounted family total, and the platform fee is still
// calculated the same way in stripe-connect.server.ts.

import type { FamilyQuote } from "@/lib/family-pricing";

const LIVE_SUB_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
] as const;

export { LIVE_SUB_STATUSES };

/**
 * Push a recalculated family total onto the payer's live Stripe subscription
 * with proration. Returns whether Stripe was actually touched.
 */
export async function pushFamilyTotalToPayer(params: {
  dojoId: string;
  groupId: string;
  payerId: string | null;
  quote: FamilyQuote;
}): Promise<{ stripeUpdated: boolean }> {
  const { dojoId, groupId, payerId, quote } = params;
  if (!payerId || quote.interval === "one_time") return { stripeUpdated: false };

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: subs } = await supabaseAdmin
    .from("member_subscriptions")
    .select("id, stripe_subscription_id")
    .eq("dojo_id", dojoId)
    .eq("member_id", payerId)
    .in("status", [...LIVE_SUB_STATUSES]);
  const live = ((subs ?? []) as any[]).filter((s) => s.stripe_subscription_id);
  if (live.length === 0) return { stripeUpdated: false };

  const { hasStripeSecret, getPlatformStripe, getConnectErrorMessage, duesRequestOptions } =
    await import("@/lib/stripe-connect.server");
  if (!hasStripeSecret()) return { stripeUpdated: false };

  const { data: dojo } = await supabaseAdmin
    .from("dojos")
    .select("stripe_account_id")
    .eq("id", dojoId)
    .maybeSingle();
  if (!dojo?.stripe_account_id) return { stripeUpdated: false };
  // Dues subscriptions live on the PLATFORM account (destination charges).
  const opts = duesRequestOptions();
  const stripe = getPlatformStripe();

  try {
    for (const s of live) {
      const sub = await stripe.subscriptions.retrieve(
        s.stripe_subscription_id,
        undefined,
        opts,
      );
      const item = (sub as any).items?.data?.[0];
      if (!item) continue;
      const price = await stripe.prices.create(
        {
          currency: quote.currency,
          unit_amount: quote.totalCents,
          recurring: { interval: quote.interval as "month" | "year" },
          product_data: {
            name: `Family plan — ${quote.size} member${quote.size === 1 ? "" : "s"} (${quote.discountPercent}% family discount)`,
          },
          metadata: {
            dojo_id: dojoId,
            family_group_id: groupId,
            family_size: String(quote.size),
          },
        } as any,
        opts,
      );
      const updated: any = await stripe.subscriptions.update(
        s.stripe_subscription_id,
        {
          items: [{ id: item.id, price: price.id }],
          proration_behavior: "create_prorations",
          metadata: {
            ...((sub as any).metadata ?? {}),
            family_group_id: groupId,
            family_size: String(quote.size),
            family_discount_percent: String(quote.discountPercent),
          },
        } as any,
        opts,
      );
      // Verify the reprice actually landed before anything downstream trusts it.
      const check: any = await stripe.subscriptions.retrieve(
        s.stripe_subscription_id,
        undefined,
        opts,
      );
      const activePrice = check?.items?.data?.[0]?.price?.id ?? updated?.items?.data?.[0]?.price?.id;
      if (activePrice !== price.id) {
        throw new Error("the new family price is not active on the subscription");
      }
    }
  } catch (e) {
    throw new Error(
      `Stripe would not update the payer's family subscription: ${getConnectErrorMessage(e)}`,
    );
  }

  return { stripeUpdated: true };
}

/** Leave a removed member with no payment arrangement, visibly. */
export async function strandRemovedMember(params: {
  dojoId: string;
  memberId: string;
  memberName: string;
  actorUserId: string | null;
}): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const now = new Date().toISOString();
  await supabaseAdmin
    .from("members")
    .update({
      family_group_id: null,
      plan_covered_by: null,
      selected_plan_id: null,
      payment_status: "none",
      payment_status_updated_at: now,
      updated_at: now,
    })
    .eq("id", params.memberId)
    .eq("dojo_id", params.dojoId);

  await supabaseAdmin.from("internal_tasks").insert({
    dojo_id: params.dojoId,
    member_id: params.memberId,
    title: `Set up payment for ${params.memberName} — removed from family`,
    description:
      "This member was removed from a family group and no longer has any payment arrangement. Choose a plan and set up payment (card or cash).",
    status: "open",
    created_by: params.actorUserId,
  } as any);
}

/* ---------------------------------------------------------------------------
 * The payer's payment method governs the whole family
 * ------------------------------------------------------------------------- */

export type FamilyMethodEffect = {
  isFamily: boolean;
  groupId: string | null;
  payer: { id: string; name: string } | null;
  coveredNames: string[];
  size: number;
  totalCents: number;
  currency: string;
  interval: string;
  discountPercent: number;
  /** Live card subscriptions that a switch to cash must cancel. */
  liveSubscriptions: number;
  /** Whether a switch to card can start billing without a checkout link. */
  hasSavedCard: boolean;
};

/** What a payer's card ↔ cash switch means for the family, before applying it. */
export async function familyMethodEffect(params: {
  db: any;
  dojoId: string;
  memberId: string;
}): Promise<FamilyMethodEffect> {
  const { db, dojoId, memberId } = params;
  const { familyBillingRole, familyTotalForPayer } = await import(
    "@/lib/family-pricing.server"
  );
  const role = await familyBillingRole(db, dojoId, memberId);
  const empty: FamilyMethodEffect = {
    isFamily: false,
    groupId: null,
    payer: null,
    coveredNames: [],
    size: 0,
    totalCents: 0,
    currency: "usd",
    interval: "month",
    discountPercent: 0,
    liveSubscriptions: 0,
    hasSavedCard: false,
  };
  if (!role.inFamily || !role.isPayer) return empty;

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [{ data: me }, { data: fam }, { data: subs }, { data: pm }] = await Promise.all([
    supabaseAdmin.from("members").select("id, name").eq("id", memberId).maybeSingle(),
    supabaseAdmin
      .from("members")
      .select("id, name")
      .eq("dojo_id", dojoId)
      .eq("family_group_id", role.groupId)
      .order("name"),
    supabaseAdmin
      .from("member_subscriptions")
      .select("id")
      .eq("dojo_id", dojoId)
      .eq("member_id", memberId)
      .in("status", [...LIVE_SUB_STATUSES]),
    supabaseAdmin
      .from("member_payment_methods")
      .select("stripe_customer_id, stripe_payment_method_id")
      .eq("dojo_id", dojoId)
      .eq("member_id", memberId)
      .maybeSingle(),
  ]);

  const quote = await familyTotalForPayer(supabaseAdmin, dojoId, memberId);
  const members = ((fam ?? []) as any[]).filter((m) => m.id !== memberId);

  return {
    isFamily: true,
    groupId: role.groupId,
    payer: me ? { id: me.id as string, name: me.name as string } : null,
    coveredNames: members.map((m) => m.name as string),
    size: quote?.size ?? (fam ?? []).length,
    totalCents: quote?.totalCents ?? 0,
    currency: quote?.currency ?? "usd",
    interval: quote?.interval ?? "month",
    discountPercent: quote?.discountPercent ?? 0,
    liveSubscriptions: (subs ?? []).length,
    hasSavedCard: !!(pm?.stripe_customer_id && pm?.stripe_payment_method_id),
  };
}

/**
 * Apply a payer's payment method to their entire family, and move the billing
 * arrangement with it: card → cash cancels the Stripe subscription and starts
 * expecting the discounted total in cash; cash → card starts the subscription
 * for the discounted total.
 */
export async function applyFamilyMethodChange(params: {
  dojoId: string;
  payerId: string;
  method: "card" | "cash";
}): Promise<{
  canceledSubscriptions: number;
  createdSubscription: boolean;
  needsCheckout: boolean;
  coveredNames: string[];
  totalCents: number;
  currency: string;
}> {
  const { dojoId, payerId, method } = params;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const effect = await familyMethodEffect({ db: supabaseAdmin, dojoId, memberId: payerId });

  const {
    hasStripeSecret,
    getPlatformStripe,
    getConnectErrorMessage,
    PLATFORM_FEE_PERCENT,
    subscriptionAppFeePercent,
    duesRequestOptions,
    cancelDuesSubscription,
  } = await import("@/lib/stripe-connect.server");
  const { data: dojo } = await supabaseAdmin
    .from("dojos")
    .select("stripe_account_id, pass_platform_fee_to_members")
    .eq("id", dojoId)
    .maybeSingle();
  // Dues subscriptions live on the PLATFORM account (destination charges).
  const opts = duesRequestOptions();
  const stripeReady = hasStripeSecret() && !!dojo?.stripe_account_id;

  let canceledSubscriptions = 0;
  let createdSubscription = false;
  let needsCheckout = false;

  if (method === "cash") {
    // A cash family has no subscription at all.
    const { data: subs } = await supabaseAdmin
      .from("member_subscriptions")
      .select("id, stripe_subscription_id")
      .eq("dojo_id", dojoId)
      .eq("member_id", payerId)
      .in("status", [...LIVE_SUB_STATUSES]);
    const live = (subs ?? []) as any[];
    if (live.some((s) => s.stripe_subscription_id) && !stripeReady) {
      throw new Error(
        "Stripe isn't configured, so the card subscription can't be stopped. Nothing was changed.",
      );
    }
    for (const s of live) {
      if (s.stripe_subscription_id) {
        // Throws unless Stripe verifies the cancellation (or genuine absence).
        await cancelDuesSubscription(
          getPlatformStripe(),
          s.stripe_subscription_id,
          "immediate",
        );
      }
      await supabaseAdmin
        .from("member_subscriptions")
        .update({ status: "canceled", canceled_at: new Date().toISOString() })
        .eq("id", s.id);
      canceledSubscriptions += 1;
    }

  } else if (
    effect.isFamily &&
    effect.totalCents > 0 &&
    effect.interval !== "one_time" &&
    effect.liveSubscriptions === 0
  ) {
    // Card family: bill the discounted total through the payer.
    const { data: planRow } = await supabaseAdmin
      .from("members")
      .select("selected_plan_id")
      .eq("id", payerId)
      .maybeSingle();
    const planId = (planRow?.selected_plan_id as string | null) ?? null;
    const { data: pm } = await supabaseAdmin
      .from("member_payment_methods")
      .select("stripe_customer_id, stripe_payment_method_id")
      .eq("dojo_id", dojoId)
      .eq("member_id", payerId)
      .maybeSingle();
    if (!stripeReady || !planId || !pm?.stripe_customer_id || !pm.stripe_payment_method_id) {
      needsCheckout = true;
    } else {
      const stripe = getPlatformStripe();
      const passFee = !!dojo?.pass_platform_fee_to_members;
      const grossCents = passFee
        ? effect.totalCents + Math.round((effect.totalCents * PLATFORM_FEE_PERCENT) / 100)
        : effect.totalCents;
      try {
        const price = await stripe.prices.create(
          {
            currency: effect.currency,
            unit_amount: grossCents,
            recurring: { interval: effect.interval as "month" | "year" },
            product_data: {
              name: `Family plan — ${effect.size} member${effect.size === 1 ? "" : "s"} (${effect.discountPercent}% family discount)`,
            },
            metadata: {
              dojo_id: dojoId,
              family_group_id: effect.groupId ?? "",
              family_size: String(effect.size),
            },
          } as any,
          opts,
        );
        const sub = await stripe.subscriptions.create(
          {
            customer: pm.stripe_customer_id,
            items: [{ price: price.id }],
            default_payment_method: pm.stripe_payment_method_id,
            application_fee_percent: subscriptionAppFeePercent(effect.totalCents, grossCents, passFee),
            metadata: {
              dojo_id: dojoId,
              member_id: payerId,
              family_group_id: effect.groupId ?? "",
              family_size: String(effect.size),
              family_discount_percent: String(effect.discountPercent),
            },
          } as any,
          opts,
        );
        await supabaseAdmin.from("member_subscriptions").insert({
          dojo_id: dojoId,
          member_id: payerId,
          plan_id: planId,
          status: "active",
          stripe_subscription_id: (sub as any).id,
          stripe_customer_id: pm.stripe_customer_id,
        });
        createdSubscription = true;
      } catch (err) {
        throw new Error(
          `Stripe would not start the family's card subscription, so nothing was changed: ${getConnectErrorMessage(err)}`,
        );
      }
    }
  }

  // The payer's method now governs every covered member.
  const now = new Date().toISOString();
  await supabaseAdmin
    .from("members")
    .update({ payment_method: method, updated_at: now })
    .eq("dojo_id", dojoId)
    .eq("id", payerId);
  if (effect.groupId) {
    await supabaseAdmin
      .from("members")
      .update({ payment_method: method, plan_covered_by: payerId, updated_at: now })
      .eq("dojo_id", dojoId)
      .eq("family_group_id", effect.groupId)
      .neq("id", payerId);
  }

  // Explicitly assert the invariants: after a switch to cash NOBODY in the
  // family may hold a live subscription, and covered members never may.
  const { enforceFamilyBillingInvariants } = await import(
    "@/lib/family-invariants.server"
  );
  const inv = await enforceFamilyBillingInvariants({
    dojoId,
    groupIds: [effect.groupId],
    memberIds: [payerId],
  });
  canceledSubscriptions += inv.canceled.length;


  return {
    canceledSubscriptions,
    createdSubscription,
    needsCheckout,
    coveredNames: effect.coveredNames,
    totalCents: effect.totalCents,
    currency: effect.currency,
  };
}
