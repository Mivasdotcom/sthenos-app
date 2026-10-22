import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertManager(supabase: any, dojoId: string, userId: string) {
  const { data } = await supabase
    .from("dojo_memberships")
    .select("role")
    .eq("dojo_id", dojoId)
    .eq("user_id", userId)
    .single();
  if (!data || !["owner", "admin"].includes(data.role)) {
    throw new Error("Unauthorized");
  }
}

export type OverheadCategory =
  | "rent"
  | "utilities"
  | "payroll"
  | "equipment"
  | "marketing"
  | "insurance"
  | "software"
  | "other";

export type OverheadRecurrence = "one_off" | "monthly" | "yearly";

export type Overhead = {
  id: string;
  dojo_id: string;
  name: string;
  category: OverheadCategory;
  amount_cents: number;
  currency: string;
  recurrence: OverheadRecurrence;
  starts_on: string; // YYYY-MM-DD
  ends_on: string | null;
  notes: string | null;
  is_active: boolean;
};

export type ManualRevenue = {
  id: string;
  dojo_id: string;
  description: string;
  amount_cents: number;
  currency: string;
  received_on: string;
  category: string | null;
  notes: string | null;
};

// ---------------- Overheads ----------------

export const listOverheads = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; includeArchived?: boolean }) => d)
  .handler(async ({ data, context }) => {
    const { supabase } = context as any;
    let q = supabase
      .from("dojo_overheads")
      .select("*")
      .eq("dojo_id", data.dojoId)
      .order("created_at", { ascending: false });
    if (!data.includeArchived) q = q.eq("is_active", true);
    const { data: rows, error } = await q;
    if (error) throw error;
    return { overheads: (rows ?? []) as Overhead[] };
  });

export const upsertOverhead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      id?: string;
      dojoId: string;
      name: string;
      category: OverheadCategory;
      amountCents: number;
      currency?: string;
      recurrence: OverheadRecurrence;
      startsOn: string;
      endsOn?: string | null;
      notes?: string | null;
      isActive?: boolean;
    }) => d,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertManager(supabase, data.dojoId, userId);
    const payload = {
      dojo_id: data.dojoId,
      name: data.name.trim(),
      category: data.category,
      amount_cents: Math.max(0, Math.round(data.amountCents)),
      currency: (data.currency ?? "usd").toLowerCase(),
      recurrence: data.recurrence,
      starts_on: data.startsOn,
      ends_on: data.endsOn || null,
      notes: data.notes?.trim() || null,
      is_active: data.isActive ?? true,
    };
    if (data.id) {
      const { data: row, error } = await supabase
        .from("dojo_overheads")
        .update(payload)
        .eq("id", data.id)
        .eq("dojo_id", data.dojoId)
        .select("*")
        .single();
      if (error) throw error;
      return { overhead: row as Overhead };
    }
    const { data: row, error } = await supabase
      .from("dojo_overheads")
      .insert(payload)
      .select("*")
      .single();
    if (error) throw error;
    return { overhead: row as Overhead };
  });

export const archiveOverhead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; dojoId: string; archived: boolean }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertManager(supabase, data.dojoId, userId);
    const { error } = await supabase
      .from("dojo_overheads")
      .update({ is_active: !data.archived })
      .eq("id", data.id)
      .eq("dojo_id", data.dojoId);
    if (error) throw error;
    return { ok: true };
  });

export const deleteOverhead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertManager(supabase, data.dojoId, userId);
    const { error } = await supabase
      .from("dojo_overheads")
      .delete()
      .eq("id", data.id)
      .eq("dojo_id", data.dojoId);
    if (error) throw error;
    return { ok: true };
  });

// ---------------- Manual revenue ----------------

export const listManualRevenue = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase } = context as any;
    const { data: rows, error } = await supabase
      .from("manual_revenue")
      .select("*")
      .eq("dojo_id", data.dojoId)
      .order("received_on", { ascending: false });
    if (error) throw error;
    return { entries: (rows ?? []) as ManualRevenue[] };
  });

export const upsertManualRevenue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      id?: string;
      dojoId: string;
      description: string;
      amountCents: number;
      currency?: string;
      receivedOn: string;
      category?: string | null;
      notes?: string | null;
    }) => d,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertManager(supabase, data.dojoId, userId);
    const payload = {
      dojo_id: data.dojoId,
      description: data.description.trim(),
      amount_cents: Math.max(0, Math.round(data.amountCents)),
      currency: (data.currency ?? "usd").toLowerCase(),
      received_on: data.receivedOn,
      category: data.category?.trim() || null,
      notes: data.notes?.trim() || null,
    };
    if (data.id) {
      const { data: row, error } = await supabase
        .from("manual_revenue")
        .update(payload)
        .eq("id", data.id)
        .select("*")
        .single();
      if (error) throw error;
      return { entry: row as ManualRevenue };
    }
    const { data: row, error } = await supabase
      .from("manual_revenue")
      .insert(payload)
      .select("*")
      .single();
    if (error) throw error;
    return { entry: row as ManualRevenue };
  });

export const deleteManualRevenue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    const { data: row } = await supabase
      .from("manual_revenue")
      .select("dojo_id")
      .eq("id", data.id)
      .single();
    if (!row) throw new Error("Not found");
    await assertManager(supabase, row.dojo_id, userId);
    const { error } = await supabase.from("manual_revenue").delete().eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });

// ---------------- P&L ----------------

export type MonthlyPnLPoint = {
  month: string; // YYYY-MM
  revenue_cents: number;
  overhead_cents: number;
  net_cents: number;
};

function monthKey(d: Date) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function lastNMonths(n: number): string[] {
  const now = new Date();
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(monthKey(d));
  }
  return out;
}

function overlapsMonth(
  recurrence: OverheadRecurrence,
  startsOn: string,
  endsOn: string | null,
  monthYM: string,
): number {
  // Returns the amount-multiplier for that month (0, 1, or 1/12 handled by caller).
  const [y, m] = monthYM.split("-").map(Number);
  const monthStart = Date.UTC(y, m - 1, 1);
  const monthEnd = Date.UTC(y, m, 0); // last day inclusive
  const start = Date.parse(startsOn + "T00:00:00Z");
  const end = endsOn ? Date.parse(endsOn + "T00:00:00Z") : Infinity;
  if (recurrence === "one_off") {
    return start >= monthStart && start <= monthEnd ? 1 : 0;
  }
  // monthly + yearly: active if month overlaps [start, end]
  return start <= monthEnd && end >= monthStart ? 1 : 0;
}

export const getMonthlyPnL = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; months?: number }) => d)
  .handler(async ({ data, context }) => {
    const { supabase } = context as any;
    const months = Math.max(1, Math.min(24, data.months ?? 6));
    const keys = lastNMonths(months);
    const firstMonthStart = `${keys[0]}-01`;

    const [
      { data: overheads, error: ohErr },
      { data: invoices, error: invErr },
      { data: manual, error: manErr },
      { data: cash, error: cashErr },
    ] = await Promise.all([
      supabase
        .from("dojo_overheads")
        .select("amount_cents,recurrence,starts_on,ends_on,is_active")
        .eq("dojo_id", data.dojoId)
        .eq("is_active", true),
      supabase
        .from("invoices")
        .select(
          "id,amount_cents,paid_at,status,subscription_id,period_start,period_end,invoice_line_items(amount_cents)",
        )
        .eq("dojo_id", data.dojoId)
        .eq("status", "paid")
        .gte("paid_at", firstMonthStart + "T00:00:00Z"),
      supabase
        .from("manual_revenue")
        .select("amount_cents,received_on")
        .eq("dojo_id", data.dojoId)
        .gte("received_on", firstMonthStart),
      supabase
        .from("cash_payments")
        .select("amount_cents,paid_on")
        .eq("dojo_id", data.dojoId)
        .gte("paid_on", firstMonthStart),
    ]);
    if (ohErr) throw ohErr;
    if (invErr) throw invErr;
    if (manErr) throw manErr;
    if (cashErr) throw cashErr;

    const map = new Map<string, MonthlyPnLPoint>(
      keys.map((k) => [k, { month: k, revenue_cents: 0, overhead_cents: 0, net_cents: 0 }]),
    );

    // Spread an amount across the months overlapping [periodStart, periodEnd], pro-rated by days.
    function spreadAcrossPeriod(
      amount: number,
      periodStart: Date,
      periodEnd: Date,
    ): Array<{ month: string; cents: number }> {
      const msPerDay = 86400000;
      const totalDays = Math.max(
        1,
        Math.round((periodEnd.getTime() - periodStart.getTime()) / msPerDay) + 1,
      );
      const buckets: Array<{ month: string; cents: number }> = [];
      let cursor = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth(), 1));
      while (cursor <= periodEnd) {
        const monthStart = cursor;
        const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
        const overlapStart = monthStart > periodStart ? monthStart : periodStart;
        const overlapEnd = monthEnd < periodEnd ? monthEnd : periodEnd;
        const days = Math.max(
          0,
          Math.round((overlapEnd.getTime() - overlapStart.getTime()) / msPerDay) + 1,
        );
        if (days > 0) {
          buckets.push({
            month: monthKey(monthStart),
            cents: (amount * days) / totalDays,
          });
        }
        cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
      }
      // Fix rounding drift onto the last bucket.
      if (buckets.length > 0) {
        const sum = buckets.reduce((s, b) => s + b.cents, 0);
        buckets[buckets.length - 1].cents += amount - sum;
      }
      return buckets;
    }

    for (const inv of (invoices ?? []) as any[]) {
      if (!inv.paid_at) continue;
      // Prefer line-item sum when present (allows partial/itemized billing).
      const lineSum =
        Array.isArray(inv.invoice_line_items) && inv.invoice_line_items.length > 0
          ? inv.invoice_line_items.reduce(
              (s: number, li: { amount_cents: number }) => s + (li.amount_cents ?? 0),
              0,
            )
          : inv.amount_cents;

      // Subscription invoices with an explicit billing period: pro-rate across the period.
      if (inv.subscription_id && inv.period_start && inv.period_end) {
        const ps = new Date(inv.period_start);
        const pe = new Date(inv.period_end);
        for (const b of spreadAcrossPeriod(lineSum, ps, pe)) {
          const p = map.get(b.month);
          if (p) p.revenue_cents += b.cents;
        }
      } else {
        const k = monthKey(new Date(inv.paid_at));
        const p = map.get(k);
        if (p) p.revenue_cents += lineSum;
      }
    }
    for (const m of manual ?? []) {
      const k = m.received_on.slice(0, 7);
      const p = map.get(k);
      if (p) p.revenue_cents += m.amount_cents;
    }
    for (const payment of cash ?? []) {
      const p = map.get(payment.paid_on.slice(0, 7));
      if (p) p.revenue_cents += payment.amount_cents;
    }
    for (const oh of overheads ?? []) {
      for (const k of keys) {
        const active = overlapsMonth(
          oh.recurrence as OverheadRecurrence,
          oh.starts_on,
          oh.ends_on,
          k,
        );
        if (!active) continue;
        const monthly =
          oh.recurrence === "yearly"
            ? oh.amount_cents / 12
            : oh.recurrence === "monthly"
              ? oh.amount_cents
              : oh.amount_cents; // one_off counted in its single month
        const p = map.get(k);
        if (p) p.overhead_cents += monthly;
      }
    }
    for (const p of map.values()) {
      p.revenue_cents = Math.round(p.revenue_cents);
      p.overhead_cents = Math.round(p.overhead_cents);
      p.net_cents = p.revenue_cents - p.overhead_cents;
    }
    return { points: keys.map((k) => map.get(k)!) };
  });
