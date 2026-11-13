import { createServerFn } from "@tanstack/react-start";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { scoreRetentionRisk } from "@/lib/retention";
import { assessReadiness } from "@/lib/belt-readiness";
import { assertDojoStaff } from "@/lib/dojo-access";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { BookingOutcome } from "./retention";
import { callSensei } from "./sensei-llm.server";
import { envOr } from "./env.ts";

type Tables = Database["public"]["Tables"];
type TableRow<T extends keyof Tables> = Tables[T]["Row"];

/** Joined plan price, as selected through the `dojo_plans` alias. */
type JoinedPlan = Pick<TableRow<"dojo_plans">, "price_cents" | "currency" | "interval"> | null;

// Row shapes of the snapshot queries in buildSnapshot. Each lists exactly the
// columns that query selects.
type InvoiceRow = Pick<
  TableRow<"invoices">,
  "id" | "member_id" | "amount_cents" | "currency" | "status" | "paid_at" | "due_date" | "plan"
>;
type MemberRow = Pick<
  TableRow<"members">,
  | "id"
  | "name"
  | "status"
  | "plan"
  | "discipline"
  | "belt_color"
  | "stripes"
  | "joined_at"
  | "last_seen_at"
  | "lead_source"
  | "referred_by"
  | "payment_method"
  | "selected_plan_id"
> & { dojo_plans: JoinedPlan };
type AttendanceRow = Pick<TableRow<"attendances">, "class_id" | "checked_in_at" | "member_id">;
type ClassRow = Pick<TableRow<"classes">, "id" | "name" | "capacity" | "weekday">;
type PromotionRow = Pick<
  TableRow<"promotions">,
  "id" | "member_id" | "discipline" | "to_color" | "to_label" | "promoted_at"
>;
type SubscriptionRow = Pick<TableRow<"member_subscriptions">, "member_id" | "status"> & {
  dojo_plans: JoinedPlan;
};
type BookingRow = Pick<TableRow<"class_bookings">, "member_id" | "status" | "booked_for_date">;

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(4000),
});

// Where the user is, and nothing more. `visibleText` -- a copy of the page --
// used to be accepted here; it is refused now, so an old client that still
// sends it gets nothing through. What reaches the AI is the aggregate
// snapshot and what the user typed.
const PageContextSchema = z
  .object({
    path: z.string().max(200).optional(),
    title: z.string().max(200).optional(),
    heading: z.string().max(200).optional(),
  })
  .strip()
  .optional();

const InputSchema = z.object({
  messages: z.array(MessageSchema).min(1).max(40),
  snapshot: z.record(z.unknown()).optional(),
  pageContext: PageContextSchema,
  dojoId: z.string().uuid(),
});

function monthKey(d: Date) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function daysBetween(a: Date, b: Date) {
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}

async function buildSnapshot(supabase: SupabaseClient<Database>, dojoId: string) {
  const [inv, mem, att, cls, pro, subs, dojoRow, bk] = await Promise.all([
    supabase
      .from("invoices")
      .select("id,member_id,amount_cents,currency,status,paid_at,due_date,plan")
      .eq("dojo_id", dojoId),
    supabase
      .from("members")
      .select(
        "id,name,status,plan,discipline,belt_color,stripes,joined_at,last_seen_at,lead_source,referred_by,payment_method,selected_plan_id,dojo_plans:selected_plan_id(price_cents,currency,interval)",
      )
      .eq("dojo_id", dojoId),
    supabase.from("attendances").select("class_id,checked_in_at,member_id").eq("dojo_id", dojoId),
    supabase.from("classes").select("id,name,capacity,weekday").eq("dojo_id", dojoId),
    supabase
      .from("promotions")
      .select("id,member_id,discipline,to_color,to_label,promoted_at")
      .eq("dojo_id", dojoId),
    supabase
      .from("member_subscriptions")
      .select("member_id,status,dojo_plans:plan_id(price_cents,currency,interval)")
      .eq("dojo_id", dojoId)
      .in("status", ["active", "trialing"]),
    supabase.from("dojos").select("default_currency").eq("id", dojoId).maybeSingle(),
    supabase
      .from("class_bookings")
      .select("member_id,status,booked_for_date")
      .eq("dojo_id", dojoId),
  ]);

  const invoices = (inv.data ?? []) as InvoiceRow[];
  const members = (mem.data ?? []) as MemberRow[];
  const attendances = (att.data ?? []) as AttendanceRow[];
  const classes = (cls.data ?? []) as ClassRow[];
  const promotions = (pro.data ?? []) as PromotionRow[];
  const subscriptions = (subs.data ?? []) as SubscriptionRow[];
  const defaultCurrency = ((dojoRow.data?.default_currency ?? "usd") as string).toLowerCase();

  const now = new Date();
  const months: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(monthKey(d));
  }

  // Real MRR: sum of ACTIVE subscription plan prices, normalized to monthly,
  // aggregated per plan-currency. This is the source of truth — invoices
  // capture historical revenue but not future contractual MRR.
  const mrrByCurrency = new Map<string, number>();
  const normalize = (cents: number, interval: string | null | undefined) => {
    const iv = (interval ?? "month").toLowerCase();
    if (iv === "year" || iv === "yearly" || iv === "annual") return cents / 12;
    if (iv === "week" || iv === "weekly") return cents * 4.345;
    if (iv === "day" || iv === "daily") return cents * 30.44;
    return cents;
  };
  for (const s of subscriptions) {
    const plan = s.dojo_plans;
    if (!plan) continue;
    const cur = ((plan.currency ?? defaultCurrency) as string).toLowerCase();
    mrrByCurrency.set(
      cur,
      (mrrByCurrency.get(cur) ?? 0) + normalize(plan.price_cents ?? 0, plan.interval),
    );
  }
  // Cash members pay monthly on a plan without holding a Stripe subscription,
  // so they belong in recurring revenue too -- and must match what the
  // dashboard reports, or the assistant and the page contradict each other.
  const subscribedIds = new Set(subscriptions.map((s) => s.member_id));
  for (const m of members) {
    if (m.payment_method !== "cash") continue;
    if (!["active", "trial"].includes(String(m.status))) continue;
    // Someone who moved from cash to card holds both; count them once.
    if (subscribedIds.has(m.id)) continue;
    const plan = m.dojo_plans;
    if (!plan) continue;
    const cur = ((plan.currency ?? defaultCurrency) as string).toLowerCase();
    mrrByCurrency.set(
      cur,
      (mrrByCurrency.get(cur) ?? 0) + normalize(plan.price_cents ?? 0, plan.interval),
    );
  }
  const currentMRR = Math.round(mrrByCurrency.get(defaultCurrency) ?? 0);

  // Historical revenue collected, per month, using paid invoices in the
  // default currency. Mixed-currency dojos see revenueByCurrency separately.
  const revenueByMonth = new Map(months.map((m) => [m, 0]));
  const revenueByCurrency = new Map<string, number>();
  invoices.forEach((i) => {
    if (i.status !== "paid" || !i.paid_at) return;
    const cur = ((i.currency ?? defaultCurrency) as string).toLowerCase();
    revenueByCurrency.set(cur, (revenueByCurrency.get(cur) ?? 0) + (i.amount_cents ?? 0));
    if (cur !== defaultCurrency) return;
    const k = monthKey(new Date(i.paid_at));
    if (revenueByMonth.has(k)) revenueByMonth.set(k, (revenueByMonth.get(k) ?? 0) + i.amount_cents);
  });
  const currentMonthRevenue = revenueByMonth.get(months[11]) ?? 0;
  const prevMonthRevenue = revenueByMonth.get(months[10]) ?? 0;
  const mrrDeltaPct = prevMonthRevenue
    ? ((currentMonthRevenue - prevMonthRevenue) / prevMonthRevenue) * 100
    : 0;

  const active = members.filter((m) => m.status === "active").length;
  const lapsed = members.filter((m) => m.status === "lapsed").length;
  const trial = members.filter((m) => m.status === "trial").length;
  const churnPct = members.length ? (lapsed / members.length) * 100 : 0;

  const paidByMember = new Map<string | null, number>();
  invoices.forEach((i) => {
    if (i.status !== "paid") return;
    const cur = ((i.currency ?? defaultCurrency) as string).toLowerCase();
    if (cur !== defaultCurrency) return;
    paidByMember.set(i.member_id, (paidByMember.get(i.member_id) ?? 0) + i.amount_cents);
  });
  const payers = [...paidByMember.values()];
  const ltv = payers.length ? payers.reduce((a, b) => a + b, 0) / payers.length : 0;

  // attendance by month
  const attByMonth = months.slice(-6).map((m) => {
    const [y, mm] = m.split("-").map(Number);
    const start = new Date(Date.UTC(y, mm - 1, 1));
    const end = new Date(Date.UTC(y, mm, 1));
    const count = attendances.filter((a) => {
      const t = new Date(a.checked_in_at);
      return t >= start && t < end;
    }).length;
    return { month: m, checkins: count };
  });

  // class fill last 8 weeks
  const eightWeeksAgo = new Date(Date.now() - 8 * 7 * 86400000);
  const classById = new Map(classes.map((c) => [c.id, c]));
  const sessionMap = new Map<string, { count: number; capacity: number; name: string }>();
  attendances.forEach((a) => {
    if (!a.class_id) return;
    const t = new Date(a.checked_in_at);
    if (t < eightWeeksAgo) return;
    const c = classById.get(a.class_id);
    if (!c) return;
    const wk = Math.floor(t.getTime() / (7 * 86400000));
    const k = `${a.class_id}:${wk}`;
    const cur = sessionMap.get(k) ?? { count: 0, capacity: c.capacity, name: c.name };
    cur.count += 1;
    sessionMap.set(k, cur);
  });
  const fillAgg = new Map<string, { total: number; cap: number; sessions: number }>();
  sessionMap.forEach((v) => {
    const cur = fillAgg.get(v.name) ?? { total: 0, cap: v.capacity, sessions: 0 };
    cur.total += v.count;
    cur.sessions += 1;
    fillAgg.set(v.name, cur);
  });
  const classFillPct = [...fillAgg.entries()].map(([name, c]) => ({
    name,
    fillPct: c.sessions ? Math.round((c.total / c.sessions / c.cap) * 100) : 0,
    checkins: c.total,
  }));

  // cohorts
  const cohortMonths = months.slice(-6);
  const cohorts = cohortMonths.map((cm) => {
    const cohortMembers = members.filter((m) => monthKey(new Date(m.joined_at)) === cm);
    const size = cohortMembers.length;
    const retention = cohortMonths
      .map((tm) => {
        if (tm < cm || !size) return null;
        const [y, mm] = tm.split("-").map(Number);
        const start = new Date(Date.UTC(y, mm - 1, 1));
        const end = new Date(Date.UTC(y, mm, 1));
        const activeIds = new Set(
          attendances
            .filter((a) => {
              const t = new Date(a.checked_in_at);
              return t >= start && t < end;
            })
            .map((a) => a.member_id),
        );
        const retained = cohortMembers.filter((m) => activeIds.has(m.id)).length;
        return { month: tm, retainedPct: Math.round((retained / size) * 100) };
      })
      .filter(Boolean);
    return { cohort: cm, size, retention };
  });

  // ---- Deeper aggregations ----
  const byKey = <T>(arr: T[], k: (t: T) => string) => {
    const m = new Map<string, number>();
    arr.forEach((x) => m.set(k(x), (m.get(k(x)) ?? 0) + 1));
    return [...m.entries()].map(([key, count]) => ({ key, count }));
  };

  const planMix = byKey(members, (m) => m.plan ?? "unknown");
  const disciplineMix = byKey(members, (m) => m.discipline ?? "unknown");
  const beltDistribution = byKey(members, (m) => `${m.discipline ?? "?"}:${m.belt_color ?? "?"}`);
  const statusMix = byKey(members, (m) => m.status ?? "unknown");
  const leadSourceMix = byKey(members, (m) => m.lead_source ?? "unknown")
    .map((r) => ({
      ...r,
      pct: members.length ? Number(((r.count / members.length) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.count - a.count);
  const topReferrers = byKey(
    members.filter((m) => (m.referred_by ?? "").trim().length > 0),
    (m) => String(m.referred_by).trim(),
  )
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // revenue by plan (lifetime paid)
  const revenueByPlan = new Map<string, number>();
  invoices.forEach((i) => {
    if (i.status !== "paid") return;
    revenueByPlan.set(
      i.plan ?? "unknown",
      (revenueByPlan.get(i.plan ?? "unknown") ?? 0) + i.amount_cents,
    );
  });
  const planRevenue_usd = [...revenueByPlan.entries()].map(([plan, c]) => ({
    plan,
    revenue: c / 100,
  }));

  // attendance per member (last 30 / 90 days)
  const d30 = new Date(Date.now() - 30 * 86400000);
  const d90 = new Date(Date.now() - 90 * 86400000);
  const visit30 = new Map<string, number>();
  const visit90 = new Map<string, number>();
  attendances.forEach((a) => {
    const t = new Date(a.checked_in_at);
    if (t >= d30) visit30.set(a.member_id, (visit30.get(a.member_id) ?? 0) + 1);
    if (t >= d90) visit90.set(a.member_id, (visit90.get(a.member_id) ?? 0) + 1);
  });

  const memberRows = members.map((m) => ({
    id: m.id,
    name: m.name,
    status: m.status,
    plan: m.plan,
    discipline: m.discipline,
    belt: m.belt_color,
    joined: m.joined_at,
    lastSeen: m.last_seen_at,
    daysSinceLastSeen: m.last_seen_at ? daysBetween(new Date(m.last_seen_at), now) : null,
    visits30: visit30.get(m.id) ?? 0,
    visits90: visit90.get(m.id) ?? 0,
    lifetimePaid_usd: (paidByMember.get(m.id) ?? 0) / 100,
  }));

  // ---- Domain signals: retention risk, belt readiness, no-shows ----
  const bookings = (bk.data ?? []) as BookingRow[];
  const d60 = new Date(Date.now() - 60 * 86400000);
  const prev30 = new Map<string, number>();
  attendances.forEach((a) => {
    const t = new Date(a.checked_in_at);
    if (t >= d60 && t < d30) prev30.set(a.member_id, (prev30.get(a.member_id) ?? 0) + 1);
  });

  const noShow90 = new Map<string, number>();
  const booked90 = new Map<string, number>();
  const bookings30 = new Map<string, BookingOutcome[]>();
  bookings.forEach((b) => {
    const t = new Date(`${b.booked_for_date}T00:00:00Z`);
    if (t < d90) return;
    booked90.set(b.member_id, (booked90.get(b.member_id) ?? 0) + 1);
    if (b.status === "no_show") noShow90.set(b.member_id, (noShow90.get(b.member_id) ?? 0) + 1);
    if (t >= d30) {
      const arr = bookings30.get(b.member_id) ?? [];
      // The column also holds "cancelled"; BookingOutcome predates it. Same as retention.functions.ts.
      arr.push({
        booked_for_date: b.booked_for_date,
        status: b.status as BookingOutcome["status"],
      });
      bookings30.set(b.member_id, arr);
    }
  });

  // Latest promotion per member+discipline+colour gives time-at-current-belt.
  const beltSince = new Map<string, string>();
  [...promotions]
    .sort((a, b) => +new Date(a.promoted_at) - +new Date(b.promoted_at))
    .forEach((p) => {
      const m = members.find((x) => x.id === p.member_id);
      if (!m) return;
      if (p.to_color && m.belt_color && p.to_color === m.belt_color) {
        beltSince.set(p.member_id, p.promoted_at);
      }
    });

  const riskScores = members
    .filter((m) => m.status === "active" || m.status === "trial")
    .map((m) =>
      scoreRetentionRisk({
        id: m.id,
        name: m.name,
        belt_color: m.belt_color ?? "",
        stripes: m.stripes ?? 0,
        joined_at: beltSince.get(m.id) ?? m.joined_at,
        last_seen_at: m.last_seen_at,
        recentSessions: visit30.get(m.id) ?? 0,
        previousSessions: prev30.get(m.id) ?? 0,
        recentBookings: bookings30.get(m.id) ?? [],
      }),
    )
    .map((r) => {
      const ns = noShow90.get(r.memberId) ?? 0;
      return {
        ...r,
        noShowsLast90: ns,
        reasons: ns >= 2 ? [...r.reasons, `${ns} no-shows in the last 90 days`] : r.reasons,
      };
    })
    .sort((a, b) => b.score - a.score);

  const atRiskMembers = riskScores
    .filter((r) => r.level !== "healthy")
    .slice(0, 25)
    .map((r) => ({
      name: r.name,
      belt: r.beltColor,
      riskLevel: r.level,
      riskScore: r.score,
      daysSinceLastSeen: r.daysSinceLastSeen,
      sessionsLast30: r.sessionsLast30,
      sessionsPrev30: r.sessionsPrev30,
      noShowsLast90: r.noShowsLast90,
      noShowsLast30: r.noShowsLast30,
      bookingsLast30: r.bookingsLast30,
      noShowRiskPoints: r.noShowPoints,

      factors: r.reasons,
    }));

  const readiness = members
    .filter(
      (m) =>
        m.status === "active" &&
        m.belt_color &&
        m.belt_color !== "beginner" &&
        m.belt_color !== "black",
    )
    .map((m) =>
      assessReadiness({
        id: m.id,
        name: m.name,
        discipline: m.discipline ?? "",
        belt_color: m.belt_color,
        stripes: m.stripes ?? 0,
        joined_at: beltSince.get(m.id) ?? m.joined_at,
        sessionsLast90: visit90.get(m.id) ?? 0,
      }),
    );

  const readyToGrade = readiness
    .filter((r) => r.level !== "not-yet")
    .sort((a, b) =>
      a.level === b.level ? b.sessionsLast90 - a.sessionsLast90 : a.level === "ready" ? -1 : 1,
    )
    .slice(0, 25)
    .map((r) => ({
      name: r.name,
      belt: r.beltColor,
      stripes: r.stripes,
      discipline: r.discipline,
      readiness: r.level,
      monthsAtBelt: r.monthsAtBelt,
      minMonthsRequired: r.minMonthsRequired,
      sessionsLast90: r.sessionsLast90,
      notes: r.notes,
    }));

  const noShowLeaders = [...noShow90.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([id, n]) => ({
      name: members.find((m) => m.id === id)?.name ?? "Unknown",
      noShowsLast90: n,
      bookingsLast90: booked90.get(id) ?? 0,
    }));

  const topAttenders = [...memberRows].sort((a, b) => b.visits30 - a.visits30).slice(0, 10);

  const dormant = memberRows
    .filter((m) => m.status === "active" && (m.daysSinceLastSeen ?? 999) >= 21)
    .sort((a, b) => (b.daysSinceLastSeen ?? 0) - (a.daysSinceLastSeen ?? 0))
    .slice(0, 15);

  // churned last year — lapsed members whose last_seen is in the past 365 days
  const yearAgo = new Date(Date.now() - 365 * 86400000);
  const churnedLastYear = memberRows
    .filter((m) => m.status === "lapsed" && m.lastSeen && new Date(m.lastSeen) >= yearAgo)
    .map((m) => ({
      name: m.name,
      discipline: m.discipline,
      plan: m.plan,
      lastSeen: m.lastSeen,
      lifetimeMonthsActive:
        m.joined && m.lastSeen
          ? Math.max(1, Math.round(daysBetween(new Date(m.joined), new Date(m.lastSeen)) / 30))
          : null,
      lifetimePaid_usd: m.lifetimePaid_usd,
    }));
  const churnedAvgLifetimeMonths = churnedLastYear.length
    ? Number(
        (
          churnedLastYear.reduce((s, x) => s + (x.lifetimeMonthsActive ?? 0), 0) /
          churnedLastYear.length
        ).toFixed(1),
      )
    : 0;

  // weekday load
  const weekdayLoad = Array.from({ length: 7 }, (_, w) => ({
    weekday: w,
    checkins: attendances.filter((a) => new Date(a.checked_in_at).getUTCDay() === w).length,
  }));

  // overdue invoices
  const overdue = invoices.filter(
    (i) => i.status !== "paid" && i.due_date && new Date(i.due_date) < now,
  );
  const overdueAmount_usd = overdue.reduce((s, i) => s + (i.amount_cents ?? 0), 0) / 100;

  // recent promotions
  const recentPromotions = [...promotions]
    .sort((a, b) => +new Date(b.promoted_at) - +new Date(a.promoted_at))
    .slice(0, 10);

  // Retention outcome tracking: did our outreach actually save members?
  const { computeRetentionImpact } = await import("./retention-outcomes.server");
  const retentionImpact = await computeRetentionImpact(supabase, dojoId, 90).catch(() => null);

  // ---- Aggregate-only block ----
  // These are the ONLY derived figures that may be sent to an AI model (see
  // ai-aggregate.ts). Everything here is a count, average or percentage.
  const activeMembers = members.filter((m) => m.status === "active");
  const sumVisits = (map: Map<string, number>) =>
    activeMembers.reduce((s, m) => s + (map.get(m.id) ?? 0), 0);
  const avg = (n: number, d: number) => (d ? Number((n / d).toFixed(2)) : 0);

  const bandOf = (n: number) => (n === 0 ? "0" : n <= 3 ? "1-3" : n <= 7 ? "4-7" : "8+");
  const bandCounts = new Map<string, number>([
    ["0", 0],
    ["1-3", 0],
    ["4-7", 0],
    ["8+", 0],
  ]);
  activeMembers.forEach((m) => {
    const b = bandOf(visit30.get(m.id) ?? 0);
    bandCounts.set(b, (bandCounts.get(b) ?? 0) + 1);
  });

  const noShowTotal90d = [...noShow90.values()].reduce((a, b) => a + b, 0);
  const bookingTotal90d = [...booked90.values()].reduce((a, b) => a + b, 0);

  // Average months at current belt, grouped by belt colour.
  const beltMonths = new Map<string, { months: number; members: number }>();
  activeMembers.forEach((m) => {
    const since = beltSince.get(m.id) ?? m.joined_at;
    if (!since || !m.belt_color) return;
    const months = Math.max(0, daysBetween(new Date(since), now) / 30.44);
    const cur = beltMonths.get(m.belt_color) ?? { months: 0, members: 0 };
    cur.months += months;
    cur.members += 1;
    beltMonths.set(m.belt_color, cur);
  });

  const d90Date = d90;
  const joinedLast90 = members.filter((m) => m.joined_at && new Date(m.joined_at) >= d90Date);
  const convertedLast90 = joinedLast90.filter((m) => m.status === "active");

  const aggregate = {
    referredMemberCount: members.filter((m) => (m.referred_by ?? "").trim().length > 0).length,
    avgSessionsPerActiveMember30d: avg(sumVisits(visit30), activeMembers.length),
    avgSessionsPerActiveMember90d: avg(sumVisits(visit90), activeMembers.length),
    sessionBands30d: [...bandCounts.entries()].map(([band, count]) => ({ band, count })),
    dormantCount: dormant.length,
    noShowTotal90d,
    bookingTotal90d,
    noShowRatePct90d: bookingTotal90d
      ? Number(((noShowTotal90d / bookingTotal90d) * 100).toFixed(1))
      : 0,
    membersWithNoShows90d: [...noShow90.values()].filter((n) => n > 0).length,
    churnedAvgLifetimePaid: churnedLastYear.length
      ? Number(
          (
            churnedLastYear.reduce((s, x) => s + (x.lifetimePaid_usd ?? 0), 0) /
            churnedLastYear.length
          ).toFixed(2),
        )
      : 0,
    promotionsLast90d: promotions.filter((p) => new Date(p.promoted_at) >= d90Date).length,
    avgMonthsAtBelt: [...beltMonths.entries()].map(([belt, v]) => ({
      belt,
      members: v.members,
      avgMonths: Number((v.months / v.members).toFixed(1)),
    })),
    trialsStarted90d: joinedLast90.length,
    trialsConverted90d: convertedLast90.length,
    trialConversionPct: joinedLast90.length
      ? Number(((convertedLast90.length / joinedLast90.length) * 100).toFixed(1))
      : 0,
  };

  return {
    aggregate,

    generatedAt: new Date().toISOString(),
    defaultCurrency,
    mrr_cents: currentMRR,
    arr_cents: currentMRR * 12,
    mrrByCurrency: [...mrrByCurrency.entries()].map(([currency, cents]) => ({
      currency,
      mrr_cents: Math.round(cents),
      arr_cents: Math.round(cents * 12),
    })),
    revenueByCurrency: [...revenueByCurrency.entries()].map(([currency, cents]) => ({
      currency,
      lifetime_paid_cents: cents,
    })),
    mrr_usd: currentMRR / 100,
    arr_usd: (currentMRR / 100) * 12,
    mrrDeltaPct: Number(mrrDeltaPct.toFixed(1)),
    mrrSeries_usd: months.map((m) => ({ month: m, mrr: (revenueByMonth.get(m) ?? 0) / 100 })),
    members: { active, lapsed, trial, total: members.length },
    statusMix,
    planMix,
    disciplineMix,
    leadSourceMix,
    topReferrers,
    beltDistribution,
    planRevenue_usd,
    churnPct: Number(churnPct.toFixed(1)),
    avgLTV_usd: Number((ltv / 100).toFixed(2)),
    attendanceByMonth: attByMonth,
    weekdayLoad,
    classFillPct,
    retentionCohorts: cohorts,
    promotionsCount: promotions.length,
    recentPromotions,
    topAttenders30d: topAttenders,
    dormantActiveMembers: dormant,
    atRiskMembers,
    atRiskCounts: {
      high: riskScores.filter((r) => r.level === "high").length,
      watch: riskScores.filter((r) => r.level === "watch").length,
      healthy: riskScores.filter((r) => r.level === "healthy").length,
    },
    retentionImpact,
    readyToGrade,
    readyToGradeCounts: {
      ready: readiness.filter((r) => r.level === "ready").length,
      almost: readiness.filter((r) => r.level === "almost").length,
      notYet: readiness.filter((r) => r.level === "not-yet").length,
    },
    noShowLeaders90d: noShowLeaders,
    churnedLastYear: {
      count: churnedLastYear.length,
      avgLifetimeMonths: churnedAvgLifetimeMonths,
      sample: churnedLastYear.slice(0, 25),
    },
    overdueInvoices: { count: overdue.length, amount_usd: overdueAmount_usd },
    memberRowsSample: memberRows.slice(0, 100),
  };
}

export const getAnalyticsSnapshot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ dojoId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertDojoStaff(context.supabase, context.userId, data.dojoId, "getAnalyticsSnapshot");
    return buildSnapshot(context.supabase, data.dojoId);
  });

export const askSensei = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => InputSchema.parse(input))
  .handler(async ({ data, context }) => {
    await assertDojoStaff(context.supabase, context.userId, data.dojoId, "askSensei");
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { reply: null, error: "AI is not configured." };

    const rawSnapshot = data.snapshot
      ? data.snapshot
      : await buildSnapshot(context.supabase, data.dojoId);

    // GDPR: only AGGREGATED, ANONYMISED statistics may leave the system. The
    // whitelist in ai-aggregate.ts strips every per-member row, identifier and
    // free-text field, and suppresses any figure derived from fewer than
    // K_ANON members. Nothing sent below can be tied back to a person.
    const { toAggregateSnapshot, tokeniseNames } = await import("./ai-aggregate");
    const snapshot = toAggregateSnapshot(rawSnapshot);

    const { data: nameRows } = await context.supabase
      .from("members")
      .select("name")
      .eq("dojo_id", data.dojoId);
    const memberNames = ((nameRows ?? []) as { name: string | null }[])
      .map((r) => (r.name ?? "").trim())
      .filter(Boolean);

    // The user's own words may name a member. Names become positional
    // placeholders; contact details are removed.
    let namedMemberAsked = false;
    const messages = data.messages.map((m) => {
      const t = tokeniseNames(m.content, memberNames);
      if (t.placeholders.size > 0) namedMemberAsked = true;
      return { role: m.role, content: t.text };
    });

    const pageContext = data.pageContext
      ? {
          path: data.pageContext.path,
          title: data.pageContext.title
            ? tokeniseNames(data.pageContext.title, memberNames).text
            : undefined,
          heading: data.pageContext.heading
            ? tokeniseNames(data.pageContext.heading, memberNames).text
            : undefined,
        }
      : null;

    const system = `You are Sensei — a martial arts gym retention consultant sitting beside the gym owner, looking at their live numbers.

WHAT YOU KNOW ABOUT MARTIAL ARTS GYMS (reason WITH this, don't recite it):
- White-belt churn peaks in months 3–6: the novelty fades before the habit forms. New starters need contact early.
- The "blue belt blues": a sharp churn spike around 18 months at blue belt, once the next grade feels far away.
- Kids programmes are the retention backbone — they hold families, and family memberships carry far higher lifetime value than solo adults.
- Grading and belt progression cadence is the single biggest motivator. Members who can't see their next stripe drift away.
- Attendance decline nearly always precedes cancellation: fewer sessions this month than last is an early warning, not noise.
- Failed or overdue payments are one of the strongest churn signals there is — chase them fast and personally.
- Members who book classes and then no-show are a strong early churn indicator, often earlier than pure attendance drop-off.

HOW YOU ANSWER:
- Ground every claim in the aggregate numbers below. Cross-reference sections (membership, attendance, retention, grading, trials, revenue) when a question needs it.
- Every answer ends with specific, actionable next steps — expressed as groups and actions ("call the 12 high-risk members on the Retention Risk list", "grade the 7 members marked ready"), never as named individuals.
- If the snapshot genuinely lacks the data, say so plainly. Never invent figures.
- Plain gym-owner language, no SaaS jargon: say "monthly membership revenue" not MRR, "yearly membership revenue" not ARR, "members leaving" not churn where it reads better, "average lifetime value" not LTV.
- Format money with the snapshot's defaultCurrency symbol; rates with %.
- Keep it tight (≤220 words). Lead with the answer, then the evidence, then the action.
- If the user references "this page" or "what I'm looking at", use the PAGE CONTEXT below.

DATA PROTECTION — READ CAREFULLY:
- You receive ONLY aggregated, anonymised gym statistics. There is no individual member data of any kind: no names, no ids, no codes, no attendance histories.
- Some figures read "<5" or are null: that means the group was too small to share without identifying someone. Treat them as "fewer than 5" / "not available", never guess the real number.
- Never invent, guess or ask for a member's name. Placeholders like <PERSON_1> may appear in the user's own message — treat them as "that member" and do not attempt to identify them.
${namedMemberAsked ? "- The user asked about a specific member. Answer with the patterns and playbook that apply to that situation, then tell them the per-member detail lives on the member's own profile page and the Retention Risk list inside the app.\n" : ""}
${pageContext ? `PAGE CONTEXT (where the user is right now):\n${JSON.stringify(pageContext)}\n` : ""}
AGGREGATE GYM STATISTICS (JSON):
${JSON.stringify(snapshot)}`;

    return callSensei({
      client: new Anthropic({ apiKey }),
      model: envOr(process.env.ANTHROPIC_MODEL, "claude-opus-5-5"),
      system,
      messages,
    });
  });
