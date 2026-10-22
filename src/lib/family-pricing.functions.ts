// Family discount tiers: per-gym configuration, quoting, and applying the
// recalculated total to the payer's Stripe subscription with proration.
//
// Billing behaviour is unchanged: ONE payer is charged, dependents stay covered
// via plan_covered_by, and the platform fee still applies to the amount actually
// charged (Stripe's application_fee_percent on the subscription).

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  DEFAULT_FAMILY_TIERS,
  clampPercent,
  computeFamilyQuote,
  countsTowardFamilyTotal,
  tierDropWarning,
  type FamilyDiscountTier,
  type FamilyPricingMode,
  type FamilyPriceMember,
  type FamilyQuote,
} from "@/lib/family-pricing";

const CONFIG_ROLES = ["owner", "manager", "admin"];
const STAFF_ROLES = ["owner", "manager", "admin", "coach"];

async function role(supabase: any, dojoId: string, userId: string) {
  const { data } = await supabase
    .from("dojo_memberships")
    .select("role")
    .eq("dojo_id", dojoId)
    .eq("user_id", userId)
    .maybeSingle();
  return data?.role ?? null;
}

async function assertStaff(supabase: any, dojoId: string, userId: string) {
  const r = await role(supabase, dojoId, userId);
  if (!r || !STAFF_ROLES.includes(r)) throw new Error("Not authorised");
}

async function assertConfig(supabase: any, dojoId: string, userId: string) {
  const r = await role(supabase, dojoId, userId);
  if (!r || !CONFIG_ROLES.includes(r)) {
    throw new Error("Only owners and admins can change family pricing.");
  }
}

export type FamilyPricingConfig = {
  mode: FamilyPricingMode;
  tiers: FamilyDiscountTier[];
};

export const getFamilyPricingConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }): Promise<FamilyPricingConfig> => {
    const { supabase } = context as any;
    const { data: dojo } = await supabase
      .from("dojos")
      .select("family_pricing_mode")
      .eq("id", data.dojoId)
      .maybeSingle();
    const { data: rows } = await supabase
      .from("family_discount_tiers")
      .select("min_members, discount_percent")
      .eq("dojo_id", data.dojoId)
      .order("min_members");
    const tiers = (rows ?? []).map((t: any) => ({
      min_members: Number(t.min_members),
      discount_percent: Number(t.discount_percent),
    }));
    return {
      mode: (dojo?.family_pricing_mode as FamilyPricingMode) ?? "tiered",
      tiers: tiers.length ? tiers : DEFAULT_FAMILY_TIERS,
    };
  });

export const saveFamilyPricingConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      dojoId: string;
      mode: FamilyPricingMode;
      tiers: FamilyDiscountTier[];
    }) => d,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertConfig(supabase, data.dojoId, userId);

    if (!["flat", "tiered"].includes(data.mode)) {
      throw new Error("Invalid family pricing mode.");
    }

    const seen = new Set<number>();
    const tiers = data.tiers
      .map((t) => ({
        min_members: Math.floor(Number(t.min_members)),
        discount_percent: Number(Number(t.discount_percent).toFixed(2)),
      }))
      .filter((t) => Number.isFinite(t.min_members) && t.min_members >= 2);

    for (const t of tiers) {
      if (t.discount_percent < 0 || t.discount_percent > 100) {
        throw new Error("Discounts must be between 0% and 100%.");
      }
      if (seen.has(t.min_members)) {
        throw new Error(`You have two tiers for ${t.min_members} members.`);
      }
      seen.add(t.min_members);
    }

    const { error: dErr } = await supabase
      .from("dojos")
      .update({ family_pricing_mode: data.mode })
      .eq("id", data.dojoId);
    if (dErr) throw dErr;

    const { error: delErr } = await supabase
      .from("family_discount_tiers")
      .delete()
      .eq("dojo_id", data.dojoId);
    if (delErr) throw delErr;

    if (tiers.length > 0) {
      const { error: insErr } = await supabase
        .from("family_discount_tiers")
        .insert(tiers.map((t) => ({ ...t, dojo_id: data.dojoId })));
      if (insErr) throw insErr;
    }

    return { ok: true, mode: data.mode, tiers };
  });

type GroupRow = {
  id: string;
  name: string;
  status: string;
  trains?: boolean | null;
  /** A grandfathered price, which wins over the plan's current one. */
  plan_price_cents?: number | null;
  selected_plan_id: string | null;
  plan_covered_by: string | null;
  dojo_plans: {
    id: string;
    name: string;
    price_cents: number;
    currency: string;
    interval: string;
    plan_type: string;
  } | null;
};

async function loadGroup(
  supabase: any,
  dojoId: string,
  groupId: string,
): Promise<GroupRow[]> {
  const { data: rows, error } = await supabase
    .from("members")
    .select(
      "id, name, status, trains, plan_price_cents, selected_plan_id, plan_covered_by, dojo_plans:selected_plan_id(id, name, price_cents, currency, interval, plan_type)",
    )
    .eq("dojo_id", dojoId)
    .eq("family_group_id", groupId)
    .order("name");
  if (error) throw error;
  return (rows ?? []) as GroupRow[];
}

function quoteFor(
  rows: GroupRow[],
  tiers: FamilyDiscountTier[],
  fallbackCurrency: string,
  payerId?: string | null,
): FamilyQuote {
  // Members who are not paying (trial, paused, lapsed…) stay in the group but
  // do not contribute to the billed total or the discount tier.
  //
  // "Pending" is the exception, and it means two different things here. On the
  // payer and on anyone COVERED by them it means the payer's card is about to
  // be charged for them -- the checkout counts those, so the breakdown must
  // agree or a parent reads €0 while paying €20. On anyone else in the group
  // it means they started joining and never finished, and neither the charge
  // nor the breakdown should include them.
  const effectiveStatus = (m: GroupRow) =>
    String(m.status) === "pending" && (m.id === payerId || m.plan_covered_by === payerId)
      ? "active"
      : m.status;

  const billableRows = rows.filter((m) =>
    countsTowardFamilyTotal(effectiveStatus(m), m.trains),
  );
  // Children added at signup carry no plan of their own, so without the
  // payer's price as a fallback they priced at 0 -- and with a parent who
  // doesn't train excluded, the whole family quoted €0 while the checkout,
  // which DOES fall back to the payer's price, billed the real amount. The
  // same fallback, in the same order, as familyTotalForPayer: the breakdown a
  // parent reads must be the figure their card is charged.
  const payerForPrice = payerId ? rows.find((m) => m.id === payerId) : null;
  const payerFallbackPrice =
    payerForPrice?.plan_price_cents ?? payerForPrice?.dojo_plans?.price_cents ?? 0;
  const members: FamilyPriceMember[] = rows.map((m) => ({
    id: m.id,
    name: m.name,
    status: effectiveStatus(m),
    trains: m.trains,
    planName: m.dojo_plans?.name ?? null,
    priceCents: m.plan_price_cents ?? m.dojo_plans?.price_cents ?? payerFallbackPrice,
    // Each member keeps their own plan interval; computeFamilyQuote normalises
    // it into the family's billing interval before summing.
    interval: m.dojo_plans?.interval ?? null,
  }));
  const payerRow = payerId ? rows.find((m) => m.id === payerId) : null;
  const withPlan = billableRows.find((m) => m.dojo_plans);
  return computeFamilyQuote({
    members,
    tiers,
    currency: payerRow?.dojo_plans?.currency ?? withPlan?.dojo_plans?.currency ?? fallbackCurrency,
    // The family bills on ONE interval: the payer's plan interval.
    interval: payerRow?.dojo_plans?.interval ?? withPlan?.dojo_plans?.interval ?? "month",
  });
}


/** The explicitly designated payer for a group, never inferred. */
async function groupPayerId(
  supabase: any,
  dojoId: string,
  groupId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("family_groups")
    .select("payer_member_id")
    .eq("id", groupId)
    .eq("dojo_id", dojoId)
    .maybeSingle();
  return (data?.payer_member_id as string | null) ?? null;
}

const LIVE_SUB_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
] as const;

/** Family members other than the payer who still have a subscription of their own. */
async function duplicateSubscribers(
  supabase: any,
  dojoId: string,
  rows: GroupRow[],
  payerId: string | null,
  extraMemberIds: string[] = [],
): Promise<{ id: string; name: string }[]> {
  const candidates = rows.filter((m) => m.id !== payerId).map((m) => m.id);
  const ids = Array.from(new Set([...candidates, ...extraMemberIds])).filter(
    (id) => id !== payerId,
  );
  if (ids.length === 0) return [];
  const { data: subs } = await supabase
    .from("member_subscriptions")
    .select("member_id")
    .eq("dojo_id", dojoId)
    .in("member_id", ids)
    .in("status", LIVE_SUB_STATUSES);
  const flagged = new Set((subs ?? []).map((s: any) => s.member_id));
  if (flagged.size === 0) return [];
  const { data: names } = await supabase
    .from("members")
    .select("id, name")
    .eq("dojo_id", dojoId)
    .in("id", Array.from(flagged));
  return ((names ?? []) as any[]).map((m) => ({ id: m.id, name: m.name }));
}

export type FamilyQuoteResult = {
  mode: FamilyPricingMode;
  tiers: FamilyDiscountTier[];
  current: FamilyQuote;
  /** Only present when adds/removes were supplied. */
  next: FamilyQuote | null;
  /** Explicit warning when the change lowers the discount tier. */
  tierDropWarning: string | null;
  payer: { id: string; name: string } | null;
  hasLiveSubscription: boolean;
  /** Covered members who would be double-charged unless their own plan is cancelled. */
  duplicateSubscriptions: { id: string; name: string }[];
  /** How the designated payer pays — the whole family is billed this way. */
  payerPaymentMethod: "card" | "cash" | null;
  /**
   * Members whose own payment method differs from the payer's and who will be
   * switched onto the payer's arrangement, so nobody is both covered and
   * separately expected to pay.
   */
  paymentMethodConflicts: { id: string; name: string; method: "card" | "cash" }[];
};


/**
 * The family total, the maths behind it, and the before/after when members are
 * about to be added or removed.
 */
export const getFamilyQuote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      dojoId: string;
      groupId: string;
      addMemberIds?: string[];
      removeMemberIds?: string[];
      /** Treat this member as the payer (before it has been saved). */
      assumePayerId?: string | null;
    }) => d,
  )

  .handler(async ({ data, context }): Promise<FamilyQuoteResult> => {
    const { supabase, userId } = context as any;
    await assertStaff(supabase, data.dojoId, userId);

    const cfg = await (async () => {
      const { data: dojo } = await supabase
        .from("dojos")
        .select("family_pricing_mode, default_currency, pass_platform_fee_to_members")
        .eq("id", data.dojoId)
        .maybeSingle();
      const { data: rows } = await supabase
        .from("family_discount_tiers")
        .select("min_members, discount_percent")
        .eq("dojo_id", data.dojoId)
        .order("min_members");
      const tiers = (rows ?? []).map((t: any) => ({
        min_members: Number(t.min_members),
        discount_percent: Number(t.discount_percent),
      }));
      return {
        mode: (dojo?.family_pricing_mode as FamilyPricingMode) ?? "tiered",
        tiers: tiers.length ? tiers : DEFAULT_FAMILY_TIERS,
        currency: dojo?.default_currency ?? "usd",
      };
    })();

    const rows = await loadGroup(supabase, data.dojoId, data.groupId);
    const groupPayer = await groupPayerId(supabase, data.dojoId, data.groupId);
    const current = quoteFor(rows, cfg.tiers, cfg.currency, groupPayer);

    let next: FamilyQuote | null = null;
    const adds = data.addMemberIds ?? [];
    const removes = new Set(data.removeMemberIds ?? []);
    if (adds.length > 0 || removes.size > 0) {
      let nextRows = rows.filter((m) => !removes.has(m.id));
      if (adds.length > 0) {
        const { data: extra } = await supabase
          .from("members")
          .select(
            "id, name, status, trains, plan_price_cents, selected_plan_id, plan_covered_by, dojo_plans:selected_plan_id(id, name, price_cents, currency, interval, plan_type)",
          )
          .eq("dojo_id", data.dojoId)
          .in("id", adds);
        const existing = new Set(nextRows.map((m) => m.id));
        nextRows = nextRows.concat(
          ((extra ?? []) as GroupRow[]).filter((m) => !existing.has(m.id)),
        );
      }
      next = quoteFor(nextRows, cfg.tiers, cfg.currency, groupPayer);
    }

    const payerId = groupPayer;
    const payerRow = rows.find((m) => m.id === payerId) ?? null;

    let hasLiveSubscription = false;
    if (payerRow) {
      const { count } = await supabase
        .from("member_subscriptions")
        .select("id", { count: "exact", head: true })
        .eq("dojo_id", data.dojoId)
        .eq("member_id", payerRow.id)
        .in("status", LIVE_SUB_STATUSES);
      hasLiveSubscription = (count ?? 0) > 0;
    }

    // A family discount assumes ONE payer covers everyone, so every covered
    // member is billed through the payer's arrangement. Surface anyone whose
    // own payment method will change as a result.
    const effectivePayerId = data.assumePayerId ?? payerId;
    let payerPaymentMethod: "card" | "cash" | null = null;
    let paymentMethodConflicts: {
      id: string;
      name: string;
      method: "card" | "cash";
    }[] = [];
    const involvedIds = Array.from(
      new Set([...rows.map((m) => m.id), ...adds]),
    ).filter((id) => !removes.has(id));
    if (effectivePayerId && involvedIds.length > 0) {
      const { data: methodRows } = await supabase
        .from("members")
        .select("id, name, payment_method")
        .eq("dojo_id", data.dojoId)
        .in("id", involvedIds);
      const all = (methodRows ?? []) as any[];
      const payerMethod = all.find((m) => m.id === effectivePayerId)?.payment_method;
      payerPaymentMethod = (payerMethod ?? "card") as "card" | "cash";
      paymentMethodConflicts = all
        .filter(
          (m) =>
            m.id !== effectivePayerId &&
            ((m.payment_method ?? "card") as string) !== payerPaymentMethod,
        )
        .map((m) => ({
          id: m.id as string,
          name: m.name as string,
          method: (m.payment_method ?? "card") as "card" | "cash",
        }));
    }

    return {
      mode: cfg.mode,
      tiers: cfg.tiers,
      current,
      next,
      tierDropWarning: next ? tierDropWarning(current, next) : null,
      payer: payerRow ? { id: payerRow.id, name: payerRow.name } : null,
      hasLiveSubscription,
      duplicateSubscriptions: await duplicateSubscribers(
        supabase,
        data.dojoId,
        rows,
        payerId,
        adds,
      ),
      payerPaymentMethod,
      paymentMethodConflicts,
    };

  });


/**
 * Push the recalculated family total onto the payer's live Stripe subscription
 * with proration. Staff must have confirmed the amount (expectedTotalCents),
 * which we re-derive server-side and refuse to apply if it has drifted.
 */
export const applyFamilyPricing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { dojoId: string; groupId: string; expectedTotalCents: number }) => d,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertConfig(supabase, data.dojoId, userId);

    const { data: dojoRow } = await supabase
      .from("dojos")
      .select("family_pricing_mode, default_currency")
      .eq("id", data.dojoId)
      .maybeSingle();
    if ((dojoRow?.family_pricing_mode ?? "tiered") !== "tiered") {
      throw new Error(
        "This gym uses flat family pricing, so there is nothing to recalculate.",
      );
    }

    const { data: tierRows } = await supabase
      .from("family_discount_tiers")
      .select("min_members, discount_percent")
      .eq("dojo_id", data.dojoId);
    const tiers = ((tierRows ?? []) as any[]).map((t) => ({
      min_members: Number(t.min_members),
      discount_percent: clampPercent(Number(t.discount_percent)),
    }));

    const rows = await loadGroup(supabase, data.dojoId, data.groupId);
    const quote = quoteFor(
      rows,
      tiers.length ? tiers : DEFAULT_FAMILY_TIERS,
      dojoRow?.default_currency ?? "usd",
      await groupPayerId(supabase, data.dojoId, data.groupId),
    );

    if (quote.totalCents !== data.expectedTotalCents) {
      throw new Error(
        "The family total changed while you were confirming. Review the new amount and try again.",
      );
    }

    const designatedId = await groupPayerId(supabase, data.dojoId, data.groupId);
    const payerRow = rows.find((m) => m.id === designatedId);

    if (!payerRow) {
      return { ok: true, stripeUpdated: false, totalCents: quote.totalCents };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: subs } = await supabaseAdmin
      .from("member_subscriptions")
      .select("id, stripe_subscription_id, status")
      .eq("dojo_id", data.dojoId)
      .eq("member_id", payerRow.id)
      .in("status", ["active", "trialing", "past_due"]);
    const live = (subs ?? []).filter((s: any) => s.stripe_subscription_id);
    if (live.length === 0 || quote.interval === "one_time") {
      return { ok: true, stripeUpdated: false, totalCents: quote.totalCents };
    }

    const { hasStripeSecret, getPlatformStripe, getConnectErrorMessage, duesRequestOptions } =
      await import("@/lib/stripe-connect.server");
    if (!hasStripeSecret()) {
      return { ok: true, stripeUpdated: false, totalCents: quote.totalCents };
    }
    const { data: dojo } = await supabaseAdmin
      .from("dojos")
      .select("stripe_account_id")
      .eq("id", data.dojoId)
      .maybeSingle();
    if (!dojo?.stripe_account_id) {
      return { ok: true, stripeUpdated: false, totalCents: quote.totalCents };
    }
    // Dues subscriptions live on the PLATFORM account (destination charges).
    const opts = duesRequestOptions();
    const stripe = getPlatformStripe();

    try {
      for (const s of live as any[]) {
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
              name: `Family plan — ${quote.size} members (${quote.discountPercent}% family discount)`,
            },
            metadata: {
              dojo_id: data.dojoId,
              family_group_id: data.groupId,
              family_size: String(quote.size),
            },
          } as any,
          opts,
        );
        await stripe.subscriptions.update(
          s.stripe_subscription_id,
          {
            items: [{ id: item.id, price: price.id }],
            proration_behavior: "create_prorations",
            metadata: {
              ...(sub.metadata ?? {}),
              family_group_id: data.groupId,
              family_size: String(quote.size),
              family_discount_percent: String(quote.discountPercent),
            },
          } as any,
          opts,
        );
        // Verify the reprice landed before reporting success.
        const check: any = await stripe.subscriptions.retrieve(
          s.stripe_subscription_id,
          undefined,
          opts,
        );
        if (check?.items?.data?.[0]?.price?.id !== price.id) {
          throw new Error("the new family price is not active on the subscription");
        }
      }
    } catch (e) {
      throw new Error(
        `Stripe would not update the family subscription, so nothing was changed: ${getConnectErrorMessage(e)}`,
      );
    }


    return { ok: true, stripeUpdated: true, totalCents: quote.totalCents };
  });

export type MyFamilyPricing = {
  inFamily: boolean;
  groupName: string | null;
  isPayer: boolean;
  payerName: string | null;
  mode: FamilyPricingMode;
  quote: FamilyQuote | null;
  /** True when the gym passes the platform fee on, so the payer's charge is gross. */
  passPlatformFee: boolean;
};

/** The signed-in member's own family breakdown, for the portal. */
export const getMyFamilyPricing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { memberId: string }) => d)
  .handler(async ({ data, context }): Promise<MyFamilyPricing> => {
    const { supabase, userId } = context as any;
    const { data: me } = await supabase
      .from("members")
      .select(
        "id, dojo_id, user_id, family_group_id, plan_covered_by, selected_plan_id, family_groups:family_group_id(name)",
      )
      .eq("id", data.memberId)
      .maybeSingle();
    if (!me || me.user_id !== userId) throw new Error("Not allowed");

    const empty: MyFamilyPricing = {
      inFamily: false,
      groupName: null,
      isPayer: false,
      payerName: null,
      mode: "tiered",
      quote: null,
      passPlatformFee: false,
    };
    if (!me.family_group_id) return empty;

    const { data: dojo } = await supabase
      .from("dojos")
      .select("family_pricing_mode, default_currency")
      .eq("id", me.dojo_id)
      .maybeSingle();
    const { data: tierRows } = await supabase
      .from("family_discount_tiers")
      .select("min_members, discount_percent")
      .eq("dojo_id", me.dojo_id);
    const tiers = ((tierRows ?? []) as any[]).map((t) => ({
      min_members: Number(t.min_members),
      discount_percent: Number(t.discount_percent),
    }));

    // A family breakdown is by definition a read ACROSS members, and a member
    // may only read their own row -- on their own client this returned a
    // "family" of one, with no discount and a total covering nobody else.
    // Safe to elevate: ownership of this member row was verified above, and
    // only their own family group is ever loaded.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const rows = await loadGroup(supabaseAdmin, me.dojo_id, me.family_group_id);
    const myPayerId = await groupPayerId(supabaseAdmin, me.dojo_id, me.family_group_id);
    const quote = quoteFor(
      rows,
      tiers.length ? tiers : DEFAULT_FAMILY_TIERS,
      dojo?.default_currency ?? "usd",
      myPayerId,
    );
    const payerRow = rows.find((m) => m.id === myPayerId);


    return {
      inFamily: true,
      groupName: (me as any).family_groups?.name ?? null,
      isPayer: !!payerRow && payerRow.id === me.id,
      payerName: payerRow?.name ?? null,
      mode: (dojo?.family_pricing_mode as FamilyPricingMode) ?? "tiered",
      quote,
      passPlatformFee: !!(dojo as any)?.pass_platform_fee_to_members,
    };
  });

/* ---------------------------------------------------------------------------
 * Designated payer
 * ------------------------------------------------------------------------- */

export type PayerTransferResult = {
  ok: true;
  totalCents: number;
  oldPayer: { id: string; name: string } | null;
  newPayer: { id: string; name: string };
  oldSubscriptionCanceled: boolean;
  newSubscriptionCreated: boolean;
  /** True when the new payer has no saved card, so they must complete checkout. */
  needsCheckout: boolean;
};

/**
 * Move the family's billing onto a different member. The old payer's
 * subscription is cancelled and the new payer is charged the same discounted
 * family total. Everyone else stays covered and is never charged.
 */
export const transferFamilyPayer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      dojoId: string;
      groupId: string;
      newPayerId: string;
      expectedTotalCents?: number;
    }) => d,
  )
  .handler(async ({ data, context }): Promise<PayerTransferResult> => {
    const { supabase, userId } = context as any;
    await assertConfig(supabase, data.dojoId, userId);

    const rows = await loadGroup(supabase, data.dojoId, data.groupId);
    const newPayer = rows.find((m) => m.id === data.newPayerId);
    if (!newPayer) throw new Error("Choose a member of this family as the payer.");

    const { data: tierRows } = await supabase
      .from("family_discount_tiers")
      .select("min_members, discount_percent")
      .eq("dojo_id", data.dojoId);
    const tiers = ((tierRows ?? []) as any[]).map((t) => ({
      min_members: Number(t.min_members),
      discount_percent: clampPercent(Number(t.discount_percent)),
    }));
    const { data: dojoRow } = await supabase
      .from("dojos")
      .select("family_pricing_mode, default_currency")
      .eq("id", data.dojoId)
      .maybeSingle();
    const quote = quoteFor(
      rows,
      tiers.length ? tiers : DEFAULT_FAMILY_TIERS,
      dojoRow?.default_currency ?? "usd",
      data.newPayerId,
    );
    if (
      typeof data.expectedTotalCents === "number" &&
      data.expectedTotalCents !== quote.totalCents
    ) {
      throw new Error(
        "The family total changed while you were confirming. Review the new amount and try again.",
      );
    }

    const oldPayerId = await groupPayerId(supabase, data.dojoId, data.groupId);
    const oldPayer = rows.find((m) => m.id === oldPayerId) ?? null;
    if (oldPayerId === data.newPayerId) {
      return {
        ok: true,
        totalCents: quote.totalCents,
        oldPayer,
        newPayer: { id: newPayer.id, name: newPayer.name },
        oldSubscriptionCanceled: false,
        newSubscriptionCreated: false,
        needsCheckout: false,
      };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: dojo } = await supabaseAdmin
      .from("dojos")
      .select("stripe_account_id, pass_platform_fee_to_members")
      .eq("id", data.dojoId)
      .maybeSingle();
    const {
      hasStripeSecret,
      getPlatformStripe,
      getConnectErrorMessage,
      PLATFORM_FEE_PERCENT,
    subscriptionAppFeePercent,
      duesRequestOptions,
      cancelDuesSubscription,
      isDuesSubscriptionEnded,
    } = await import("@/lib/stripe-connect.server");
    // Dues subscriptions live on the PLATFORM account (destination charges).
    const opts = duesRequestOptions();
    const stripeReady = hasStripeSecret() && !!dojo?.stripe_account_id;

    const planId = newPayer.selected_plan_id ?? oldPayer?.selected_plan_id ?? null;

    // 1. Create the new payer's subscription FIRST, so a Stripe failure here
    //    leaves the family exactly as it was — never with nobody paying.
    let newSubscriptionCreated = false;
    let needsCheckout = true;
    let createdSubId: string | null = null;
    let createdCustomerId: string | null = null;
    if (stripeReady && planId && quote.interval !== "one_time" && quote.totalCents > 0) {
      const { data: pm } = await supabaseAdmin
        .from("member_payment_methods")
        .select("stripe_customer_id, stripe_payment_method_id")
        .eq("dojo_id", data.dojoId)
        .eq("member_id", data.newPayerId)
        .maybeSingle();
      if (pm?.stripe_customer_id && pm.stripe_payment_method_id) {
        const stripe = getPlatformStripe();
        const passFee = !!dojo?.pass_platform_fee_to_members;
        const grossCents = passFee
          ? quote.totalCents + Math.round((quote.totalCents * PLATFORM_FEE_PERCENT) / 100)
          : quote.totalCents;
        try {
          const price = await stripe.prices.create(
            {
              currency: quote.currency,
              unit_amount: grossCents,
              recurring: { interval: quote.interval as "month" | "year" },
              product_data: {
                name: `Family plan — ${quote.size} member${quote.size === 1 ? "" : "s"} (${quote.discountPercent}% family discount)`,
              },
              metadata: {
                dojo_id: data.dojoId,
                family_group_id: data.groupId,
                family_size: String(quote.size),
              },
            } as any,
            opts,
          );
          const sub = await stripe.subscriptions.create(
            {
              customer: pm.stripe_customer_id,
              items: [{ price: price.id }],
              default_payment_method: pm.stripe_payment_method_id,
              application_fee_percent: subscriptionAppFeePercent(quote.totalCents, grossCents, passFee),
              metadata: {
                dojo_id: data.dojoId,
                member_id: data.newPayerId,
                family_group_id: data.groupId,
                family_size: String(quote.size),
                family_discount_percent: String(quote.discountPercent),
              },
            } as any,
            opts,
          );
          createdSubId = (sub as any).id as string;
          createdCustomerId = pm.stripe_customer_id as string;
          newSubscriptionCreated = true;
          needsCheckout = false;
        } catch (err) {
          throw new Error(
            `Stripe would not start ${newPayer.name}'s subscription, so the payer was not changed and ${oldPayer?.name ?? "the current payer"} is still being billed: ${getConnectErrorMessage(err)}`,
          );
        }
      }
    }

    // 2. Stop billing the old payer. If this fails, undo the new subscription so
    //    the family is never left with two active subscriptions.
    const rollbackNewSub = async () => {
      if (!createdSubId) return;
      try {
        await getPlatformStripe().subscriptions.cancel(createdSubId, undefined, opts);
      } catch (err) {
        console.error("[transferFamilyPayer] rollback of new subscription failed", err);
      }
      createdSubId = null;
      newSubscriptionCreated = false;
      needsCheckout = true;
    };

    let oldSubscriptionCanceled = false;
    if (oldPayerId) {
      const { data: subs } = await supabaseAdmin
        .from("member_subscriptions")
        .select("id, stripe_subscription_id, status")
        .eq("dojo_id", data.dojoId)
        .eq("member_id", oldPayerId)
        .in("status", LIVE_SUB_STATUSES);
      const live = (subs ?? []) as any[];
      if (live.length > 0 && !stripeReady) {
        await rollbackNewSub();
        throw new Error(
          "Stripe isn't configured, so the current payer's subscription can't be stopped. Nothing was changed.",
        );
      }
      const stripe = stripeReady ? getPlatformStripe() : null;
      for (const s of live) {
        if (s.stripe_subscription_id && stripe) {
          try {
            // Verified cancel: throws unless Stripe confirms it's ended.
            await cancelDuesSubscription(stripe, s.stripe_subscription_id, "immediate");
            // Belt-and-braces: a family must never hold two live subscriptions.
            const ended = await isDuesSubscriptionEnded(stripe, s.stripe_subscription_id);
            if (!ended) throw new Error("the outgoing payer's subscription is still live");
            oldSubscriptionCanceled = true;
          } catch (err: any) {
            await rollbackNewSub();
            throw new Error(
              `Stripe would not cancel the current payer's subscription, so nothing was changed: ${getConnectErrorMessage(err)}`,
            );
          }
        }
        await supabaseAdmin
          .from("member_subscriptions")
          .update({ status: "canceled", canceled_at: new Date().toISOString() })
          .eq("id", s.id);
      }
    }

    // 3. Record the new designated payer and reshape coverage around them.
    await supabaseAdmin
      .from("members")
      .update({
        selected_plan_id: planId,
        plan_covered_by: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.newPayerId)
      .eq("dojo_id", data.dojoId);

    const others = rows.map((m) => m.id).filter((id) => id !== data.newPayerId);
    if (others.length > 0) {
      await supabaseAdmin
        .from("members")
        .update({ plan_covered_by: data.newPayerId, updated_at: new Date().toISOString() })
        .in("id", others)
        .eq("dojo_id", data.dojoId);
    }

    const { error: gErr } = await supabaseAdmin
      .from("family_groups")
      .update({ payer_member_id: data.newPayerId })
      .eq("id", data.groupId)
      .eq("dojo_id", data.dojoId);
    if (gErr) throw gErr;

    if (createdSubId) {
      await supabaseAdmin.from("member_subscriptions").insert({
        dojo_id: data.dojoId,
        member_id: data.newPayerId,
        plan_id: planId!,
        status: "active",
        stripe_subscription_id: createdSubId,
        stripe_customer_id: createdCustomerId,
      });
    }

    // 4. Assert the invariants explicitly: no covered member may keep a live
    //    subscription, and a cash payer's family may hold none at all.
    const { enforceFamilyBillingInvariants } = await import(
      "@/lib/family-invariants.server"
    );
    await enforceFamilyBillingInvariants({
      dojoId: data.dojoId,
      groupIds: [data.groupId],
      memberIds: [oldPayerId, data.newPayerId],
    });




    return {
      ok: true,
      totalCents: quote.totalCents,
      oldPayer,
      newPayer: { id: newPayer.id, name: newPayer.name },
      oldSubscriptionCanceled,
      newSubscriptionCreated,
      needsCheckout,
    };
  });

/**
 * Cancel a covered family member's own subscription so the family is never
 * double-charged alongside the designated payer.
 */
export const cancelCoveredMemberSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertConfig(supabase, data.dojoId, userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: subs } = await supabaseAdmin
      .from("member_subscriptions")
      .select("id, stripe_subscription_id")
      .eq("dojo_id", data.dojoId)
      .eq("member_id", data.memberId)
      .in("status", LIVE_SUB_STATUSES);
    const live = (subs ?? []) as any[];
    if (live.length === 0) return { ok: true, canceled: 0 };

    const { hasStripeSecret, getPlatformStripe, cancelDuesSubscription } = await import(
      "@/lib/stripe-connect.server"
    );

    let canceled = 0;
    for (const s of live) {
      if (s.stripe_subscription_id) {
        if (!hasStripeSecret()) {
          throw new Error(
            "Stripe isn't configured, so this subscription can't be stopped. Nothing was changed.",
          );
        }
        // Platform-account, verified cancel. Throws if Stripe won't confirm.
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
      canceled += 1;
    }
    return { ok: true, canceled };
  });

/* ---------------------------------------------------------------------------
 * Remove a member from a family
 * ------------------------------------------------------------------------- */

export type FamilyRemovalResult = {
  ok: true;
  removed: { id: string; name: string };
  remainingSize: number;
  totalCents: number;
  discountPercent: number;
  stripeUpdated: boolean;
  groupDissolved: boolean;
};

/**
 * Take a member out of a family group. The payer can never be removed this way
 * — staff must hand billing over first. The removed member is left with no
 * payment arrangement, flagged for follow-up, and the payer's subscription is
 * re-priced with proration.
 */
export const removeMemberFromFamily = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      dojoId: string;
      groupId: string;
      memberId: string;
      /** Total the payer will be charged after removal, as confirmed by staff. */
      expectedTotalCents: number;
      /** When only one member would remain: dissolve the group entirely. */
      dissolveIfLastOne?: boolean;
    }) => d,
  )
  .handler(async ({ data, context }): Promise<FamilyRemovalResult> => {
    const { supabase, userId } = context as any;
    await assertConfig(supabase, data.dojoId, userId);

    const rows = await loadGroup(supabase, data.dojoId, data.groupId);
    const target = rows.find((m) => m.id === data.memberId);
    if (!target) throw new Error("That member is not in this family group.");

    const payerId = await groupPayerId(supabase, data.dojoId, data.groupId);
    if (payerId && payerId === data.memberId) {
      throw new Error(
        "This member is the family's designated payer, so removing them would leave the family with nobody paying. Change the payer to another family member first, or dissolve the family.",
      );
    }

    const { data: dojoRow } = await supabase
      .from("dojos")
      .select("family_pricing_mode, default_currency")
      .eq("id", data.dojoId)
      .maybeSingle();
    const { data: tierRows } = await supabase
      .from("family_discount_tiers")
      .select("min_members, discount_percent")
      .eq("dojo_id", data.dojoId);
    const tiers = ((tierRows ?? []) as any[]).map((t) => ({
      min_members: Number(t.min_members),
      discount_percent: clampPercent(Number(t.discount_percent)),
    }));

    const remaining = rows.filter((m) => m.id !== data.memberId);
    const quote = quoteFor(
      remaining,
      tiers.length ? tiers : DEFAULT_FAMILY_TIERS,
      dojoRow?.default_currency ?? "usd",
      payerId,
    );
    const tiered = (dojoRow?.family_pricing_mode ?? "tiered") === "tiered";
    if (tiered && quote.totalCents !== data.expectedTotalCents) {
      throw new Error(
        "The family total changed while you were confirming. Review the new amounts and try again.",
      );
    }

    const { strandRemovedMember, pushFamilyTotalToPayer } = await import(
      "@/lib/family-actions.server"
    );
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // 1. The removed member loses the family and any coverage, visibly.
    await strandRemovedMember({
      dojoId: data.dojoId,
      memberId: data.memberId,
      memberName: target.name,
      actorUserId: userId ?? null,
    });

    // 2. Re-price the payer with proration.
    let stripeUpdated = false;
    if (tiered && remaining.length > 0) {
      const res = await pushFamilyTotalToPayer({
        dojoId: data.dojoId,
        groupId: data.groupId,
        payerId,
        quote,
      });
      stripeUpdated = res.stripeUpdated;
    }

    // 3. A one-member "family" gets no discount. Optionally dissolve it and put
    //    the last member back on their own individual plan.
    let groupDissolved = false;
    if (remaining.length <= 1 && data.dissolveIfLastOne) {
      const last = remaining[0];
      if (last) {
        await supabaseAdmin
          .from("members")
          .update({
            family_group_id: null,
            plan_covered_by: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", last.id)
          .eq("dojo_id", data.dojoId);
      }
      await supabaseAdmin
        .from("family_groups")
        .delete()
        .eq("id", data.groupId)
        .eq("dojo_id", data.dojoId);
      groupDissolved = true;
    }

    // 4. Assert the invariants for the group and the removed member.
    const { enforceFamilyBillingInvariants } = await import(
      "@/lib/family-invariants.server"
    );
    await enforceFamilyBillingInvariants({
      dojoId: data.dojoId,
      groupIds: groupDissolved ? [] : [data.groupId],
      memberIds: [data.memberId],
    });

    return {
      ok: true,
      removed: { id: target.id, name: target.name },
      remainingSize: remaining.length,
      totalCents: quote.totalCents,
      discountPercent: quote.discountPercent,
      stripeUpdated,
      groupDissolved,
    };
  });


/* ---------------------------------------------------------------------------
 * Merge two family groups
 * ------------------------------------------------------------------------- */

async function tiersFor(supabase: any, dojoId: string) {
  const { data: tierRows } = await supabase
    .from("family_discount_tiers")
    .select("min_members, discount_percent")
    .eq("dojo_id", dojoId);
  const tiers = ((tierRows ?? []) as any[]).map((t) => ({
    min_members: Number(t.min_members),
    discount_percent: clampPercent(Number(t.discount_percent)),
  }));
  return tiers.length ? tiers : DEFAULT_FAMILY_TIERS;
}

export type FamilyMergePreview = {
  mode: FamilyPricingMode;
  groups: {
    id: string;
    name: string;
    size: number;
    payer: { id: string; name: string } | null;
    quote: FamilyQuote;
  }[];
  /** The combined family, priced at the new tier. */
  merged: FamilyQuote;
  candidates: { id: string; name: string; groupId: string; isPayer: boolean }[];
  /** Payer whose subscription would be cancelled as redundant. */
  redundantPayers: { id: string; name: string; hasLiveSubscription: boolean }[];
};

/** Before/after for merging two families, for explicit confirmation. */
export const getFamilyMergePreview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      dojoId: string;
      groupIds: string[];
      survivingPayerId?: string | null;
    }) => d,
  )
  .handler(async ({ data, context }): Promise<FamilyMergePreview> => {
    const { supabase, userId } = context as any;
    await assertStaff(supabase, data.dojoId, userId);

    const ids = Array.from(new Set(data.groupIds)).filter(Boolean);
    if (ids.length !== 2) throw new Error("Choose exactly two family groups to merge.");

    const { data: groupRows, error: gErr } = await supabase
      .from("family_groups")
      .select("id, name, payer_member_id")
      .eq("dojo_id", data.dojoId)
      .in("id", ids);
    if (gErr) throw gErr;
    if ((groupRows ?? []).length !== 2) throw new Error("Family group not found.");

    const tiers = await tiersFor(supabase, data.dojoId);
    const { data: dojoRow } = await supabase
      .from("dojos")
      .select("family_pricing_mode, default_currency")
      .eq("id", data.dojoId)
      .maybeSingle();
    const currency = dojoRow?.default_currency ?? "usd";

    const groups: FamilyMergePreview["groups"] = [];
    const candidates: FamilyMergePreview["candidates"] = [];
    let allRows: GroupRow[] = [];
    for (const g of (groupRows ?? []) as any[]) {
      const rows = await loadGroup(supabase, data.dojoId, g.id);
      allRows = allRows.concat(rows);
      const payerRow = rows.find((m) => m.id === g.payer_member_id) ?? null;
      groups.push({
        id: g.id,
        name: g.name,
        size: rows.length,
        payer: payerRow ? { id: payerRow.id, name: payerRow.name } : null,
        quote: quoteFor(rows, tiers, currency, g.payer_member_id ?? null),
      });
      for (const m of rows) {
        candidates.push({
          id: m.id,
          name: m.name,
          groupId: g.id,
          isPayer: m.id === g.payer_member_id,
        });
      }
    }
    candidates.sort((a, b) => a.name.localeCompare(b.name));

    const survivingPayerId =
      data.survivingPayerId ?? groups.find((g) => g.payer)?.payer?.id ?? null;
    const redundant = candidates.filter(
      (c) => c.isPayer && c.id !== survivingPayerId,
    );
    const redundantPayers: FamilyMergePreview["redundantPayers"] = [];
    for (const r of redundant) {
      const { count } = await supabase
        .from("member_subscriptions")
        .select("id", { count: "exact", head: true })
        .eq("dojo_id", data.dojoId)
        .eq("member_id", r.id)
        .in("status", LIVE_SUB_STATUSES);
      redundantPayers.push({
        id: r.id,
        name: r.name,
        hasLiveSubscription: (count ?? 0) > 0,
      });
    }

    return {
      mode: (dojoRow?.family_pricing_mode as FamilyPricingMode) ?? "tiered",
      groups,
      merged: quoteFor(allRows, tiers, currency, survivingPayerId),
      candidates,
      redundantPayers,
    };
  });

export type FamilyMergeResult = {
  ok: true;
  groupId: string;
  size: number;
  totalCents: number;
  discountPercent: number;
  survivingPayer: { id: string; name: string };
  canceledSubscriptions: number;
  stripeUpdated: boolean;
};

/**
 * Fold one family group into another: all members move across, the redundant
 * payer's subscription is cancelled, the discount tier is recalculated for the
 * new size and the surviving payer's subscription is re-priced with proration.
 * Stripe work happens before any database change, and is rolled back if a
 * later Stripe call fails, so a family is never left with two subscriptions
 * or none.
 */
export const mergeFamilyGroups = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      dojoId: string;
      /** The group that survives. */
      targetGroupId: string;
      /** The group folded into it and then deleted. */
      sourceGroupId: string;
      survivingPayerId: string;
      expectedTotalCents: number;
    }) => d,
  )
  .handler(async ({ data, context }): Promise<FamilyMergeResult> => {
    const { supabase, userId } = context as any;
    await assertConfig(supabase, data.dojoId, userId);
    if (data.targetGroupId === data.sourceGroupId) {
      throw new Error("Choose two different family groups.");
    }

    const { data: groupRows, error: gErr } = await supabase
      .from("family_groups")
      .select("id, name, payer_member_id")
      .eq("dojo_id", data.dojoId)
      .in("id", [data.targetGroupId, data.sourceGroupId]);
    if (gErr) throw gErr;
    const target = ((groupRows ?? []) as any[]).find((g) => g.id === data.targetGroupId);
    const source = ((groupRows ?? []) as any[]).find((g) => g.id === data.sourceGroupId);
    if (!target || !source) throw new Error("Family group not found.");

    const targetRows = await loadGroup(supabase, data.dojoId, data.targetGroupId);
    const sourceRows = await loadGroup(supabase, data.dojoId, data.sourceGroupId);
    const allRows = [...targetRows, ...sourceRows];
    const survivor = allRows.find((m) => m.id === data.survivingPayerId);
    if (!survivor) {
      throw new Error("The surviving payer must be a member of one of these families.");
    }

    const { data: dojoRow } = await supabase
      .from("dojos")
      .select("family_pricing_mode, default_currency")
      .eq("id", data.dojoId)
      .maybeSingle();
    const tiered = (dojoRow?.family_pricing_mode ?? "tiered") === "tiered";
    const tiers = await tiersFor(supabase, data.dojoId);
    const mergedQuote = quoteFor(
      allRows,
      tiers,
      dojoRow?.default_currency ?? "usd",
      data.survivingPayerId,
    );
    const beforeQuote = quoteFor(
      survivor.id === target.payer_member_id ? targetRows : sourceRows,
      tiers,
      dojoRow?.default_currency ?? "usd",
      data.survivingPayerId,
    );
    if (tiered && mergedQuote.totalCents !== data.expectedTotalCents) {
      throw new Error(
        "The family total changed while you were confirming. Review the new amounts and try again.",
      );
    }

    const { pushFamilyTotalToPayer } = await import("@/lib/family-actions.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // 1. Re-price the surviving payer first. A failure here changes nothing.
    let stripeUpdated = false;
    if (tiered) {
      const res = await pushFamilyTotalToPayer({
        dojoId: data.dojoId,
        groupId: data.targetGroupId,
        payerId: data.survivingPayerId,
        quote: mergedQuote,
      });
      stripeUpdated = res.stripeUpdated;
    }

    const rollbackPrice = async () => {
      if (!stripeUpdated) return;
      try {
        await pushFamilyTotalToPayer({
          dojoId: data.dojoId,
          groupId: data.targetGroupId,
          payerId: data.survivingPayerId,
          quote: beforeQuote,
        });
      } catch (e) {
        console.error("[mergeFamilyGroups] rollback of payer price failed", e);
      }
    };

    // 2. Cancel the redundant payer's subscription so the family is only
    //    charged once. On failure, undo the re-pricing above.
    const redundantPayerIds = [target.payer_member_id, source.payer_member_id]
      .filter((id): id is string => !!id && id !== data.survivingPayerId);
    let canceledSubscriptions = 0;
    if (redundantPayerIds.length > 0) {
      const { data: subs } = await supabaseAdmin
        .from("member_subscriptions")
        .select("id, member_id, stripe_subscription_id")
        .eq("dojo_id", data.dojoId)
        .in("member_id", redundantPayerIds)
        .in("status", [...LIVE_SUB_STATUSES]);
      const live = (subs ?? []) as any[];
      if (live.length > 0) {
        const {
          hasStripeSecret,
          getPlatformStripe,
          getConnectErrorMessage,
          cancelDuesSubscription,
          isDuesSubscriptionEnded,
        } = await import("@/lib/stripe-connect.server");
        for (const s of live) {
          if (s.stripe_subscription_id) {
            if (!hasStripeSecret()) {
              await rollbackPrice();
              throw new Error(
                "Stripe isn't configured, so the other payer's subscription can't be stopped. Nothing was changed.",
              );
            }
            try {
              // Platform account, verified — the merged family must end up
              // with exactly one live subscription.
              const stripe = getPlatformStripe();
              await cancelDuesSubscription(stripe, s.stripe_subscription_id, "immediate");
              const ended = await isDuesSubscriptionEnded(
                stripe,
                s.stripe_subscription_id,
              );
              if (!ended) throw new Error("it is still live");
            } catch (err: any) {
              await rollbackPrice();
              throw new Error(
                `Stripe would not cancel the other payer's subscription, so nothing was changed: ${getConnectErrorMessage(err)}`,
              );
            }
          }
          await supabaseAdmin
            .from("member_subscriptions")
            .update({ status: "canceled", canceled_at: new Date().toISOString() })
            .eq("id", s.id);
          canceledSubscriptions += 1;
        }
      }
    }

    // 3. Move everyone into the surviving group and reshape coverage.
    const now = new Date().toISOString();
    const { data: payerRow } = await supabaseAdmin
      .from("members")
      .select("payment_status, payment_method")
      .eq("id", data.survivingPayerId)
      .maybeSingle();
    const payerMethod = ((payerRow as any)?.payment_method ?? "card") as "card" | "cash";

    const { error: moveErr } = await supabaseAdmin
      .from("members")
      .update({ family_group_id: data.targetGroupId, updated_at: now })
      .eq("dojo_id", data.dojoId)
      .in(
        "id",
        allRows.map((m) => m.id),
      );
    if (moveErr) throw moveErr;

    await supabaseAdmin
      .from("members")
      .update({ plan_covered_by: null, updated_at: now })
      .eq("id", data.survivingPayerId)
      .eq("dojo_id", data.dojoId);

    const others = allRows.map((m) => m.id).filter((id) => id !== data.survivingPayerId);
    if (others.length > 0) {
      await supabaseAdmin
        .from("members")
        .update({
          plan_covered_by: data.survivingPayerId,
          ...(tiered ? {} : { selected_plan_id: null }),
          payment_method: payerMethod,
          payment_status: (payerRow as any)?.payment_status ?? "none",
          payment_status_updated_at: now,
          updated_at: now,
        })
        .eq("dojo_id", data.dojoId)
        .in("id", others);
    }

    const { error: setPayerErr } = await supabaseAdmin
      .from("family_groups")
      .update({ payer_member_id: data.survivingPayerId })
      .eq("id", data.targetGroupId)
      .eq("dojo_id", data.dojoId);
    if (setPayerErr) throw setPayerErr;

    const { error: clearSourcePayerErr } = await supabaseAdmin
      .from("family_groups")
      .update({ payer_member_id: null })
      .eq("id", data.sourceGroupId)
      .eq("dojo_id", data.dojoId);
    if (clearSourcePayerErr) throw clearSourcePayerErr;

    const { error: deleteSourceErr } = await supabaseAdmin
      .from("family_groups")
      .delete()
      .eq("id", data.sourceGroupId)
      .eq("dojo_id", data.dojoId);
    if (deleteSourceErr) {
      throw new Error(`The families were merged, but the empty source group could not be deleted: ${deleteSourceErr.message}`);
    }

    const { count: sourceMembers, error: sourceCheckErr } = await supabaseAdmin
      .from("members")
      .select("id", { count: "exact", head: true })
      .eq("dojo_id", data.dojoId)
      .eq("family_group_id", data.sourceGroupId);
    if (sourceCheckErr) throw sourceCheckErr;
    const { data: sourceStillExists, error: sourceExistsErr } = await supabaseAdmin
      .from("family_groups")
      .select("id")
      .eq("id", data.sourceGroupId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (sourceExistsErr) throw sourceExistsErr;
    if ((sourceMembers ?? 0) !== 0 || sourceStillExists) {
      throw new Error("The empty source family group was not removed. Please try again.");
    }

    // 4. Assert the invariants across the merged family.
    const { enforceFamilyBillingInvariants } = await import(
      "@/lib/family-invariants.server"
    );
    await enforceFamilyBillingInvariants({
      dojoId: data.dojoId,
      groupIds: [data.targetGroupId],
      memberIds: allRows.map((m) => m.id),
    });

    return {

      ok: true,
      groupId: data.targetGroupId,
      size: mergedQuote.size,
      totalCents: mergedQuote.totalCents,
      discountPercent: mergedQuote.discountPercent,
      survivingPayer: { id: survivor.id, name: survivor.name },
      canceledSubscriptions,
      stripeUpdated,
    };
  });
