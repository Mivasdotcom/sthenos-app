// Cash / offline payments. Staff-only, always scoped by dojo_id.
// Cash never touches Stripe, so it is never part of any application-fee
// calculation — recording a payment here only updates our own records.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertDojoStaff } from "@/lib/dojo-access";
import { currentPeriod, dueDateFor, daysBetween } from "@/lib/cash-payments";
import { resyncAfterCashChange } from "@/lib/cash-payments.server";

export type CashPaymentRow = {
  id: string;
  amount_cents: number;
  currency: string;
  paid_on: string;
  period_start: string;
  period_end: string;
  note: string | null;
  created_at: string;
};

export type CashDueRow = {
  memberId: string;
  name: string;
  email: string | null;
  planName: string | null;
  amountDueCents: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  daysOverdue: number;
  lastPaymentOn: string | null;
  paymentStatus: string | null;
};


export const recordCashPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      dojoId: string;
      memberId: string;
      amountCents: number;
      currency?: string;
      paidOn: string;
      periodStart: string;
      periodEnd: string;
      note?: string | null;
    }) => d,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "recordCashPayment");

    if (!Number.isFinite(data.amountCents) || data.amountCents <= 0) {
      throw new Error("Enter an amount greater than zero");
    }
    if (data.periodEnd < data.periodStart) {
      throw new Error("The period end must be on or after the period start");
    }

    const { data: member, error: memberErr } = await supabase
      .from("members")
      .select("id, dojo_id, dojo_plans:selected_plan_id(currency)")
      .eq("id", data.memberId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (memberErr) throw memberErr;
    if (!member) throw new Error("Member not found in this gym");

    const { data: dojo } = await supabase
      .from("dojos")
      .select("default_currency")
      .eq("id", data.dojoId)
      .maybeSingle();

    const currency = (
      data.currency ||
      (member as any).dojo_plans?.currency ||
      dojo?.default_currency ||
      "usd"
    ).toLowerCase();

    const { data: row, error } = await supabase
      .from("cash_payments")
      .insert({
        dojo_id: data.dojoId,
        member_id: data.memberId,
        amount_cents: Math.round(data.amountCents),
        currency,
        paid_on: data.paidOn,
        period_start: data.periodStart,
        period_end: data.periodEnd,
        recorded_by: userId,
        note: data.note?.trim() || null,
      })
      .select("id")
      .maybeSingle();
    if (error) throw error;

    await resyncAfterCashChange(data.dojoId, data.memberId);
    return { id: row?.id ?? null };
  });

export const listCashPayments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberId: string }) => d)
  .handler(async ({ data, context }): Promise<CashPaymentRow[]> => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "listCashPayments");
    const { data: rows, error } = await supabase
      .from("cash_payments")
      .select("id, amount_cents, currency, paid_on, period_start, period_end, note, created_at")
      .eq("dojo_id", data.dojoId)
      .eq("member_id", data.memberId)
      .order("paid_on", { ascending: false })
      .limit(50);
    if (error) throw error;
    return (rows ?? []) as CashPaymentRow[];
  });

export const deleteCashPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; paymentId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "deleteCashPayment");
    const { data: row, error: readErr } = await supabase
      .from("cash_payments")
      .select("member_id")
      .eq("id", data.paymentId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (readErr) throw readErr;
    if (!row) throw new Error("Payment not found");
    const { error } = await supabase
      .from("cash_payments")
      .delete()
      .eq("id", data.paymentId)
      .eq("dojo_id", data.dojoId);
    if (error) throw error;
    await resyncAfterCashChange(data.dojoId, row.member_id);
    return { ok: true };
  });

/**
 * "Owed this month": cash members with an assigned plan whose current period
 * has no covering cash payment. Expected dues come straight from the plan
 * price + interval; the gym's configured grace period sets the due date.
 */
export const getCashDues = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }): Promise<CashDueRow[]> => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "getCashDues");

    const [memRes, dojoRes] = await Promise.all([
      supabase
        .from("members")
        .select(
          "id,name,email,payment_status,selected_plan_id,dojo_plans:selected_plan_id(name,price_cents,currency,interval)",
        )
        .eq("dojo_id", data.dojoId)
        .eq("payment_method", "cash")
        .is("plan_covered_by", null)
        .in("status", ["active", "trial"]),
      supabase.from("dojos").select("hold_grace_days, default_currency").eq("id", data.dojoId).maybeSingle(),
    ]);
    if (memRes.error) throw memRes.error;

    const members = (memRes.data ?? []).filter((m: any) => m.dojo_plans && m.dojo_plans.price_cents > 0);
    if (members.length === 0) return [];

    const grace = dojoRes.data?.hold_grace_days ?? 0;
    const fallbackCurrency = (dojoRes.data?.default_currency ?? "usd").toLowerCase();

    const { data: payments, error: payErr } = await supabase
      .from("cash_payments")
      .select("member_id, paid_on, period_end")
      .eq("dojo_id", data.dojoId)
      .in(
        "member_id",
        members.map((m: any) => m.id),
      );
    if (payErr) throw payErr;

    const today = new Date().toISOString().slice(0, 10);
    const byMember = new Map<string, { lastPaidOn: string | null; coveredThrough: string | null }>();
    for (const p of payments ?? []) {
      const cur = byMember.get(p.member_id) ?? { lastPaidOn: null, coveredThrough: null };
      if (!cur.lastPaidOn || p.paid_on > cur.lastPaidOn) cur.lastPaidOn = p.paid_on;
      if (!cur.coveredThrough || p.period_end > cur.coveredThrough) cur.coveredThrough = p.period_end;
      byMember.set(p.member_id, cur);
    }

    const { familyTotalForPayer } = await import("@/lib/family-pricing.server");

    const rows: CashDueRow[] = [];
    for (const m of members as any[]) {
      const info = byMember.get(m.id) ?? { lastPaidOn: null, coveredThrough: null };
      const covered = !!info.coveredThrough && info.coveredThrough >= today;
      if (covered) continue;
      const period = currentPeriod(m.dojo_plans.interval);
      const dueDate = dueDateFor(period.start, grace);
      // A cash family payer owes the discounted FAMILY total, not just their
      // own plan price — everyone else in the family is covered by them.
      const family = await familyTotalForPayer(supabase, data.dojoId, m.id);
      rows.push({
        memberId: m.id,
        name: m.name,
        email: m.email,
        planName: family
          ? `Family plan · ${family.size} members`
          : (m.dojo_plans.name ?? null),
        amountDueCents: family ? family.totalCents : m.dojo_plans.price_cents,
        currency: (
          family?.currency ??
          m.dojo_plans.currency ??
          fallbackCurrency
        ).toLowerCase(),
        periodStart: period.start,
        periodEnd: period.end,
        dueDate,
        daysOverdue: today > dueDate ? daysBetween(dueDate, today) : 0,
        lastPaymentOn: info.lastPaidOn,
        paymentStatus: m.payment_status ?? null,
      });
    }


    rows.sort((a, b) => b.daysOverdue - a.daysOverdue || a.name.localeCompare(b.name));
    return rows;
  });

/**
 * One-tap "Paid this month". Records a cash payment for the member's current
 * billing period at their plan price (dated today) — or removes the payments
 * covering that period when it is already marked paid.
 */
export const togglePaidThisPeriod = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberId: string }) => d)
  .handler(async ({ data, context }): Promise<{ paid: boolean; period: { start: string; end: string } }> => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "togglePaidThisPeriod");

    const { data: member, error: memberErr } = await supabase
      .from("members")
      .select(
        "id, payment_method, plan_covered_by, dojo_plans:selected_plan_id(price_cents, currency, interval)",
      )
      .eq("id", data.memberId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (memberErr) throw memberErr;
    if (!member) throw new Error("Member not found in this gym");
    if ((member as any).plan_covered_by) {
      throw new Error("This member is covered by a family plan — record the payment on the payer.");
    }
    const plan = (member as any).dojo_plans as
      | { price_cents: number; currency: string | null; interval: string | null }
      | null;
    if (!plan || !plan.price_cents) {
      throw new Error("Assign a plan with a price before marking this member as paid");
    }

    const period = currentPeriod(plan.interval);

    // Anything covering this period counts as paid.
    const { data: existing, error: exErr } = await supabase
      .from("cash_payments")
      .select("id")
      .eq("dojo_id", data.dojoId)
      .eq("member_id", data.memberId)
      .lte("period_start", period.end)
      .gte("period_end", period.start);
    if (exErr) throw exErr;

    if ((existing ?? []).length > 0) {
      const { error } = await supabase
        .from("cash_payments")
        .delete()
        .eq("dojo_id", data.dojoId)
        .in(
          "id",
          (existing ?? []).map((r: any) => r.id),
        );
      if (error) throw error;
      await resyncAfterCashChange(data.dojoId, data.memberId);
      return { paid: false, period };
    }

    const { data: dojo } = await supabase
      .from("dojos")
      .select("default_currency")
      .eq("id", data.dojoId)
      .maybeSingle();

    // A cash family payer pays the discounted family total for everyone.
    const { familyTotalForPayer } = await import("@/lib/family-pricing.server");
    const family = await familyTotalForPayer(supabase, data.dojoId, data.memberId);

    const { error } = await supabase.from("cash_payments").insert({
      dojo_id: data.dojoId,
      member_id: data.memberId,
      amount_cents: family ? family.totalCents : plan.price_cents,
      currency: (
        family?.currency ??
        plan.currency ??
        dojo?.default_currency ??
        "usd"
      ).toLowerCase(),
      paid_on: new Date().toISOString().slice(0, 10),
      period_start: period.start,
      period_end: period.end,
      recorded_by: userId,
      note: family
        ? `Family plan — ${family.size} members (${family.discountPercent}% family discount)`
        : null,
    });

    if (error) throw error;
    await resyncAfterCashChange(data.dojoId, data.memberId);
    return { paid: true, period };
  });

/**
 * Switch members between card and cash.
 *
 * Hard rule: the payer's method governs the whole family. Switching a family
 * payer moves the entire arrangement (card → cash cancels the subscription and
 * starts expecting the discounted total in cash; cash → card starts it again),
 * and covered members can never hold their own method.
 */
export const setMembersPaymentMethod = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      dojoId: string;
      memberIds: string[];
      method: "card" | "cash";
      confirmKeepSubscription?: boolean;
      confirmFamilyChange?: boolean;
    }) => d,
  )
  .handler(
    async ({
      data,
      context,
    }): Promise<{
      updated: number;
      needsConfirm: { id: string; name: string; status: string }[];
      /** Family payers whose switch changes the whole family's arrangement. */
      needsFamilyConfirm: {
        id: string;
        name: string;
        coveredNames: string[];
        totalCents: number;
        currency: string;
        interval: string;
        liveSubscriptions: number;
        hasSavedCard: boolean;
      }[];
      familyNeedsCheckout: string[];
    }> => {
      const { supabase, userId } = context as any;
      await assertDojoStaff(supabase, userId, data.dojoId, "setMembersPaymentMethod");
      const ids = Array.from(new Set(data.memberIds)).filter(Boolean);
      if (ids.length === 0)
        return { updated: 0, needsConfirm: [], needsFamilyConfirm: [], familyNeedsCheckout: [] };

      // A family is one payment arrangement: covered members follow their
      // payer and can never hold their own method.
      const { data: involved } = await supabase
        .from("members")
        .select("id, name, plan_covered_by, family_group_id")
        .eq("dojo_id", data.dojoId)
        .in("id", ids);
      const coveredNames = ((involved ?? []) as any[])
        .filter((m) => m.plan_covered_by)
        .map((m) => m.name as string);
      if (coveredNames.length > 0) {
        throw new Error(
          `${coveredNames.join(", ")} ${coveredNames.length === 1 ? "is" : "are"} covered by a family payer, so they can't have their own payment method. Change the payer's payment method instead.`,
        );
      }

      // Split family payers out: their switch moves the whole family's billing.
      const { familyMethodEffect, applyFamilyMethodChange } = await import(
        "@/lib/family-actions.server"
      );
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const familyEffects: {
        id: string;
        effect: Awaited<ReturnType<typeof familyMethodEffect>>;
      }[] = [];
      for (const m of (involved ?? []) as any[]) {
        if (!m.family_group_id) continue;
        const effect = await familyMethodEffect({
          db: supabaseAdmin,
          dojoId: data.dojoId,
          memberId: m.id,
        });
        if (effect.isFamily) familyEffects.push({ id: m.id as string, effect });
      }
      const familyIds = new Set(familyEffects.map((f) => f.id));

      if (familyEffects.length > 0 && !data.confirmFamilyChange) {
        return {
          updated: 0,
          needsConfirm: [],
          needsFamilyConfirm: familyEffects.map(({ id, effect }) => ({
            id,
            name: effect.payer?.name ?? "Payer",
            coveredNames: effect.coveredNames,
            totalCents: effect.totalCents,
            currency: effect.currency,
            interval: effect.interval,
            liveSubscriptions: effect.liveSubscriptions,
            hasSavedCard: effect.hasSavedCard,
          })),
          familyNeedsCheckout: [],
        };
      }

      const soloIds = ids.filter((id) => !familyIds.has(id));

      if (data.method === "cash" && !data.confirmKeepSubscription && soloIds.length > 0) {
        const { data: subs, error } = await supabase
          .from("member_subscriptions")
          .select("member_id, status, members:member_id(name)")
          .eq("dojo_id", data.dojoId)
          .in("member_id", soloIds)
          .in("status", ["active", "trialing", "past_due"]);
        if (error) throw error;
        if ((subs ?? []).length > 0) {
          return {
            updated: 0,
            needsConfirm: (subs ?? []).map((s: any) => ({
              id: s.member_id,
              name: s.members?.name ?? "Member",
              status: s.status,
            })),
            needsFamilyConfirm: [],
            familyNeedsCheckout: [],
          };
        }
      }

      const familyNeedsCheckout: string[] = [];
      for (const { id, effect } of familyEffects) {
        const res = await applyFamilyMethodChange({
          dojoId: data.dojoId,
          payerId: id,
          method: data.method,
        });
        if (res.needsCheckout) familyNeedsCheckout.push(effect.payer?.name ?? "Payer");
        await resyncAfterCashChange(data.dojoId, id);
        const { data: covered } = await supabaseAdmin
          .from("members")
          .select("id")
          .eq("dojo_id", data.dojoId)
          .eq("plan_covered_by", id);
        for (const c of (covered ?? []) as any[]) {
          await resyncAfterCashChange(data.dojoId, c.id);
        }
      }

      if (soloIds.length > 0) {
        const { error } = await supabase
          .from("members")
          .update({ payment_method: data.method })
          .eq("dojo_id", data.dojoId)
          .in("id", soloIds);
        if (error) throw error;

        // Cascade to anyone they cover so nobody is both covered and separately
        // expected to pay.
        const { data: dependants } = await supabase
          .from("members")
          .update({ payment_method: data.method })
          .eq("dojo_id", data.dojoId)
          .in("plan_covered_by", soloIds)
          .select("id");

        // Card → cash must stop the subscription, verified against Stripe.
        const { enforceFamilyBillingInvariants } = await import(
          "@/lib/family-invariants.server"
        );
        await enforceFamilyBillingInvariants({
          dojoId: data.dojoId,
          memberIds: [...soloIds, ...((dependants ?? []) as any[]).map((d) => d.id)],
        });

        for (const id of soloIds) await resyncAfterCashChange(data.dojoId, id);
        for (const d of (dependants ?? []) as any[]) {
          await resyncAfterCashChange(data.dojoId, d.id);
        }

      }

      return {
        updated: ids.length,
        needsConfirm: [],
        needsFamilyConfirm: [],
        familyNeedsCheckout,
      };
    },
  );

/** Bulk "paid this month" — records the current period for each member. */
export const recordCashPaymentsForPeriod = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberIds: string[] }) => d)
  .handler(
    async ({ data, context }): Promise<{ recorded: number; skipped: { name: string; reason: string }[] }> => {
      const { supabase, userId } = context as any;
      await assertDojoStaff(supabase, userId, data.dojoId, "recordCashPaymentsForPeriod");
      const ids = Array.from(new Set(data.memberIds)).filter(Boolean);
      if (ids.length === 0) return { recorded: 0, skipped: [] };

      const [memRes, dojoRes] = await Promise.all([
        supabase
          .from("members")
          .select(
            "id, name, plan_covered_by, dojo_plans:selected_plan_id(price_cents, currency, interval)",
          )
          .eq("dojo_id", data.dojoId)
          .in("id", ids),
        supabase.from("dojos").select("default_currency").eq("id", data.dojoId).maybeSingle(),
      ]);
      if (memRes.error) throw memRes.error;
      const fallbackCurrency = (dojoRes.data?.default_currency ?? "usd").toLowerCase();

      const { data: existing, error: exErr } = await supabase
        .from("cash_payments")
        .select("member_id, period_start, period_end")
        .eq("dojo_id", data.dojoId)
        .in("member_id", ids);
      if (exErr) throw exErr;

      const skipped: { name: string; reason: string }[] = [];
      const rows: Record<string, unknown>[] = [];
      const today = new Date().toISOString().slice(0, 10);
      const { familyTotalForPayer } = await import("@/lib/family-pricing.server");

      for (const m of (memRes.data ?? []) as any[]) {
        if (m.plan_covered_by) {
          skipped.push({ name: m.name, reason: "covered by a family plan" });
          continue;
        }
        const plan = m.dojo_plans as { price_cents: number; currency: string | null; interval: string | null } | null;
        if (!plan?.price_cents) {
          skipped.push({ name: m.name, reason: "no priced plan" });
          continue;
        }
        const period = currentPeriod(plan.interval);
        const covered = (existing ?? []).some(
          (p: any) => p.member_id === m.id && p.period_start <= period.end && p.period_end >= period.start,
        );
        if (covered) {
          skipped.push({ name: m.name, reason: "already paid for this period" });
          continue;
        }
        const family = await familyTotalForPayer(supabase, data.dojoId, m.id);
        rows.push({
          dojo_id: data.dojoId,
          member_id: m.id,
          amount_cents: family ? family.totalCents : plan.price_cents,
          currency: (family?.currency ?? plan.currency ?? fallbackCurrency).toLowerCase(),
          paid_on: today,

          period_start: period.start,
          period_end: period.end,
          recorded_by: userId,
          note: null,
        });
      }

      if (rows.length > 0) {
        const { error } = await supabase.from("cash_payments").insert(rows as never);
        if (error) throw error;
        for (const r of rows) await resyncAfterCashChange(data.dojoId, r["member_id"] as string);
      }
      return { recorded: rows.length, skipped };
    },
  );
