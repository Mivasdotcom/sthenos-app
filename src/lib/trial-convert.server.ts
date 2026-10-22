// Server-only: converting a trial member onto a paid plan.
//
// A trial member is part of the family but not billed (see
// countsTowardFamilyTotal). Converting them adds them to the family total and
// may change the discount tier, so the payer's amount moves. That reuses the
// SAME machinery as price changes and pause/resume: pending_price_cents plus
// the nightly sweep, applied at the payer's next renewal, never mid-cycle.

import {
  computeFamilyQuote,
  DEFAULT_FAMILY_TIERS,
  formatMoney,
  type FamilyQuote,
} from "@/lib/family-pricing";

const GROUP_SELECT =
  "id, name, status, plan_price_cents, selected_plan_id, dojo_plans:selected_plan_id(name, price_cents, currency, interval)";

export type TrialConversionPreview = {
  memberId: string;
  memberName: string;
  isTrial: boolean;
  inFamily: boolean;
  /** Null when the member is not in a tiered family, or is the payer themself. */
  payer: { id: string; name: string } | null;
  before: FamilyQuote | null;
  after: FamilyQuote | null;
  noticeDays: number;
  effectiveAt: string;
};

async function familyContext(dojoId: string, memberId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: member } = await supabaseAdmin
    .from("members")
    .select("id, name, status, family_group_id")
    .eq("id", memberId)
    .eq("dojo_id", dojoId)
    .maybeSingle();
  if (!member) throw new Error("Member not found");

  const groupId = ((member as any).family_group_id as string | null) ?? null;
  const [{ data: dojo }, { data: group }, { data: rows }, { data: tierRows }] =
    await Promise.all([
      supabaseAdmin
        .from("dojos")
        .select("family_pricing_mode, pass_platform_fee_to_members, price_change_notice_days, default_currency")
        .eq("id", dojoId)
        .maybeSingle(),
      groupId
        ? supabaseAdmin
            .from("family_groups")
            .select("payer_member_id")
            .eq("id", groupId)
            .maybeSingle()
        : Promise.resolve({ data: null } as any),
      groupId
        ? supabaseAdmin
            .from("members")
            .select(GROUP_SELECT)
            .eq("dojo_id", dojoId)
            .eq("family_group_id", groupId)
            .order("name")
        : Promise.resolve({ data: [] } as any),
      supabaseAdmin
        .from("family_discount_tiers")
        .select("min_members, discount_percent")
        .eq("dojo_id", dojoId),
    ]);

  const tiers = ((tierRows ?? []) as any[]).length
    ? ((tierRows ?? []) as any[]).map((t) => ({
        min_members: Number(t.min_members),
        discount_percent: Number(t.discount_percent),
      }))
    : DEFAULT_FAMILY_TIERS;

  return {
    supabaseAdmin,
    member: member as any,
    groupId,
    dojo: (dojo ?? {}) as any,
    payerId: ((group as any)?.payer_member_id as string | null) ?? null,
    rows: ((rows ?? []) as any[]),
    tiers,
  };
}

function quoteRows(
  rows: any[],
  tiers: { min_members: number; discount_percent: number }[],
  payerId: string | null,
  fallbackCurrency: string,
  overrideStatusFor?: string,
): FamilyQuote {
  const payerPlan = rows.find((m) => m.id === payerId)?.dojo_plans;
  const anyPlan = payerPlan ?? rows.find((m) => m.dojo_plans)?.dojo_plans;
  const interval = (payerPlan?.interval as string) ?? (anyPlan?.interval as string) ?? "month";
  return computeFamilyQuote({
    members: rows.map((m) => ({
      id: m.id,
      name: m.name,
      status: m.id === overrideStatusFor ? "active" : m.status,
      planName: m.dojo_plans?.name ?? null,
      priceCents: Number(m.plan_price_cents ?? m.dojo_plans?.price_cents ?? 0),
      interval: (m.dojo_plans?.interval as string) ?? interval,
    })),
    tiers,
    currency: (payerPlan?.currency as string) ?? (anyPlan?.currency as string) ?? fallbackCurrency,
    interval,
  });
}

export async function previewTrialConversionInternal(args: {
  dojoId: string;
  memberId: string;
}): Promise<TrialConversionPreview> {
  const ctx = await familyContext(args.dojoId, args.memberId);
  const noticeDays = Math.max(0, Math.round(Number(ctx.dojo.price_change_notice_days ?? 30)));
  const effectiveAt = new Date(Date.now() + noticeDays * 86400000).toISOString();
  const tiered = (ctx.dojo.family_pricing_mode ?? "tiered") === "tiered";
  const payerId = ctx.payerId;
  const affectsPayer = !!(ctx.groupId && tiered && payerId && payerId !== args.memberId);

  const base = {
    memberId: args.memberId,
    memberName: ctx.member.name as string,
    isTrial: (ctx.member.status as string) === "trial",
    inFamily: !!ctx.groupId,
    noticeDays,
    effectiveAt,
  };
  if (!affectsPayer) {
    return { ...base, payer: null, before: null, after: null };
  }
  const currency = (ctx.dojo.default_currency as string) ?? "usd";
  return {
    ...base,
    payer: {
      id: payerId!,
      name: (ctx.rows.find((m) => m.id === payerId)?.name as string) ?? "the payer",
    },
    before: quoteRows(ctx.rows, ctx.tiers, payerId, currency),
    after: quoteRows(ctx.rows, ctx.tiers, payerId, currency, args.memberId),
  };
}

export async function convertTrialToActiveInternal(args: {
  dojoId: string;
  memberId: string;
  actorUserId: string | null;
}): Promise<{
  ok: true;
  payerNotified: boolean;
  effectiveAt: string | null;
  beforeTotalCents: number | null;
  afterTotalCents: number | null;
  currency: string | null;
}> {
  const preview = await previewTrialConversionInternal(args);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const nowISO = new Date().toISOString();

  await supabaseAdmin
    .from("members")
    .update({ status: "active", updated_at: nowISO })
    .eq("id", args.memberId)
    .eq("dojo_id", args.dojoId);

  if (!preview.payer || !preview.after || !preview.before) {
    return {
      ok: true,
      payerNotified: false,
      effectiveAt: null,
      beforeTotalCents: null,
      afterTotalCents: null,
      currency: null,
    };
  }

  const after = preview.after;
  // Schedule the payer's new amount for their next renewal, honouring notice.
  // pending_price_cents is the BASE amount; the nightly sweep grosses it up
  // with the platform fee when the gym passes it on.
  await supabaseAdmin
    .from("members")
    .update({
      pending_price_cents: after.totalCents,
      pending_price_effective_at: preview.effectiveAt,
      updated_at: nowISO,
    })
    .eq("id", preview.payer.id)
    .eq("dojo_id", args.dojoId);

  const effectiveDate = new Date(preview.effectiveAt).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const { notifyMember } = await import("@/lib/member-notify.server");
  await notifyMember({
    dojoId: args.dojoId,
    memberId: preview.payer.id,
    subject: `Your family total will change from ${effectiveDate}`,
    body:
      `${preview.memberName} has moved from a free trial onto a paid plan, so they now count towards your family total.\n\n` +
      `Now: ${formatMoney(preview.before.totalCents, preview.before.currency)} (${preview.before.size} member${preview.before.size === 1 ? "" : "s"}, ${preview.before.discountPercent}% family discount)\n` +
      `From ${effectiveDate}: ${formatMoney(after.totalCents, after.currency)} (${after.size} member${after.size === 1 ? "" : "s"}, ${after.discountPercent}% family discount)\n\n` +
      `Nothing is charged today and your payment date does not change — the new amount applies from your first payment on or after that date.`,
    actorUserId: args.actorUserId,
    idempotencyKey: `trial-convert-${args.memberId}-${preview.effectiveAt}`,
  });

  return {
    ok: true,
    payerNotified: true,
    effectiveAt: preview.effectiveAt,
    beforeTotalCents: preview.before.totalCents,
    afterTotalCents: after.totalCents,
    currency: after.currency,
  };
}
