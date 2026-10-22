import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertDojoStaff } from "./dojo-access";

/**
 * Price changes for a plan.
 *
 * GOVERNING RULES
 *  - Nobody's charge changes without them being told first: applying a change
 *    to existing members schedules it at least `price_change_notice_days` ahead
 *    and notifies every affected member immediately.
 *  - Nothing is charged mid-cycle. A scheduled change is pushed to Stripe once
 *    the notice period has elapsed, always with no proration and an unchanged
 *    billing anchor, so the new amount first appears on the next renewal.
 *  - Existing members can be left on their current price ("grandfathered"),
 *    which is stored per member as members.plan_price_cents.
 */

export type PriceChangeScope = "new_members" | "all_members";

export type PriceChangeRow = {
  memberId: string;
  name: string;
  status: string;
  paymentMethod: string;
  isFamilyPayer: boolean;
  coveredCount: number;
  /** What they are charged today (family total for a payer), base amount. */
  oldChargeCents: number;
  /** What they would be charged after the change, base amount. */
  newChargeCents: number;
  /** Amounts Stripe will actually bill, including the platform fee when passed on. */
  oldGrossCents: number;
  newGrossCents: number;
  nextRenewalAt: string | null;
  hasLiveSubscription: boolean;
};

export type PriceChangePreview = {
  plan: {
    id: string;
    name: string;
    currency: string;
    interval: string;
    oldPriceCents: number;
    newPriceCents: number;
  };
  passFee: boolean;
  noticeDays: number;
  effectiveAt: string;
  counts: {
    onPlan: number;
    changing: number;
    paused: number;
    cash: number;
    familyPayers: number;
  };
  rows: PriceChangeRow[];
  totals: {
    oldCents: number;
    newCents: number;
    diffCents: number;
    currency: string;
    interval: string;
  };
};

export const previewPlanPriceChange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { dojoId: string; planId: string; newPriceCents: number; noticeDays?: number }) => {
      if (!d?.dojoId || !d?.planId) throw new Error("dojoId and planId are required");
      const cents = Math.round(Number(d.newPriceCents));
      if (!Number.isFinite(cents) || cents < 0) throw new Error("Invalid price");
      return { ...d, newPriceCents: cents };
    },
  )
  .handler(async ({ data, context }) => {
    await assertDojoStaff(
      (context as any).supabase,
      (context as any).userId,
      data.dojoId,
      "previewPlanPriceChange",
    );
    const { buildPreview } = await import("./price-changes-preview.server");
    return buildPreview({
      dojoId: data.dojoId,
      planId: data.planId,
      newPriceCents: data.newPriceCents,
      noticeDaysOverride: data.noticeDays ?? null,
    });
  });

export const applyPlanPriceChange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      dojoId: string;
      planId: string;
      newPriceCents: number;
      scope: PriceChangeScope;
      noticeDays?: number;
      notes?: string | null;
    }) => {
      if (!d?.dojoId || !d?.planId) throw new Error("dojoId and planId are required");
      const cents = Math.round(Number(d.newPriceCents));
      if (!Number.isFinite(cents) || cents < 0) throw new Error("Invalid price");
      if (d.scope !== "new_members" && d.scope !== "all_members") {
        throw new Error("Choose whether the new price applies to new members only or everyone");
      }
      return { ...d, newPriceCents: cents };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "applyPlanPriceChange");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { buildPreview } = await import("./price-changes-preview.server");
    const preview = await buildPreview({
      dojoId: data.dojoId,
      planId: data.planId,
      newPriceCents: data.newPriceCents,
      noticeDaysOverride: data.noticeDays ?? null,
    });
    const { formatMoney } = await import("@/lib/family-pricing");

    // 1. Existing members keep their current price until the change is due.
    //    Locking it explicitly is what makes "new members only" durable, and it
    //    also means a scheduled change can never take effect early.
    const { data: onPlan } = await supabaseAdmin
      .from("members")
      .select("id, plan_price_cents, status")
      .eq("dojo_id", data.dojoId)
      .eq("selected_plan_id", data.planId);
    const nowISO = new Date().toISOString();
    for (const m of (onPlan ?? []) as any[]) {
      if (m.plan_price_cents == null) {
        await supabaseAdmin
          .from("members")
          .update({
            plan_price_cents: preview.plan.oldPriceCents,
            plan_price_locked_at: nowISO,
          })
          .eq("id", m.id);
      }
    }

    // 2. The plan itself moves to the new price (this governs NEW signups).
    const { error: planErr } = await supabaseAdmin
      .from("dojo_plans")
      .update({ price_cents: data.newPriceCents })
      .eq("id", data.planId)
      .eq("dojo_id", data.dojoId);
    if (planErr) throw new Error(planErr.message);

    // 3. Record the decision.
    const { data: record, error: recErr } = await supabaseAdmin
      .from("plan_price_changes")
      .insert({
        dojo_id: data.dojoId,
        plan_id: data.planId,
        scope: data.scope,
        old_price_cents: preview.plan.oldPriceCents,
        new_price_cents: data.newPriceCents,
        currency: preview.plan.currency,
        notice_days: preview.noticeDays,
        effective_at: preview.effectiveAt,
        decided_by: userId,
        members_affected: data.scope === "all_members" ? preview.counts.changing : 0,
        member_ids:
          data.scope === "all_members"
            ? preview.rows.filter((r) => r.newChargeCents !== r.oldChargeCents).map((r) => r.memberId)
            : [],
        old_total_cents: preview.totals.oldCents,
        new_total_cents: preview.totals.newCents,
        notes: data.notes?.trim() || null,
        applied_at: data.scope === "new_members" ? nowISO : null,
      })
      .select("id")
      .single();
    if (recErr) throw new Error(recErr.message);

    if (data.scope === "new_members") {
      return {
        ok: true as const,
        scope: data.scope,
        changeId: record.id as string,
        notified: 0,
        notifications: { attempted: 0, emailed: 0, inApp: 0, failed: 0, failures: [] as any[] },
        effectiveAt: null as string | null,
        grandfathered: (onPlan ?? []).length,
      };
    }

    // 4. Schedule the change per affected member and tell them now.
    let notified = 0;
    const { notifyMember, notifyCollector } = await import("@/lib/member-notify.server");
    const notes = notifyCollector();
    const effectiveDate = new Date(preview.effectiveAt).toLocaleDateString(undefined, {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    for (const row of preview.rows) {
      if (row.newChargeCents === row.oldChargeCents) continue;
      await supabaseAdmin
        .from("members")
        .update({
          pending_price_cents: row.newChargeCents,
          pending_price_effective_at: preview.effectiveAt,
        })
        .eq("id", row.memberId)
        .eq("dojo_id", data.dojoId);

      const direction = row.newGrossCents > row.oldGrossCents ? "increase" : "decrease";
      const familyNote = row.isFamilyPayer
        ? ` This is your family total covering ${row.coveredCount + 1} members.`
        : "";
      const methodNote =
        row.paymentMethod === "cash"
          ? " You pay in cash, so please bring the new amount from that date."
          : " Nothing is charged today, and your current payment date does not change.";
      const res = await notifyMember({
        dojoId: data.dojoId,
        memberId: row.memberId,
        subject: `Your membership price will ${direction} from ${effectiveDate}`,
        body:
          `Your ${preview.plan.name} membership is currently ${formatMoney(row.oldGrossCents, preview.plan.currency)} per ${preview.plan.interval === "year" ? "year" : "month"}.` +
          `${familyNote}\n\n` +
          `From ${effectiveDate} it will be ${formatMoney(row.newGrossCents, preview.plan.currency)}. The new amount applies from your first payment on or after that date.${methodNote}\n\n` +
          `If you have any questions, just reply to this message.`,
        actorUserId: userId,
        idempotencyKey: `price-change-${record.id}-${row.memberId}`,
      });
      notes.add(res, { memberId: row.memberId, name: (row as any).name ?? null });
      if (res.inApp || res.emailed) notified += 1;
    }

    return {
      ok: true as const,
      scope: data.scope,
      changeId: record.id as string,
      notified,
      effectiveAt: preview.effectiveAt,
      grandfathered: 0,
      notifications: notes.summary,
    };
  });

/** Scheduled and historic price changes for the gym. */
export const listPlanPriceChanges = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "listPlanPriceChanges");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows } = await supabaseAdmin
      .from("plan_price_changes")
      .select(
        "id, plan_id, scope, old_price_cents, new_price_cents, currency, notice_days, effective_at, applied_at, members_affected, old_total_cents, new_total_cents, decided_at, dojo_plans:plan_id(name)",
      )
      .eq("dojo_id", data.dojoId)
      .order("decided_at", { ascending: false })
      .limit(50);
    return {
      changes: ((rows ?? []) as any[]).map((r) => ({
        id: r.id as string,
        planId: r.plan_id as string,
        planName: (r.dojo_plans?.name as string) ?? "Plan",
        scope: r.scope as PriceChangeScope,
        oldPriceCents: Number(r.old_price_cents),
        newPriceCents: Number(r.new_price_cents),
        currency: r.currency as string,
        noticeDays: Number(r.notice_days),
        effectiveAt: r.effective_at as string,
        appliedAt: (r.applied_at as string | null) ?? null,
        membersAffected: Number(r.members_affected ?? 0),
        oldTotalCents: Number(r.old_total_cents ?? 0),
        newTotalCents: Number(r.new_total_cents ?? 0),
        decidedAt: r.decided_at as string,
      })),
    };
  });

/**
 * Members whose actual billed amount differs from what the gym's current
 * pricing settings say it should be (older plan price, or the platform fee
 * pass-through not reflected on their subscription).
 */
export const listGrandfatheredMembers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "listGrandfatheredMembers");
    const { loadPricingDrift } = await import("@/lib/pricing-drift.server");
    const report = await loadPricingDrift({ dojoId: data.dojoId });
    return {
      passFee: report.passFee,
      noticeDays: report.noticeDays,
      effectiveAt: report.effectiveAt,
      stripeReady: report.stripeReady,
      checked: report.checked,
      totals: report.totals,
      members: report.rows,
    };
  });


/** Put one member onto the plan's current price at their next renewal. */
export const moveMemberToCurrentPrice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberId: string; noticeDays?: number }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "moveMemberToCurrentPrice");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [{ data: member }, { data: dojo }] = await Promise.all([
      supabaseAdmin
        .from("members")
        .select(
          "id, name, plan_price_cents, dojo_plans:selected_plan_id(name, price_cents, currency, interval)",
        )
        .eq("id", data.memberId)
        .eq("dojo_id", data.dojoId)
        .maybeSingle(),
      supabaseAdmin
        .from("dojos")
        .select("price_change_notice_days, pass_platform_fee_to_members")
        .eq("id", data.dojoId)
        .maybeSingle(),
    ]);
    if (!member) throw new Error("Member not found");
    const target = Number((member as any).dojo_plans?.price_cents ?? 0);
    const noticeDays = Math.max(
      0,
      Math.round(data.noticeDays ?? Number(dojo?.price_change_notice_days ?? 30)),
    );
    const effectiveAt = new Date(Date.now() + noticeDays * 86400000).toISOString();

    await supabaseAdmin
      .from("members")
      .update({ pending_price_cents: target, pending_price_effective_at: effectiveAt })
      .eq("id", data.memberId)
      .eq("dojo_id", data.dojoId);

    const { grossChargeCents } = await import("@/lib/platform-fee");
    const { formatMoney } = await import("@/lib/family-pricing");
    const passFee = !!dojo?.pass_platform_fee_to_members;
    const currency = ((member as any).dojo_plans?.currency as string) ?? "usd";
    const effectiveDate = new Date(effectiveAt).toLocaleDateString(undefined, {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    await (await import("@/lib/member-notify.server")).notifyMember({
      dojoId: data.dojoId,
      memberId: data.memberId,
      subject: `Your membership price will change from ${effectiveDate}`,
      body:
        `From ${effectiveDate}, your membership will be ${formatMoney(grossChargeCents(target, passFee), currency)}, the current price of the ${(member as any).dojo_plans?.name ?? "plan"}.\n\n` +
        `Nothing is charged today and your payment date does not change — the new amount applies from your first payment on or after that date.`,
      actorUserId: userId,
      idempotencyKey: `member-price-${data.memberId}-${effectiveAt}`,
    });

    return { ok: true as const, effectiveAt, newPriceCents: target };
  });
