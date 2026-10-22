// Shared revenue metrics. Source of truth: dojo_plans, member_subscriptions,
// invoices. Everything is aggregated per plan-currency; dojos with mixed
// currencies are displayed per-currency rather than summed across.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type CurrencyBucket = {
  currency: string;
  mrrCents: number;
  arrCents: number;
  activeSubscriptions: number;
  /** Members on a plan the gym bills in cash, counted in MRR, no Stripe sub. */
  cashMembers: number;
  payingMembers: number;
  ltvCents: number; // avg lifetime paid per paying member
  overdueCents: number;
  overdueCount: number;
  revenueThisMonthCents: number;
  revenueLastMonthCents: number;
  outstandingThisMonthCents: number; // max(0, mrr - collected this month)
  revenueByMonth: { month: string; cents: number }[]; // last 12 months
  revenueByPlan: { plan: string; cents: number }[]; // lifetime paid
};

export type RevenueSummary = {
  generatedAt: string;
  defaultCurrency: string;
  hasAnyPaymentData: boolean;
  currencies: CurrencyBucket[]; // sorted, default currency first
};

function monthKey(d: Date) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function normalizeMonthlyCents(priceCents: number, interval: string | null | undefined) {
  const iv = (interval ?? "month").toLowerCase();
  if (iv === "year" || iv === "yearly" || iv === "annual") return priceCents / 12;
  if (iv === "week" || iv === "weekly") return priceCents * 4.345;
  if (iv === "day" || iv === "daily") return priceCents * 30.44;
  return priceCents; // month/monthly default
}

export const getRevenueSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }): Promise<RevenueSummary> => {
    const { supabase } = context as any;

    const [dojoRes, subsRes, invRes, cashRes, cashMembersRes] = await Promise.all([
      supabase.from("dojos").select("default_currency").eq("id", data.dojoId).maybeSingle(),
      supabase
        .from("member_subscriptions")
        .select(
          "member_id,status,plan_id,dojo_plans:plan_id(id,name,price_cents,currency,interval)",
        )
        .eq("dojo_id", data.dojoId)
        .in("status", ["active", "trialing"]),
      supabase
        .from("invoices")
        .select("member_id,amount_cents,currency,status,paid_at,due_date,plan")
        .eq("dojo_id", data.dojoId),
      supabase
        .from("cash_payments")
        .select(
          "member_id,amount_cents,currency,paid_on,members:member_id(selected_plan_id,dojo_plans:selected_plan_id(name))",
        )
        .eq("dojo_id", data.dojoId),
      // Members the gym bills in cash. They pay every month like anybody else,
      // but hold no Stripe subscription, so recurring revenue used to leave
      // them out entirely -- a gym with a third of its members on cash saw an
      // MRR a third short, and no clue why.
      supabase
        .from("members")
        .select(
          "id,status,payment_method,selected_plan_id,dojo_plans:selected_plan_id(id,name,price_cents,currency,interval)",
        )
        .eq("dojo_id", data.dojoId)
        .eq("payment_method", "cash")
        .in("status", ["active", "trial"]),
    ]);

    const defaultCurrency = (dojoRes.data?.default_currency ?? "usd").toLowerCase();
    const subs = (subsRes.data ?? []) as any[];
    const invoices = (invRes.data ?? []) as any[];
    const cashPayments = (cashRes.data ?? []) as any[];
    const cashMembers = (cashMembersRes.data ?? []) as any[];

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const prevMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const months: string[] = [];
    for (let i = 11; i >= 0; i--) {
      months.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
    }

    const buckets = new Map<string, CurrencyBucket>();
    const bucket = (cur: string): CurrencyBucket => {
      const key = (cur || defaultCurrency).toLowerCase();
      let b = buckets.get(key);
      if (!b) {
        b = {
          currency: key,
          mrrCents: 0,
          arrCents: 0,
          activeSubscriptions: 0,
          cashMembers: 0,
          payingMembers: 0,
          ltvCents: 0,
          overdueCents: 0,
          overdueCount: 0,
          revenueThisMonthCents: 0,
          revenueLastMonthCents: 0,
          outstandingThisMonthCents: 0,
          revenueByMonth: months.map((m) => ({ month: m, cents: 0 })),
          revenueByPlan: [],
        };
        buckets.set(key, b);
      }
      return b!;
    };

    // MRR from active/trialing subscriptions, per plan currency
    const subscribedMemberIds = new Set<string>();
    for (const s of subs) {
      subscribedMemberIds.add(s.member_id);
      const plan = s.dojo_plans;
      if (!plan) continue;
      const b = bucket(plan.currency);
      b.mrrCents += normalizeMonthlyCents(plan.price_cents ?? 0, plan.interval);
      b.activeSubscriptions += 1;
    }

    // Cash members count towards recurring revenue on the plan the gym put
    // them on. Anyone who also holds a live subscription is skipped, so a
    // member who moved from cash to card is never counted twice.
    for (const m of cashMembers) {
      if (subscribedMemberIds.has(m.id)) continue;
      const plan = m.dojo_plans;
      if (!plan) continue;
      const b = bucket(plan.currency);
      b.mrrCents += normalizeMonthlyCents(plan.price_cents ?? 0, plan.interval);
      b.cashMembers += 1;
    }

    // Invoice-driven revenue, overdue, LTV, revenue-by-plan
    const paidByMember = new Map<string, Map<string, number>>(); // currency -> memberId -> cents
    const planTotals = new Map<string, Map<string, number>>(); // currency -> plan -> cents
    for (const inv of invoices) {
      const b = bucket(inv.currency);
      const amt = inv.amount_cents ?? 0;
      const isPaid = inv.status === "paid" && inv.paid_at;
      const isOverdue =
        inv.status === "overdue" ||
        (inv.status === "due" && inv.due_date && new Date(inv.due_date) < now);
      if (isPaid) {
        const paidAt = new Date(inv.paid_at);
        if (paidAt >= monthStart) b.revenueThisMonthCents += amt;
        else if (paidAt >= prevMonthStart && paidAt < monthStart) b.revenueLastMonthCents += amt;
        const k = monthKey(paidAt);
        const row = b.revenueByMonth.find((x) => x.month === k);
        if (row) row.cents += amt;

        let byMember = paidByMember.get(b.currency);
        if (!byMember) {
          byMember = new Map();
          paidByMember.set(b.currency, byMember);
        }
        byMember.set(inv.member_id, (byMember.get(inv.member_id) ?? 0) + amt);

        let byPlan = planTotals.get(b.currency);
        if (!byPlan) {
          byPlan = new Map();
          planTotals.set(b.currency, byPlan);
        }
        const plan = inv.plan ?? "Unknown";
        byPlan.set(plan, (byPlan.get(plan) ?? 0) + amt);
      }
      if (isOverdue) {
        b.overdueCents += amt;
        b.overdueCount += 1;
      }
    }

    // Cash is money received just like a paid card invoice. It contributes to
    // collected revenue, member LTV, monthly history and plan totals exactly
    // once, while remaining distinguishable as a payment method in listings.
    for (const payment of cashPayments) {
      const b = bucket(payment.currency);
      const amt = payment.amount_cents ?? 0;
      const paidAt = new Date(`${payment.paid_on}T00:00:00Z`);
      if (paidAt >= monthStart) b.revenueThisMonthCents += amt;
      else if (paidAt >= prevMonthStart && paidAt < monthStart) b.revenueLastMonthCents += amt;
      const row = b.revenueByMonth.find((x) => x.month === monthKey(paidAt));
      if (row) row.cents += amt;

      let byMember = paidByMember.get(b.currency);
      if (!byMember) {
        byMember = new Map();
        paidByMember.set(b.currency, byMember);
      }
      byMember.set(payment.member_id, (byMember.get(payment.member_id) ?? 0) + amt);

      let byPlan = planTotals.get(b.currency);
      if (!byPlan) {
        byPlan = new Map();
        planTotals.set(b.currency, byPlan);
      }
      const plan = payment.members?.dojo_plans?.name ?? "Cash payment";
      byPlan.set(plan, (byPlan.get(plan) ?? 0) + amt);
    }

    for (const [cur, byMember] of paidByMember.entries()) {
      const b = bucket(cur);
      const totals = [...byMember.values()];
      b.payingMembers = totals.length;
      b.ltvCents = totals.length
        ? Math.round(totals.reduce((a, x) => a + x, 0) / totals.length)
        : 0;
    }
    for (const [cur, byPlan] of planTotals.entries()) {
      const b = bucket(cur);
      b.revenueByPlan = [...byPlan.entries()]
        .map(([plan, cents]) => ({ plan, cents }))
        .sort((a, b) => b.cents - a.cents);
    }

    for (const b of buckets.values()) {
      b.mrrCents = Math.round(b.mrrCents);
      b.arrCents = b.mrrCents * 12;
      b.outstandingThisMonthCents = Math.max(0, b.mrrCents - b.revenueThisMonthCents);
      b.revenueByMonth = b.revenueByMonth.map((m) => ({
        month: m.month,
        cents: Math.round(m.cents),
      }));
    }

    // Guarantee the default currency bucket exists so UI always has something to render.
    bucket(defaultCurrency);

    // Lifetime paid volume per currency (used to rank activity).
    const lifetimePaid = new Map<string, number>();
    for (const [cur, byMember] of paidByMember.entries()) {
      lifetimePaid.set(
        cur,
        [...byMember.values()].reduce((a, x) => a + x, 0),
      );
    }
    const activity = (b: CurrencyBucket) =>
      b.revenueThisMonthCents + b.mrrCents + (lifetimePaid.get(b.currency) ?? 0);
    const hasActivity = (b: CurrencyBucket) => activity(b) > 0 || b.activeSubscriptions > 0;

    const all = [...buckets.values()];
    const anyActivity = all.some(hasActivity);

    // Only surface currencies with real activity. When nothing has activity at
    // all, keep the default-currency bucket so the UI can render its zero/empty
    // state rather than crashing on an empty list.
    const visible = anyActivity
      ? all.filter(hasActivity)
      : all.filter((b) => b.currency === defaultCurrency);

    const list = visible.sort((a, b) => {
      if (anyActivity) {
        const diff = activity(b) - activity(a);
        if (diff !== 0) return diff;
      } else {
        if (a.currency === defaultCurrency) return -1;
        if (b.currency === defaultCurrency) return 1;
      }
      return a.currency.localeCompare(b.currency);
    });

    const hasAnyPaymentData =
      subs.length > 0 ||
      cashPayments.length > 0 ||
      invoices.some((i) => i.status === "paid" || i.status === "overdue" || i.status === "due");

    return {
      generatedAt: new Date().toISOString(),
      defaultCurrency,
      hasAnyPaymentData,
      currencies: list,
    };
  });

// Client-side helper (safe to import from components): format cents in a
// currency, using the browser locale.
export function formatMoney(cents: number, currency: string) {
  const cur = (currency || "usd").toUpperCase();
  try {
    return (cents / 100).toLocaleString(undefined, {
      style: "currency",
      currency: cur,
      maximumFractionDigits: 0,
    });
  } catch {
    return `${cur} ${(cents / 100).toFixed(0)}`;
  }
}
