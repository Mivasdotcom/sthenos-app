/**
 * Price-change pricing helpers.
 *
 * These live outside price-changes.functions.ts because server-function
 * splitting removes runtime module-scope siblings from that file.
 */
import { LIVE_STATUSES, BILLABLE_MEMBER_STATUSES } from "./subscription-statuses";
import type { PriceChangePreview, PriceChangeRow } from "./price-changes.functions";

export async function loadContext(dojoId: string, planId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [{ data: dojo }, { data: plan }, { data: tierRows }] = await Promise.all([
    supabaseAdmin
      .from("dojos")
      .select(
        "id, default_currency, pass_platform_fee_to_members, price_change_notice_days, family_pricing_mode",
      )
      .eq("id", dojoId)
      .maybeSingle(),
    supabaseAdmin
      .from("dojo_plans")
      .select("id, name, price_cents, currency, interval, plan_type")
      .eq("id", planId)
      .eq("dojo_id", dojoId)
      .maybeSingle(),
    supabaseAdmin
      .from("family_discount_tiers")
      .select("min_members, discount_percent")
      .eq("dojo_id", dojoId),
  ]);
  if (!plan) throw new Error("Plan not found");
  return { supabaseAdmin, dojo, plan, tierRows: (tierRows ?? []) as any[] };
}

/** Everything needed to price a member (and their family) before/after. */
export async function buildPreview(args: {
  dojoId: string;
  planId: string;
  newPriceCents: number;
  noticeDaysOverride?: number | null;
}): Promise<PriceChangePreview> {
  const { supabaseAdmin, dojo, plan, tierRows } = await loadContext(args.dojoId, args.planId);
  const { computeFamilyQuote, DEFAULT_FAMILY_TIERS } = await import("@/lib/family-pricing");
  const { grossChargeCents } = await import("@/lib/platform-fee");
  const { subscriptionPeriodEnd } = await import("@/lib/stripe-connect.server");

  const tiers = tierRows.length
    ? tierRows.map((t) => ({
        min_members: Number(t.min_members),
        discount_percent: Number(t.discount_percent),
      }))
    : DEFAULT_FAMILY_TIERS;
  const tieredFamilies = (dojo?.family_pricing_mode ?? "tiered") === "tiered";
  const passFee = !!dojo?.pass_platform_fee_to_members;
  const currency = (plan.currency ?? dojo?.default_currency ?? "usd").toLowerCase();
  const interval = plan.interval ?? "month";
  const noticeDays = Math.max(
    0,
    Math.round(args.noticeDaysOverride ?? Number(dojo?.price_change_notice_days ?? 30)),
  );
  const effectiveAt = new Date(Date.now() + noticeDays * 86400000).toISOString();

  // Every member of the dojo, so family totals can be recomputed exactly.
  const { data: allRows } = await supabaseAdmin
    .from("members")
    .select(
      "id, name, status, payment_method, family_group_id, plan_price_cents, selected_plan_id, dojo_plans:selected_plan_id(id, name, price_cents, currency, interval)",
    )
    .eq("dojo_id", args.dojoId)
    .order("name");
  const all = (allRows ?? []) as any[];

  const priceNow = (m: any) =>
    Number(m.plan_price_cents ?? m.dojo_plans?.price_cents ?? 0);
  const priceAfter = (m: any) =>
    m.selected_plan_id === args.planId ? args.newPriceCents : priceNow(m);

  // Designated payers, so a family payer's real charge is the family total.
  const groupIds = Array.from(
    new Set(all.map((m) => m.family_group_id).filter(Boolean)),
  ) as string[];
  const payerByGroup = new Map<string, string | null>();
  if (groupIds.length) {
    const { data: groups } = await supabaseAdmin
      .from("family_groups")
      .select("id, payer_member_id")
      .eq("dojo_id", args.dojoId)
      .in("id", groupIds);
    for (const g of (groups ?? []) as any[]) {
      payerByGroup.set(g.id as string, (g.payer_member_id as string | null) ?? null);
    }
  }

  const familyQuote = (groupId: string, after: boolean) => {
    const members = all.filter((m) => m.family_group_id === groupId);
    // A family bills on ONE interval — the payer's plan interval. Members on a
    // different interval are normalised into it before summing. Non-paying
    // members (trial, paused…) are dropped by computeFamilyQuote.
    const payerId = payerByGroup.get(groupId) ?? null;
    const payerPlan = members.find((m) => m.id === payerId)?.dojo_plans;
    const famInterval =
      (payerPlan?.interval as string) ??
      (members.find((m) => m.dojo_plans)?.dojo_plans?.interval as string) ??
      interval;
    return computeFamilyQuote({
      members: members.map((m) => ({
        id: m.id,
        name: m.name,
        status: m.status,
        priceCents: after ? priceAfter(m) : priceNow(m),
        interval: (m.dojo_plans?.interval as string) ?? famInterval,
      })),
      tiers,
      currency: (payerPlan?.currency as string) ?? currency,
      interval: famInterval,
    });
  };

  // Members directly on the plan, plus family payers whose total moves.
  const onPlan = all.filter(
    (m) =>
      m.selected_plan_id === args.planId &&
      BILLABLE_MEMBER_STATUSES.includes(m.status),
  );
  const affectedIds = new Set<string>();
  for (const m of onPlan) {
    const groupId = m.family_group_id as string | null;
    const payerId = groupId ? payerByGroup.get(groupId) ?? null : null;
    if (groupId && tieredFamilies && payerId) affectedIds.add(payerId);
    else affectedIds.add(m.id);
  }

  const ids = Array.from(affectedIds);
  const subsByMember = new Map<string, any>();
  if (ids.length) {
    const { data: subs } = await supabaseAdmin
      .from("member_subscriptions")
      .select("member_id, stripe_subscription_id, current_period_end, status")
      .eq("dojo_id", args.dojoId)
      .in("member_id", ids)
      .in("status", [...LIVE_STATUSES]);
    for (const s of (subs ?? []) as any[]) subsByMember.set(s.member_id as string, s);
  }

  const rows: PriceChangeRow[] = [];
  for (const id of ids) {
    const m = all.find((x) => x.id === id);
    if (!m) continue;
    const groupId = m.family_group_id as string | null;
    const isFamilyPayer =
      !!groupId && tieredFamilies && payerByGroup.get(groupId) === m.id;
    let oldCents: number;
    let newCents: number;
    let coveredCount = 0;
    if (isFamilyPayer && groupId) {
      const before = familyQuote(groupId, false);
      const after = familyQuote(groupId, true);
      oldCents = before.totalCents;
      newCents = after.totalCents;
      coveredCount = Math.max(0, before.size - 1);
    } else {
      oldCents = priceNow(m);
      newCents = priceAfter(m);
    }
    const sub = subsByMember.get(id);
    rows.push({
      memberId: id,
      name: m.name as string,
      status: m.status as string,
      paymentMethod: (m.payment_method as string) ?? "card",
      isFamilyPayer,
      coveredCount,
      oldChargeCents: oldCents,
      newChargeCents: newCents,
      oldGrossCents: grossChargeCents(oldCents, passFee),
      newGrossCents: grossChargeCents(newCents, passFee),
      nextRenewalAt: sub?.current_period_end ?? null,
      hasLiveSubscription: !!sub?.stripe_subscription_id,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  const changing = rows.filter((r) => r.newChargeCents !== r.oldChargeCents);
  const oldTotal = changing.reduce((s, r) => s + r.oldGrossCents, 0);
  const newTotal = changing.reduce((s, r) => s + r.newGrossCents, 0);

  return {
    plan: {
      id: plan.id as string,
      name: plan.name as string,
      currency,
      interval,
      oldPriceCents: Number(plan.price_cents ?? 0),
      newPriceCents: args.newPriceCents,
    },
    passFee,
    noticeDays,
    effectiveAt,
    counts: {
      onPlan: onPlan.length,
      changing: changing.length,
      paused: rows.filter((r) => r.status === "paused").length,
      cash: rows.filter((r) => r.paymentMethod === "cash").length,
      familyPayers: rows.filter((r) => r.isFamilyPayer).length,
    },
    rows,
    totals: {
      oldCents: oldTotal,
      newCents: newTotal,
      diffCents: newTotal - oldTotal,
      currency,
      interval,
    },
  };
}
