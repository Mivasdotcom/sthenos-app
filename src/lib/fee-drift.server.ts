/**
 * Server-only: detect members whose LIVE Stripe subscription does not reflect
 * the gym's current `pass_platform_fee_to_members` setting.
 *
 * WHY THIS EXISTS
 * The pass-through setting is only read when a subscription is CREATED. Stripe
 * then charges that amount for ever, so toggling the setting silently leaves
 * older members on the old arrangement and the gym receives different money for
 * identical plans. This module surfaces that drift; migration always goes
 * through the price-change machinery (pending_price_cents + the nightly sweep),
 * so nobody is ever charged a new amount mid-cycle or without notice.
 */
import { LIVE_STATUSES } from "./subscription-statuses";
import { PLATFORM_FEE_PERCENT, grossChargeCents, subscriptionAppFeePercent } from "./platform-fee";

export type FeeDriftRow = {
  memberId: string;
  name: string;
  planName: string;
  currency: string;
  interval: string;
  paymentMethod: string;
  isFamilyPayer: boolean;
  /** Base amount (excl. platform fee) the member is priced at. */
  baseCents: number;
  /** What Stripe charges them today. */
  currentChargeCents: number;
  /** What they would be charged under the gym's current setting. */
  targetChargeCents: number;
  /** What the gym actually nets today, after the platform fee. */
  currentNetCents: number;
  /** What the gym would net under the current setting. */
  targetNetCents: number;
  /** Whether their subscription currently includes the passed-on fee. */
  feeIncludedNow: boolean;
  nextRenewalAt: string | null;
  pendingPriceCents: number | null;
  pendingEffectiveAt: string | null;
};

export type FeeDriftReport = {
  /** The setting the report is measured against. */
  passFee: boolean;
  noticeDays: number;
  effectiveAt: string;
  stripeReady: boolean;
  checked: number;
  rows: FeeDriftRow[];
  totals: {
    currentNetCents: number;
    targetNetCents: number;
    diffCents: number;
    currency: string;
  };
};

function netCents(chargeCents: number, appFeePercent: number): number {
  return chargeCents - Math.round((chargeCents * appFeePercent) / 100);
}

/**
 * Build the drift report. `passFeeOverride` lets staff preview the impact of
 * flipping the setting before it is saved.
 */
export async function loadFeeDrift(args: {
  dojoId: string;
  passFeeOverride?: boolean | null;
  noticeDaysOverride?: number | null;
}): Promise<FeeDriftReport> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { hasStripeSecret, getPlatformStripe, duesRequestOptions, subscriptionPeriodEnd } =
    await import("@/lib/stripe-connect.server");
  const { familyTotalForPayer, familyBillingRole } = await import("@/lib/family-pricing.server");

  const { data: dojo } = await supabaseAdmin
    .from("dojos")
    .select(
      "id, default_currency, pass_platform_fee_to_members, price_change_notice_days, stripe_account_id",
    )
    .eq("id", args.dojoId)
    .maybeSingle();

  const passFee =
    args.passFeeOverride == null
      ? !!(dojo as any)?.pass_platform_fee_to_members
      : !!args.passFeeOverride;
  const noticeDays = Math.max(
    0,
    Math.round(args.noticeDaysOverride ?? Number((dojo as any)?.price_change_notice_days ?? 30)),
  );
  const effectiveAt = new Date(Date.now() + noticeDays * 86400000).toISOString();
  const fallbackCurrency = ((dojo as any)?.default_currency as string) ?? "usd";

  const { data: subRows } = await supabaseAdmin
    .from("member_subscriptions")
    .select("member_id, stripe_subscription_id, status, current_period_end")
    .eq("dojo_id", args.dojoId)
    .in("status", [...LIVE_STATUSES])
    .not("stripe_subscription_id", "is", null)
    .limit(400);
  const subs = (subRows ?? []) as any[];

  const stripeReady = hasStripeSecret() && !!(dojo as any)?.stripe_account_id && subs.length > 0;
  if (!stripeReady) {
    return {
      passFee,
      noticeDays,
      effectiveAt,
      stripeReady: false,
      checked: 0,
      rows: [],
      totals: { currentNetCents: 0, targetNetCents: 0, diffCents: 0, currency: fallbackCurrency },
    };
  }

  const memberIds = Array.from(new Set(subs.map((s) => s.member_id as string)));
  const { data: memberRows } = await supabaseAdmin
    .from("members")
    .select(
      "id, name, status, payment_method, family_group_id, plan_price_cents, pending_price_cents, pending_price_effective_at, selected_plan_id, dojo_plans:selected_plan_id(name, price_cents, currency, interval)",
    )
    .eq("dojo_id", args.dojoId)
    .in("id", memberIds);
  const members = new Map<string, any>(((memberRows ?? []) as any[]).map((m) => [m.id, m]));

  const stripe = getPlatformStripe();
  const opts = duesRequestOptions();
  const rows: FeeDriftRow[] = [];
  let checked = 0;

  for (const s of subs) {
    const m = members.get(s.member_id as string);
    if (!m) continue;
    const interval = (m.dojo_plans?.interval as string) ?? "month";
    if (interval === "one_time") continue;

    // The base amount this member is priced at, family totals included.
    let baseCents = Number(m.plan_price_cents ?? m.dojo_plans?.price_cents ?? 0);
    let isFamilyPayer = false;
    let currency = ((m.dojo_plans?.currency as string) ?? fallbackCurrency).toLowerCase();
    if (m.family_group_id) {
      const role = await familyBillingRole(supabaseAdmin, args.dojoId, m.id);
      if (role.inFamily && role.isPayer) {
        const quote = await familyTotalForPayer(supabaseAdmin, args.dojoId, m.id);
        if (quote) {
          isFamilyPayer = true;
          baseCents = quote.totalCents;
          currency = (quote.currency ?? currency).toLowerCase();
        }
      }
    }
    if (!baseCents) continue;

    let sub: any;
    try {
      sub = await stripe.subscriptions.retrieve(
        s.stripe_subscription_id as string,
        undefined,
        opts,
      );
    } catch (e) {
      console.error("[fee-drift] could not read subscription", s.stripe_subscription_id, e);
      continue;
    }
    const item = sub?.items?.data?.[0];
    const currentCharge = Number(item?.price?.unit_amount ?? 0);
    if (!currentCharge) continue;
    checked += 1;

    const targetCharge = grossChargeCents(baseCents, passFee);
    if (currentCharge === targetCharge) continue;

    const currentAppFeePercent = Number(sub?.application_fee_percent ?? PLATFORM_FEE_PERCENT);
    const targetAppFeePercent = subscriptionAppFeePercent(baseCents, targetCharge, passFee);

    rows.push({
      memberId: m.id as string,
      name: m.name as string,
      planName: (m.dojo_plans?.name as string) ?? "Membership",
      currency,
      interval,
      paymentMethod: (m.payment_method as string) ?? "card",
      isFamilyPayer,
      baseCents,
      currentChargeCents: currentCharge,
      targetChargeCents: targetCharge,
      currentNetCents: netCents(currentCharge, currentAppFeePercent),
      targetNetCents: netCents(targetCharge, targetAppFeePercent),
      feeIncludedNow: currentCharge > baseCents,
      nextRenewalAt: subscriptionPeriodEnd(sub) ?? (s.current_period_end as string | null) ?? null,
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
    stripeReady: true,
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

/**
 * Schedule the price-change machinery for the given rows: the member keeps
 * paying today's amount until the notice period elapses, at which point the
 * nightly sweep reprices their subscription at the NEXT renewal using the
 * gym's current setting.
 */
export async function scheduleFeeAlignment(args: {
  dojoId: string;
  rows: FeeDriftRow[];
  effectiveAt: string;
  actorUserId: string | null;
}): Promise<{ scheduled: number; notified: number }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { notifyMember } = await import("@/lib/member-notify.server");
  const { formatMoney } = await import("@/lib/family-pricing");

  const effectiveDate = new Date(args.effectiveAt).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  let scheduled = 0;
  let notified = 0;

  for (const row of args.rows) {
    // pending_price_cents is a BASE amount; the sweep grosses it up with the
    // gym's setting at the moment it applies, which is exactly the alignment.
    const { error } = await supabaseAdmin
      .from("members")
      .update({
        pending_price_cents: row.baseCents,
        pending_price_effective_at: args.effectiveAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.memberId)
      .eq("dojo_id", args.dojoId);
    if (error) {
      console.error("[fee-drift] could not schedule alignment for", row.memberId, error);
      continue;
    }
    scheduled += 1;

    const direction = row.targetChargeCents > row.currentChargeCents ? "increase" : "decrease";
    const per = row.interval === "year" ? "year" : "month";
    const familyNote = row.isFamilyPayer ? " This is your family total." : "";
    const res = await notifyMember({
      dojoId: args.dojoId,
      memberId: row.memberId,
      subject: `Your membership price will ${direction} from ${effectiveDate}`,
      body:
        `Your ${row.planName} membership is currently ${formatMoney(row.currentChargeCents, row.currency)} per ${per}.${familyNote}\n\n` +
        `From ${effectiveDate} it will be ${formatMoney(row.targetChargeCents, row.currency)} per ${per}. The new amount applies from your first payment on or after that date — nothing is charged today and your payment date does not change.\n\n` +
        `If you have any questions, just reply to this message.`,
      actorUserId: args.actorUserId,
      idempotencyKey: `fee-align-${row.memberId}-${args.effectiveAt.slice(0, 10)}`,
    });
    if (res.inApp || res.emailed) notified += 1;
  }

  return { scheduled, notified };
}
