/**
 * Server-only: detect members whose ACTUAL billed amount differs from what the
 * gym's current settings say it should be.
 *
 * Two distinct reasons are surfaced:
 *  - "older_plan_price": the member has a locked-in price different from the
 *    plan's current price.
 *  - "platform_fee": the amount billed does not reflect the gym's current
 *    `pass_platform_fee_to_members` setting (the classic case: they joined
 *    before the toggle was switched on, so no fee is added on top).
 *
 * Detection compares the subscription's real unit amount (falling back to the
 * most recent paid invoice) against grossChargeCents(currentPrice, passFee) —
 * never against a locked price column, which is null for most members.
 */
import { LIVE_STATUSES } from "./subscription-statuses";
import { PLATFORM_FEE_PERCENT, grossChargeCents, subscriptionAppFeePercent } from "./platform-fee";

export type DriftReason = "older_plan_price" | "platform_fee";

export type PricingDriftRow = {
  memberId: string;
  name: string;
  status: string;
  planName: string;
  currency: string;
  interval: string;
  /** Base amount (excl. platform fee) they should be priced at. */
  basePriceCents: number;
  /** Locked-in price, when set. */
  lockedPriceCents: number | null;
  /** The plan's current price. */
  currentPlanPriceCents: number;
  /** What they are actually billed today. */
  currentChargeCents: number;
  /** What they would be billed under current settings. */
  targetChargeCents: number;
  /** What the gym nets today, after the platform fee. */
  currentNetCents: number;
  /** What the gym would net. */
  targetNetCents: number;
  reasons: DriftReason[];
  /** Where currentChargeCents came from. */
  source: "subscription" | "invoice";
  pendingPriceCents: number | null;
  pendingEffectiveAt: string | null;
};

export type PricingDriftReport = {
  passFee: boolean;
  noticeDays: number;
  effectiveAt: string;
  stripeReady: boolean;
  /** Members with a live subscription we could measure. */
  checked: number;
  rows: PricingDriftRow[];
  totals: { currentNetCents: number; targetNetCents: number; diffCents: number; currency: string };
};

function netCents(chargeCents: number, appFeePercent: number): number {
  return chargeCents - Math.round((chargeCents * appFeePercent) / 100);
}

export async function loadPricingDrift(args: { dojoId: string }): Promise<PricingDriftReport> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { hasStripeSecret, getPlatformStripe, duesRequestOptions } = await import(
    "@/lib/stripe-connect.server"
  );

  const { data: dojo } = await supabaseAdmin
    .from("dojos")
    .select(
      "id, default_currency, pass_platform_fee_to_members, price_change_notice_days, stripe_account_id",
    )
    .eq("id", args.dojoId)
    .maybeSingle();

  const passFee = !!(dojo as any)?.pass_platform_fee_to_members;
  const noticeDays = Math.max(
    0,
    Math.round(Number((dojo as any)?.price_change_notice_days ?? 30)),
  );
  const effectiveAt = new Date(Date.now() + noticeDays * 86400000).toISOString();
  const fallbackCurrency = ((dojo as any)?.default_currency as string) ?? "usd";

  const { data: subRows } = await supabaseAdmin
    .from("member_subscriptions")
    .select("member_id, stripe_subscription_id, status")
    .eq("dojo_id", args.dojoId)
    .in("status", [...LIVE_STATUSES])
    .limit(500);
  const subs = (subRows ?? []) as any[];
  if (!subs.length) {
    return {
      passFee,
      noticeDays,
      effectiveAt,
      stripeReady: hasStripeSecret(),
      checked: 0,
      rows: [],
      totals: { currentNetCents: 0, targetNetCents: 0, diffCents: 0, currency: fallbackCurrency },
    };
  }

  const memberIds = Array.from(new Set(subs.map((s) => s.member_id as string)));
  const { data: memberRows } = await supabaseAdmin
    .from("members")
    .select(
      "id, name, status, plan_price_cents, pending_price_cents, pending_price_effective_at, selected_plan_id, dojo_plans:selected_plan_id(name, price_cents, currency, interval)",
    )
    .eq("dojo_id", args.dojoId)
    .in("id", memberIds)
    .order("name");
  const members = (memberRows ?? []) as any[];

  // Most recent paid invoice per member, used when Stripe can't be read.
  const { data: invRows } = await supabaseAdmin
    .from("invoices")
    .select("member_id, amount_cents, currency, status, paid_at, created_at")
    .eq("dojo_id", args.dojoId)
    .in("member_id", memberIds)
    .eq("status", "paid")
    .order("created_at", { ascending: false })
    .limit(1000);
  const lastInvoice = new Map<string, any>();
  for (const inv of (invRows ?? []) as any[]) {
    if (!lastInvoice.has(inv.member_id)) lastInvoice.set(inv.member_id, inv);
  }

  const stripeReady = hasStripeSecret() && !!(dojo as any)?.stripe_account_id;
  const stripe = stripeReady ? getPlatformStripe() : null;
  const opts = duesRequestOptions();
  const subByMember = new Map<string, any>();
  for (const s of subs) if (!subByMember.has(s.member_id)) subByMember.set(s.member_id, s);

  const rows: PricingDriftRow[] = [];
  let checked = 0;

  for (const m of members) {
    const plan = m.dojo_plans ?? null;
    const interval = (plan?.interval as string) ?? "month";
    if (interval === "one_time") continue;
    const currentPlanPrice = Number(plan?.price_cents ?? 0);
    const locked = m.plan_price_cents == null ? null : Number(m.plan_price_cents);
    const basePrice = locked ?? currentPlanPrice;
    if (!basePrice && !currentPlanPrice) continue;
    let currency = ((plan?.currency as string) ?? fallbackCurrency).toLowerCase();

    const sub = subByMember.get(m.id);
    let currentCharge = 0;
    let source: "subscription" | "invoice" = "subscription";
    let currentAppFeePercent = PLATFORM_FEE_PERCENT;

    if (stripe && sub?.stripe_subscription_id) {
      try {
        const live: any = await stripe.subscriptions.retrieve(
          sub.stripe_subscription_id as string,
          undefined,
          opts,
        );
        const item = live?.items?.data?.[0];
        currentCharge = Number(item?.price?.unit_amount ?? 0);
        if (item?.price?.currency) currency = String(item.price.currency).toLowerCase();
        currentAppFeePercent = Number(live?.application_fee_percent ?? PLATFORM_FEE_PERCENT);
      } catch (e) {
        console.error("[pricing-drift] could not read subscription", sub.stripe_subscription_id, e);
      }
    }
    if (!currentCharge) {
      const inv = lastInvoice.get(m.id);
      if (inv) {
        currentCharge = Number(inv.amount_cents ?? 0);
        if (inv.currency) currency = String(inv.currency).toLowerCase();
        source = "invoice";
      }
    }
    if (!currentCharge) continue;
    checked += 1;

    // Under current settings, everyone should be on the plan's current price,
    // grossed up when the gym passes the platform fee on.
    const targetCharge = grossChargeCents(currentPlanPrice || basePrice, passFee);
    if (currentCharge === targetCharge) continue;

    const reasons: DriftReason[] = [];
    if (locked != null && locked !== currentPlanPrice) reasons.push("older_plan_price");
    const feeExpected = grossChargeCents(currentPlanPrice || basePrice, passFee);
    const feeUnexpected = grossChargeCents(currentPlanPrice || basePrice, !passFee);
    if (currentCharge === feeUnexpected && feeUnexpected !== feeExpected) {
      reasons.push("platform_fee");
    }
    if (!reasons.length) reasons.push("platform_fee");

    const targetAppFeePercent = subscriptionAppFeePercent(
      currentPlanPrice || basePrice,
      targetCharge,
      passFee,
    );

    rows.push({
      memberId: m.id as string,
      name: m.name as string,
      status: (m.status as string) ?? "active",
      planName: (plan?.name as string) ?? "Membership",
      currency,
      interval,
      basePriceCents: currentPlanPrice || basePrice,
      lockedPriceCents: locked,
      currentPlanPriceCents: currentPlanPrice,
      currentChargeCents: currentCharge,
      targetChargeCents: targetCharge,
      currentNetCents: netCents(currentCharge, currentAppFeePercent),
      targetNetCents: netCents(targetCharge, targetAppFeePercent),
      reasons,
      source,
      pendingPriceCents: m.pending_price_cents == null ? null : Number(m.pending_price_cents),
      pendingEffectiveAt: (m.pending_price_effective_at as string | null) ?? null,
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  const currentNet = rows.reduce((s, r) => s + r.currentNetCents, 0);
  const targetNet = rows.reduce((s, r) => s + r.targetNetCents, 0);

  return {
    passFee,
    noticeDays,
    effectiveAt,
    stripeReady,
    checked,
    rows,
    totals: {
      currentNetCents: currentNet,
      targetNetCents: targetNet,
      diffCents: targetNet - currentNet,
      currency: rows[0]?.currency ?? fallbackCurrency,
    },
  };
}
