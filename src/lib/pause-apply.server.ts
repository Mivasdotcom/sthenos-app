// Server-only: resuming a paused membership, and the scheduled sweeps that
// apply due price changes and auto-resume pauses.
//
// Resuming returns the member to EXACTLY the amount they paid before the pause:
// their locked price (members.plan_price_cents) is untouched by a pause, and the
// family total is recomputed with them back in the tier count.

const LIVE_STATUSES = ["active", "trialing", "past_due", "unpaid", "incomplete"] as const;

import type { NotifySummary } from "@/lib/notify-summary";

export type ResumeResult = {
  ok: true;
  memberId: string;
  restoredStatus: string;
  stripeResumed: number;
  payerNewTotalCents: number | null;
  /** Real outcome of the member/payer emails, so staff are never misled. */
  notifications?: NotifySummary;
};


export async function resumeMembershipInternal(args: {
  dojoId: string;
  memberId: string;
  actorUserId: string | null;
  trigger: "staff" | "scheduled";
}): Promise<ResumeResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { formatMoney, computeFamilyQuote, DEFAULT_FAMILY_TIERS } = await import(
    "@/lib/family-pricing"
  );
  const { notifyMember, notifyCollector } = await import("@/lib/member-notify.server");
  const notes = notifyCollector();

  const { data: member } = await supabaseAdmin
    .from("members")
    .select("id, name, status, family_group_id, plan_price_cents, selected_plan_id")
    .eq("id", args.memberId)
    .eq("dojo_id", args.dojoId)
    .maybeSingle();
  if (!member) throw new Error("Member not found");
  if ((member as any).status !== "paused") {
    return {
      ok: true,
      memberId: args.memberId,
      restoredStatus: (member as any).status as string,
      stripeResumed: 0,
      payerNewTotalCents: null,
    };
  }

  const { data: pauseRow } = await supabaseAdmin
    .from("membership_pauses")
    .select("id, status_before, payment_status_before, family_group_id")
    .eq("dojo_id", args.dojoId)
    .eq("member_id", args.memberId)
    .eq("status", "active")
    .order("paused_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // 1. Stripe first.
  const { hasStripeSecret, getPlatformStripe } = await import("@/lib/stripe-connect.server");
  const { data: subs } = await supabaseAdmin
    .from("member_subscriptions")
    .select("id, stripe_subscription_id, status")
    .eq("dojo_id", args.dojoId)
    .eq("member_id", args.memberId)
    .in("status", ["paused", ...LIVE_STATUSES]);
  const live = ((subs ?? []) as any[]).filter((s) => s.stripe_subscription_id);
  if (live.length && !hasStripeSecret()) {
    throw new Error("Stripe isn't configured, so billing can't be resumed. Nothing was changed.");
  }
  const { resumeDuesSubscription } = await import("@/lib/pause.server");
  let stripeResumed = 0;
  for (const s of live) {
    const out = await resumeDuesSubscription(getPlatformStripe(), s.stripe_subscription_id);
    if (out.ok && !out.absent) {
      stripeResumed += 1;
      await supabaseAdmin
        .from("member_subscriptions")
        .update({ status: "active", updated_at: new Date().toISOString() })
        .eq("id", s.id);
    }
  }

  // 2. Local state back to what it was.
  const restoredStatus = ((pauseRow?.status_before as string | null) ?? "active") as
    | "active"
    | "lapsed"
    | "trial"
    | "pending";
  const nowISO = new Date().toISOString();
  await supabaseAdmin
    .from("members")
    .update({
      status: restoredStatus,
      paused_at: null,
      pause_reason: null,
      pause_note: null,
      pause_resumes_at: null,
      updated_at: nowISO,
    })
    .eq("id", args.memberId)
    .eq("dojo_id", args.dojoId);
  if (pauseRow?.id) {
    await supabaseAdmin
      .from("membership_pauses")
      .update({ status: "resumed", resumed_at: nowISO, updated_at: nowISO })
      .eq("id", pauseRow.id);
  }

  // 3. The family total goes back to what it was, at the next renewal.
  let payerNewTotalCents: number | null = null;
  const groupId = ((member as any).family_group_id as string | null) ?? null;
  if (groupId) {
    const [{ data: group }, { data: rows }, { data: tierRows }, { data: dojo }] = await Promise.all([
      supabaseAdmin
        .from("family_groups")
        .select("payer_member_id")
        .eq("id", groupId)
        .maybeSingle(),
      supabaseAdmin
        .from("members")
        .select(
          "id, name, status, plan_price_cents, selected_plan_id, dojo_plans:selected_plan_id(price_cents, currency, interval)",
        )
        .eq("dojo_id", args.dojoId)
        .eq("family_group_id", groupId),
      supabaseAdmin
        .from("family_discount_tiers")
        .select("min_members, discount_percent")
        .eq("dojo_id", args.dojoId),
      supabaseAdmin
        .from("dojos")
        .select("pass_platform_fee_to_members, family_pricing_mode")
        .eq("id", args.dojoId)
        .maybeSingle(),
    ]);
    const payerId = (group?.payer_member_id as string | null) ?? null;
    const fam = (rows ?? []) as any[];
    if (payerId && payerId !== args.memberId && (dojo?.family_pricing_mode ?? "tiered") === "tiered") {
      const tiers = ((tierRows ?? []) as any[]).length
        ? ((tierRows ?? []) as any[]).map((t) => ({
            min_members: Number(t.min_members),
            discount_percent: Number(t.discount_percent),
          }))
        : DEFAULT_FAMILY_TIERS;
      const anyPlan = fam.find((m) => m.dojo_plans)?.dojo_plans;
      const payerPlan = fam.find((m) => m.id === payerId)?.dojo_plans;
      const famCurrency =
        (payerPlan?.currency as string) ?? (anyPlan?.currency as string) ?? "usd";
      // The family bills on ONE interval — the payer's.
      const famInterval =
        (payerPlan?.interval as string) ?? (anyPlan?.interval as string) ?? "month";
      const quote = computeFamilyQuote({
        members: fam.map((m) => ({
          id: m.id,
          name: m.name,
          status: m.status,
          priceCents: Number(m.plan_price_cents ?? m.dojo_plans?.price_cents ?? 0),
          interval: (m.dojo_plans?.interval as string) ?? famInterval,
        })),
        tiers,
        currency: famCurrency,
        interval: famInterval,
      });
      payerNewTotalCents = quote.totalCents;
      const { data: payerSub } = await supabaseAdmin
        .from("member_subscriptions")
        .select("stripe_subscription_id")
        .eq("dojo_id", args.dojoId)
        .eq("member_id", payerId)
        .in("status", [...LIVE_STATUSES])
        .limit(1)
        .maybeSingle();
      if (
        hasStripeSecret() &&
        payerSub?.stripe_subscription_id &&
        quote.interval !== "one_time"
      ) {
        const { repriceSubscriptionAtRenewal } = await import("@/lib/pricing.server");
        const { grossChargeCents } = await import("@/lib/platform-fee");
        await repriceSubscriptionAtRenewal({
          stripe: getPlatformStripe(),
          subscriptionId: payerSub.stripe_subscription_id as string,
          unitAmountCents: grossChargeCents(
            quote.totalCents,
            !!dojo?.pass_platform_fee_to_members,
          ),
          currency: quote.currency,
          interval: quote.interval as "month" | "year",
          productName: `Family plan — ${quote.size} member${quote.size === 1 ? "" : "s"} (${quote.discountPercent}% family discount)`,
          metadata: {
            dojo_id: args.dojoId,
            family_group_id: groupId,
            family_size: String(quote.size),
          },
        });
      }
      // The narrative is generated from the SAME quote that produces the
      // number, so the copy can never claim a change the figure contradicts.
      const resumedIsCounted = quote.members.some((m) => m.id === args.memberId);
      const resumedName = ((member as any).name as string | null) ?? "Your family member";
      const { familyExclusionLabel } = await import("@/lib/family-pricing");
      const why = familyExclusionLabel(restoredStatus);
      const body = resumedIsCounted
        ? `${resumedName} has restarted their membership, so they are back in your family total.\n\n` +
          `From your next payment date, your family total will be ${formatMoney(quote.totalCents, quote.currency)} (${quote.discountPercent}% family discount for ${quote.size} member${quote.size === 1 ? "" : "s"}). Nothing changes on your current payment.`
        : `${resumedName} has restarted their membership${why ? `, but they are ${why}` : ", but they are not part of the billed total yet"}.\n\n` +
          `Your family total is unchanged at ${formatMoney(quote.totalCents, quote.currency)} (${quote.discountPercent}% family discount for ${quote.size} billed member${quote.size === 1 ? "" : "s"}). Nothing changes on your payments. We'll let you know before that ever changes.`;
      notes.add(
        await notifyMember({
        dojoId: args.dojoId,
        memberId: payerId,
        subject: resumedIsCounted
          ? "Your family membership total is changing"
          : "An update to your family membership",
        body,
        actorUserId: args.actorUserId,
        idempotencyKey: `family-resume-${groupId}-${args.memberId}-${nowISO}`,
        }),
        { memberId: payerId, name: null },
      );

    }
  }

  // 4. Tell the member.
  notes.add(
    await notifyMember({
    dojoId: args.dojoId,
    memberId: args.memberId,
    subject: "Your membership is active again",
    body:
      `Your membership has restarted${args.trigger === "scheduled" ? " on the date you chose" : ""}, at exactly the same price you were paying before the pause.\n\n` +
      `You can book classes again from now. Nothing was charged for the paused period.`,
    actorUserId: args.actorUserId,
    idempotencyKey: `resume-${args.memberId}-${nowISO}`,
    }),
    { memberId: args.memberId, name: (member as any).name ?? null },
  );

  return {
    ok: true,
    memberId: args.memberId,
    restoredStatus,
    stripeResumed,
    payerNewTotalCents,
    notifications: notes.summary,
  };
}

/* ------------------------------------------------------------------ sweeps */

/**
 * Push every price change whose notice period has now elapsed onto the member's
 * live subscription. Always at the next renewal, never mid-cycle.
 */
export async function applyDuePriceChanges(): Promise<{
  applied: number;
  failed: number;
}> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const nowISO = new Date().toISOString();
  // Archived gyms are dormant: no repricing of their members' subscriptions.
  const { archivedDojoIds } = await import("@/lib/archived-dojos.server");
  const archived = await archivedDojoIds();
  const { data: due } = await supabaseAdmin
    .from("members")
    .select(
      "id, dojo_id, name, pending_price_cents, pending_price_effective_at, selected_plan_id, dojo_plans:selected_plan_id(name, currency, interval)",
    )
    .not("pending_price_cents", "is", null)
    .lte("pending_price_effective_at", nowISO)
    .limit(500);

  let applied = 0;
  let failed = 0;
  const { hasStripeSecret, getPlatformStripe } = await import("@/lib/stripe-connect.server");
  const { grossChargeCents } = await import("@/lib/platform-fee");
  const { repriceSubscriptionAtRenewal } = await import("@/lib/pricing.server");

  for (const m of ((due ?? []) as any[])) {
    if (archived.has(m.dojo_id)) continue;

    try {
      const target = Number(m.pending_price_cents);
      const { data: dojo } = await supabaseAdmin
        .from("dojos")
        .select("pass_platform_fee_to_members")
        .eq("id", m.dojo_id)
        .maybeSingle();
      const { data: sub } = await supabaseAdmin
        .from("member_subscriptions")
        .select("stripe_subscription_id")
        .eq("dojo_id", m.dojo_id)
        .eq("member_id", m.id)
        .in("status", [...LIVE_STATUSES])
        .limit(1)
        .maybeSingle();
      const interval = (m.dojo_plans?.interval as string) ?? "month";
      if (hasStripeSecret() && sub?.stripe_subscription_id && interval !== "one_time") {
        await repriceSubscriptionAtRenewal({
          stripe: getPlatformStripe(),
          subscriptionId: sub.stripe_subscription_id as string,
          unitAmountCents: grossChargeCents(target, !!dojo?.pass_platform_fee_to_members),
          currency: (m.dojo_plans?.currency as string) ?? "usd",
          interval: interval as "month" | "year",
          productName: `${m.dojo_plans?.name ?? "Membership"} — updated price`,
          metadata: { dojo_id: m.dojo_id, member_id: m.id },
        });
      }
      await supabaseAdmin
        .from("members")
        .update({
          plan_price_cents: target,
          plan_price_locked_at: nowISO,
          pending_price_cents: null,
          pending_price_effective_at: null,
          updated_at: nowISO,
        })
        .eq("id", m.id);
      applied += 1;
    } catch (e) {
      failed += 1;
      console.error("[price-changes] could not apply for member", m.id, e);
    }
  }

  // Mark fully-applied scheduled changes.
  const { data: pending } = await supabaseAdmin
    .from("plan_price_changes")
    .select("id, member_ids")
    .is("applied_at", null)
    .lte("effective_at", nowISO)
    .limit(200);
  for (const change of ((pending ?? []) as any[])) {
    const ids = (change.member_ids ?? []) as string[];
    if (ids.length) {
      const { count } = await supabaseAdmin
        .from("members")
        .select("id", { count: "exact", head: true })
        .in("id", ids)
        .not("pending_price_cents", "is", null);
      if ((count ?? 0) > 0) continue;
    }
    await supabaseAdmin
      .from("plan_price_changes")
      .update({ applied_at: nowISO, updated_at: nowISO })
      .eq("id", change.id);
  }

  return { applied, failed };
}

/** Auto-resume pauses that have reached their resume date, and remind before. */
export async function runPauseMaintenance(): Promise<{
  resumed: number;
  reminded: number;
  failed: number;
}> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { notifyMember } = await import("@/lib/member-notify.server");
  const nowISO = new Date().toISOString();
  // Archived gyms are dormant: no auto-resume, no restart reminders.
  const { archivedDojoIds } = await import("@/lib/archived-dojos.server");
  const archived = await archivedDojoIds();
  let resumed = 0;
  let reminded = 0;
  let failed = 0;

  const { data: dueRows } = await supabaseAdmin
    .from("members")
    .select("id, dojo_id")
    .eq("status", "paused")
    .not("pause_resumes_at", "is", null)
    .lte("pause_resumes_at", nowISO)
    .limit(300);
  for (const m of ((dueRows ?? []) as any[])) {
    if (archived.has(m.dojo_id)) continue;

    try {
      await resumeMembershipInternal({
        dojoId: m.dojo_id,
        memberId: m.id,
        actorUserId: null,
        trigger: "scheduled",
      });
      resumed += 1;
    } catch (e) {
      failed += 1;
      console.error("[pauses] auto-resume failed for", m.id, e);
    }
  }

  // Remind 3 days out so nobody is surprised by billing restarting.
  const soon = new Date(Date.now() + 3 * 86400000).toISOString();
  const { data: upcoming } = await supabaseAdmin
    .from("membership_pauses")
    .select("id, dojo_id, member_id, resume_at, reminder_sent_at")
    .eq("status", "active")
    .is("reminder_sent_at", null)
    .not("resume_at", "is", null)
    .lte("resume_at", soon)
    .limit(300);
  for (const p of ((upcoming ?? []) as any[])) {
    if (archived.has(p.dojo_id)) continue;

    try {
      const when = new Date(p.resume_at).toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
      await notifyMember({
        dojoId: p.dojo_id,
        memberId: p.member_id,
        subject: `Your membership restarts on ${when}`,
        body:
          `Just so it isn't a surprise: your paused membership restarts on ${when}, and billing starts again from that date at exactly the same price as before.\n\n` +
          `If you'd like to stay paused for longer, reply to this message and we'll sort it out.`,
        actorUserId: null,
        idempotencyKey: `pause-reminder-${p.id}`,
      });
      await supabaseAdmin
        .from("membership_pauses")
        .update({ reminder_sent_at: nowISO, updated_at: nowISO })
        .eq("id", p.id);
      reminded += 1;
    } catch (e) {
      failed += 1;
      console.error("[pauses] reminder failed", p.id, e);
    }
  }

  return { resumed, reminded, failed };
}
