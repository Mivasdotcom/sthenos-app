import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertDojoStaff } from "./dojo-access";

// ───────────── Discipline belt orders ─────────────

type Discipline = "BJJ" | "Judo" | "Karate" | "Muay Thai";
type BeltColor =
  | "white" | "yellow" | "orange" | "green" | "blue" | "purple" | "brown" | "red" | "black";

const beltOrders: Record<Discipline, BeltColor[]> = {
  BJJ: ["white", "blue", "purple", "brown", "black"],
  Judo: ["white", "yellow", "orange", "green", "blue", "brown", "black"],
  Karate: ["white", "yellow", "orange", "green", "blue", "brown", "black"],
  "Muay Thai": ["white", "yellow", "green", "blue", "brown", "red", "black"],
};

// Typical minimum months at a belt before the next color is reasonable.
// BJJ uses stripes within a belt (0–4 stripes ≈ 1 stripe per ~6 months at lower belts).
const minMonthsAtBelt: Record<Discipline, Partial<Record<BeltColor, number>>> = {
  BJJ:        { white: 12, blue: 24, purple: 18, brown: 12 },
  Judo:       { white: 4, yellow: 6, orange: 6, green: 9, blue: 12, brown: 18 },
  Karate:     { white: 3, yellow: 4, orange: 4, green: 6, blue: 9, brown: 12 },
  "Muay Thai":{ white: 3, yellow: 4, green: 6, blue: 9, brown: 12, red: 18 },
};

// Target attendance for "regular training" used by readiness math.
const TARGET_VISITS_30D = 12;

function clamp(n: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

function monthsBetween(a: Date, b: Date) {
  return (b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
}

// ───────────── Retention Risk ─────────────

export const getRetentionRisk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId);
    const [memRes, attRes, invRes] = await Promise.all([
      supabase.from("members").select("id,name,status,plan,discipline,belt_color,belt_label,joined_at,last_seen_at").eq("dojo_id", data.dojoId),
      supabase.from("attendances").select("member_id,checked_in_at,class_id").eq("dojo_id", data.dojoId),
      supabase.from("invoices").select("member_id,status,due_date,paid_at,amount_cents").eq("dojo_id", data.dojoId),
    ]);
    const members = (memRes.data ?? []) as any[];
    const attendances = (attRes.data ?? []) as any[];
    const invoices = (invRes.data ?? []) as any[];

    const now = new Date();
    const day = 86400000;
    const cutoff30 = new Date(now.getTime() - 30 * day);
    const cutoff60 = new Date(now.getTime() - 60 * day);
    const cutoff90 = new Date(now.getTime() - 90 * day);

    const attByMember = new Map<string, Date[]>();
    attendances.forEach((a) => {
      const t = new Date(a.checked_in_at);
      const arr = attByMember.get(a.member_id) ?? [];
      arr.push(t);
      attByMember.set(a.member_id, arr);
    });

    const overdueByMember = new Map<string, number>();
    invoices.forEach((i) => {
      if (i.status === "overdue" || (i.status === "due" && new Date(i.due_date) < now)) {
        overdueByMember.set(i.member_id, (overdueByMember.get(i.member_id) ?? 0) + 1);
      }
    });

    const classesByMember = new Map<string, Set<string>>();
    attendances.forEach((a) => {
      if (!a.class_id) return;
      const t = new Date(a.checked_in_at);
      if (t < cutoff60) return;
      const s = classesByMember.get(a.member_id) ?? new Set();
      s.add(a.class_id);
      classesByMember.set(a.member_id, s);
    });

    const rows = members
      .filter((m) => m.status !== "lapsed") // only flag still-on-the-roster
      .map((m) => {
        const visits = (attByMember.get(m.id) ?? []).sort((a, b) => b.getTime() - a.getTime());
        const last = visits[0] ?? null;
        const daysSinceLast = last ? Math.floor((now.getTime() - last.getTime()) / day) : 999;
        const v30 = visits.filter((d) => d >= cutoff30).length;
        const v60_30 = visits.filter((d) => d >= cutoff60 && d < cutoff30).length;
        const v90_60 = visits.filter((d) => d >= cutoff90 && d < cutoff60).length;
        const overdueInvoices = overdueByMember.get(m.id) ?? 0;
        const classVariety = (classesByMember.get(m.id) ?? new Set()).size;
        const trendDrop = v60_30 > 0 ? Math.max(0, (v60_30 - v30) / v60_30) : v30 === 0 ? 1 : 0;

        // Risk score 0-100 (higher = more at risk)
        let score = 0;
        // Recency (max 35 pts)
        if (daysSinceLast > 21) score += 35;
        else if (daysSinceLast > 14) score += 25;
        else if (daysSinceLast > 7) score += 12;
        // Frequency in last 30d (max 25 pts)
        if (v30 === 0) score += 25;
        else if (v30 < 3) score += 18;
        else if (v30 < 6) score += 8;
        // Negative trend (max 20 pts)
        score += Math.round(trendDrop * 20);
        // Billing (max 15 pts)
        if (overdueInvoices >= 2) score += 15;
        else if (overdueInvoices === 1) score += 8;
        // Variety (max 5 pts): only training one class type is fragile
        if (classVariety <= 1) score += 5;

        score = clamp(score);
        const tier = score >= 65 ? "high" : score >= 35 ? "medium" : "low";

        // Plain, deterministic suggestion (no AI cost per row)
        const reasons: string[] = [];
        if (daysSinceLast > 14) reasons.push(`${daysSinceLast}d since last check-in`);
        if (v30 < 4) reasons.push(`only ${v30} visit${v30 === 1 ? "" : "s"} in 30d`);
        if (trendDrop > 0.4) reasons.push(`attendance dropped ${Math.round(trendDrop * 100)}% vs prior month`);
        if (overdueInvoices > 0) reasons.push(`${overdueInvoices} overdue invoice${overdueInvoices > 1 ? "s" : ""}`);
        if (classVariety <= 1 && v30 > 0) reasons.push("training only one class type");

        const recommendation =
          tier === "high"
            ? "Reach out personally this week — a call from head instructor beats a templated email."
            : tier === "medium"
              ? "Invite to a specific class they'd enjoy or check in by SMS."
              : "Stable — no action needed.";

        return {
          id: m.id,
          name: m.name,
          discipline: m.discipline,
          belt: { color: m.belt_color, label: m.belt_label },
          plan: m.plan,
          daysSinceLast,
          visits30d: v30,
          visits60_30d: v60_30,
          visits90_60d: v90_60,
          overdueInvoices,
          classVariety,
          score,
          tier,
          reasons,
          recommendation,
        };
      })
      .sort((a, b) => b.score - a.score);

    return {
      generatedAt: new Date().toISOString(),
      total: rows.length,
      counts: {
        high: rows.filter((r) => r.tier === "high").length,
        medium: rows.filter((r) => r.tier === "medium").length,
        low: rows.filter((r) => r.tier === "low").length,
      },
      members: rows,
    };
  });

// ───────────── Belt Readiness ─────────────

export const getBeltReadiness = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId);
    const [memRes, attRes, proRes] = await Promise.all([
      supabase.from("members").select("id,name,status,discipline,belt_color,belt_label,stripes,dan,joined_at").eq("dojo_id", data.dojoId),
      supabase.from("attendances").select("member_id,checked_in_at").eq("dojo_id", data.dojoId),
      supabase.from("promotions").select("member_id,promoted_at,to_color,to_label,to_stripes").eq("dojo_id", data.dojoId),
    ]);
    const members = (memRes.data ?? []) as any[];
    const attendances = (attRes.data ?? []) as any[];
    const promotions = (proRes.data ?? []) as any[];

    const now = new Date();
    const day = 86400000;
    const cutoff30 = new Date(now.getTime() - 30 * day);
    const cutoff90 = new Date(now.getTime() - 90 * day);

    const attByMember = new Map<string, Date[]>();
    attendances.forEach((a) => {
      const arr = attByMember.get(a.member_id) ?? [];
      arr.push(new Date(a.checked_in_at));
      attByMember.set(a.member_id, arr);
    });

    const lastPromoByMember = new Map<string, Date>();
    promotions.forEach((p) => {
      const t = new Date(p.promoted_at);
      const cur = lastPromoByMember.get(p.member_id);
      if (!cur || t > cur) lastPromoByMember.set(p.member_id, t);
    });

    const rows = members
      .filter((m) => m.status === "active" && m.belt_color !== "black")
      .map((m) => {
        const discipline = m.discipline as Discipline;
        const order = beltOrders[discipline] ?? beltOrders.BJJ;
        const idx = order.indexOf(m.belt_color as BeltColor);
        const isBJJ = discipline === "BJJ";
        const stripes = m.stripes ?? 0;
        const nextColor = order[Math.min(idx + 1, order.length - 1)];

        const visits = attByMember.get(m.id) ?? [];
        const v30 = visits.filter((d) => d >= cutoff30).length;
        const v90 = visits.filter((d) => d >= cutoff90).length;
        const consistency = clamp(Math.round((v30 / TARGET_VISITS_30D) * 100));

        const sinceRef = lastPromoByMember.get(m.id) ?? new Date(m.joined_at);
        const monthsAtBelt = Math.max(0, monthsBetween(sinceRef, now));
        const minMonths = minMonthsAtBelt[discipline]?.[m.belt_color as BeltColor] ?? 6;
        const timeScore = clamp(Math.round((monthsAtBelt / minMonths) * 100));

        // BJJ logic: stripes-up vs full belt-up
        let target: { label: string; color: BeltColor; stripes?: number };
        if (isBJJ && stripes < 4) {
          target = { label: `${cap(m.belt_color)} Belt · ${stripes + 1} stripes`, color: m.belt_color, stripes: stripes + 1 };
        } else {
          target = { label: `${cap(nextColor)} Belt`, color: nextColor };
        }

        // Readiness blend: 50% consistency, 35% time at belt, 15% breadth (v90 floor)
        const breadthScore = clamp(Math.round((v90 / (TARGET_VISITS_30D * 2)) * 100));
        const readiness = clamp(Math.round(consistency * 0.5 + timeScore * 0.35 + breadthScore * 0.15));

        const status =
          readiness >= 85 ? "ready"
          : readiness >= 65 ? "almost"
          : readiness >= 40 ? "developing"
          : "early";

        const reasons: string[] = [];
        reasons.push(`${v30} visits / 30d (target ${TARGET_VISITS_30D})`);
        reasons.push(`${monthsAtBelt.toFixed(1)} mo at belt (min ${minMonths})`);
        if (breadthScore < 50) reasons.push("low breadth over 90 days");

        const recommendation =
          status === "ready"
            ? `Numbers support a promotion to ${target.label}. Verify on the mat — your call.`
            : status === "almost"
              ? `Close to ${target.label}. Strong attendance + a few more months of consistency would solidify it.`
              : status === "developing"
                ? `Progressing toward ${target.label}. Focus on consistent weekly attendance.`
                : `Early on the path to ${target.label}. Build a regular training habit first.`;

        return {
          id: m.id,
          name: m.name,
          discipline,
          current: { color: m.belt_color, label: m.belt_label, stripes },
          target,
          monthsAtBelt: Number(monthsAtBelt.toFixed(1)),
          minMonthsAtBelt: minMonths,
          visits30d: v30,
          visits90d: v90,
          consistency,
          timeScore,
          breadthScore,
          readiness,
          status,
          reasons,
          recommendation,
        };
      })
      .sort((a, b) => b.readiness - a.readiness);

    return {
      generatedAt: new Date().toISOString(),
      total: rows.length,
      counts: {
        ready: rows.filter((r) => r.status === "ready").length,
        almost: rows.filter((r) => r.status === "almost").length,
        developing: rows.filter((r) => r.status === "developing").length,
        early: rows.filter((r) => r.status === "early").length,
      },
      members: rows,
    };
  });

function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// ───────────── Lead Conversion Scoring (trial members) ─────────────

export const getLeadConversion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId);
    const [memRes, attRes] = await Promise.all([
      supabase.from("members").select("id,name,email,phone,status,plan,discipline,belt_color,belt_label,joined_at,last_seen_at").eq("dojo_id", data.dojoId),
      supabase.from("attendances").select("member_id,checked_in_at,class_id").eq("dojo_id", data.dojoId),
    ]);
    const allMembers = (memRes.data ?? []) as any[];
    const attendances = (attRes.data ?? []) as any[];

    const now = new Date();
    const day = 86400000;

    // Conversion baseline: how active members started — visits in their first 14 days
    const activeMembers = allMembers.filter((m) => m.status === "active");
    const firstFortnightVisits: number[] = [];
    activeMembers.forEach((m) => {
      const joined = new Date(m.joined_at);
      const cutoff = new Date(joined.getTime() + 14 * day);
      const v = attendances.filter(
        (a) => a.member_id === m.id && new Date(a.checked_in_at) >= joined && new Date(a.checked_in_at) <= cutoff,
      ).length;
      firstFortnightVisits.push(v);
    });
    const avgConvertedVisits =
      firstFortnightVisits.length > 0
        ? firstFortnightVisits.reduce((a, b) => a + b, 0) / firstFortnightVisits.length
        : 4;

    const attByMember = new Map<string, Date[]>();
    attendances.forEach((a) => {
      const arr = attByMember.get(a.member_id) ?? [];
      arr.push(new Date(a.checked_in_at));
      attByMember.set(a.member_id, arr);
    });

    const trials = allMembers.filter((m) => m.status === "trial");

    const rows = trials
      .map((m) => {
        const visits = (attByMember.get(m.id) ?? []).sort((a, b) => a.getTime() - b.getTime());
        const joined = new Date(m.joined_at);
        const daysSinceJoin = Math.max(0, Math.floor((now.getTime() - joined.getTime()) / day));
        const visitsTotal = visits.length;
        const last = visits[visits.length - 1] ?? null;
        const daysSinceLast = last ? Math.floor((now.getTime() - last.getTime()) / day) : 999;
        const distinctClasses = new Set(
          attendances.filter((a) => a.member_id === m.id && a.class_id).map((a) => a.class_id),
        ).size;
        const hasContact = Boolean(m.email || m.phone);

        // Score 0-100 (higher = more likely to convert)
        let score = 0;

        // Activity vs converted baseline (max ~40 pts)
        const visitRatio = Math.min(1.5, visitsTotal / Math.max(1, avgConvertedVisits));
        score += Math.round(visitRatio * 27);

        // Recency — momentum matters (max 25 pts)
        if (daysSinceLast <= 3) score += 25;
        else if (daysSinceLast <= 7) score += 18;
        else if (daysSinceLast <= 14) score += 8;

        // Engagement breadth (max 15 pts)
        if (distinctClasses >= 3) score += 15;
        else if (distinctClasses === 2) score += 9;
        else if (distinctClasses === 1) score += 4;

        // Length of trial — fresh trials get a small bump, stale ones penalised
        if (daysSinceJoin <= 7 && visitsTotal >= 1) score += 12;
        else if (daysSinceJoin <= 14) score += 6;
        else if (daysSinceJoin > 21 && visitsTotal < 2) score -= 10;

        // Contact info (max 8 pts) — can't convert who you can't reach
        if (hasContact) score += 8;

        score = clamp(score);
        const tier: "hot" | "warm" | "cold" = score >= 65 ? "hot" : score >= 35 ? "warm" : "cold";

        const reasons: string[] = [];
        reasons.push(`${visitsTotal} visit${visitsTotal === 1 ? "" : "s"} in ${daysSinceJoin}d on trial`);
        if (last && daysSinceLast <= 7) reasons.push(`last seen ${daysSinceLast === 0 ? "today" : `${daysSinceLast}d ago`}`);
        else if (last) reasons.push(`${daysSinceLast}d since last visit`);
        else reasons.push("never checked in");
        if (distinctClasses >= 2) reasons.push(`tried ${distinctClasses} class types`);
        if (!hasContact) reasons.push("missing contact info");

        const recommendation =
          tier === "hot"
            ? "Call this week and offer the membership in person — they're showing every signal of a convert."
            : tier === "warm"
              ? "Send a personal SMS inviting them to a specific upcoming class, then follow up with the offer."
              : visitsTotal === 0
                ? "Re-engage with a friendly check-in — they haven't trained yet. Offer a 1-on-1 intro."
                : "Low signal — one more nudge, then move on if no response.";

        return {
          id: m.id,
          name: m.name,
          discipline: m.discipline,
          belt: { color: m.belt_color, label: m.belt_label },
          email: m.email,
          phone: m.phone,
          joinedAt: m.joined_at,
          daysSinceJoin,
          visitsTotal,
          daysSinceLast,
          distinctClasses,
          hasContact,
          score,
          tier,
          reasons,
          recommendation,
        };
      })
      .sort((a, b) => b.score - a.score);

    return {
      generatedAt: new Date().toISOString(),
      total: rows.length,
      avgConvertedVisits: Number(avgConvertedVisits.toFixed(1)),
      counts: {
        hot: rows.filter((r) => r.tier === "hot").length,
        warm: rows.filter((r) => r.tier === "warm").length,
        cold: rows.filter((r) => r.tier === "cold").length,
      },
      leads: rows,
    };
  });

// ───────────── Revenue & Churn Forecasting ─────────────

export const getRevenueForecast = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId);
    const [memRes, invRes, attRes, subRes] = await Promise.all([
      supabase.from("members").select("id,name,status,plan,discipline,belt_color,belt_label,joined_at,last_seen_at").eq("dojo_id", data.dojoId),
      supabase.from("invoices").select("member_id,status,due_date,paid_at,amount_cents,plan,created_at").eq("dojo_id", data.dojoId),
      supabase.from("attendances").select("member_id,checked_in_at").eq("dojo_id", data.dojoId),
      supabase
        .from("member_subscriptions")
        .select("member_id,status,plan_id,dojo_plans:plan_id(price_cents,interval)")
        .eq("dojo_id", data.dojoId)
        .in("status", ["active", "trialing"]),
    ]);
    const members = (memRes.data ?? []) as any[];
    const invoices = (invRes.data ?? []) as any[];
    const attendances = (attRes.data ?? []) as any[];
    const subs = (subRes.data ?? []) as any[];

    const now = new Date();
    const day = 86400000;
    const cutoff30 = new Date(now.getTime() - 30 * day);
    const cutoff90 = new Date(now.getTime() - 90 * day);

    // Real MRR per member from active/trialing subscriptions (normalized to monthly).
    // Same derivation as buildSnapshot / getRevenueSummary — source of truth.
    const normalizeMonthlyCents = (priceCents: number, interval: string | null | undefined) => {
      const iv = (interval ?? "month").toLowerCase();
      if (iv === "year" || iv === "yearly" || iv === "annual") return priceCents / 12;
      if (iv === "week" || iv === "weekly") return priceCents * 4.345;
      if (iv === "day" || iv === "daily") return priceCents * 30.44;
      return priceCents;
    };
    const monthlyByMember = new Map<string, number>();
    subs.forEach((s) => {
      const plan = s.dojo_plans;
      if (!plan) return;
      const cents = normalizeMonthlyCents(plan.price_cents ?? 0, plan.interval);
      monthlyByMember.set(s.member_id, (monthlyByMember.get(s.member_id) ?? 0) + cents);
    });
    // Fallback for members without a subscription row: 0 (no real payment data).
    const memberMonthlyCents = (memberId: string): number =>
      Math.round(monthlyByMember.get(memberId) ?? 0);

    // Per-member churn risk (lightweight, shared scoring)
    const attByMember = new Map<string, Date[]>();
    attendances.forEach((a) => {
      const arr = attByMember.get(a.member_id) ?? [];
      arr.push(new Date(a.checked_in_at));
      attByMember.set(a.member_id, arr);
    });
    const overdueByMember = new Map<string, number>();
    invoices.forEach((i) => {
      if (i.status === "overdue" || (i.status === "due" && new Date(i.due_date) < now)) {
        overdueByMember.set(i.member_id, (overdueByMember.get(i.member_id) ?? 0) + 1);
      }
    });
    const active = members.filter((m) => m.status === "active");
    const riskFor = (m: any) => {
      const visits = (attByMember.get(m.id) ?? []).sort((a, b) => b.getTime() - a.getTime());
      const last = visits[0] ?? null;
      const daysSinceLast = last ? Math.floor((now.getTime() - last.getTime()) / day) : 999;
      const v30 = visits.filter((d) => d >= cutoff30).length;
      const overdue = overdueByMember.get(m.id) ?? 0;
      let s = 0;
      if (daysSinceLast > 21) s += 35; else if (daysSinceLast > 14) s += 25; else if (daysSinceLast > 7) s += 12;
      if (v30 === 0) s += 25; else if (v30 < 3) s += 18; else if (v30 < 6) s += 8;
      if (overdue >= 2) s += 15; else if (overdue === 1) s += 8;
      return { score: clamp(s), daysSinceLast, v30, overdue };
    };

    type AtRisk = {
      id: string; name: string; plan: string; discipline: string;
      belt: { color: string; label: string };
      churnProbability: number; monthlyValueCents: number; expectedLossCents: number;
      daysSinceLast: number; visits30d: number; overdueInvoices: number;
    };

    const atRisk: AtRisk[] = [];
    let totalActiveMonthlyCents = 0;
    let expectedChurnLossCents = 0;

    active.forEach((m) => {
      const monthly = memberMonthlyCents(m.id);
      totalActiveMonthlyCents += monthly;
      const r = riskFor(m);
      // Convert risk score to a 30-day churn probability (conservative)
      const prob = Math.min(0.8, Math.max(0, (r.score - 15) / 100));
      const expectedLoss = Math.round(monthly * prob);
      expectedChurnLossCents += expectedLoss;
      if (prob >= 0.2) {
        atRisk.push({
          id: m.id,
          name: m.name,
          plan: m.plan,
          discipline: m.discipline,
          belt: { color: m.belt_color, label: m.belt_label },
          churnProbability: Math.round(prob * 100),
          monthlyValueCents: monthly,
          expectedLossCents: expectedLoss,
          daysSinceLast: r.daysSinceLast,
          visits30d: r.v30,
          overdueInvoices: r.overdue,
        });
      }
    });
    atRisk.sort((a, b) => b.expectedLossCents - a.expectedLossCents);

    // Trial → active conversion rate (last 120 days of joiners)
    const cutoff120 = new Date(now.getTime() - 120 * day);
    const recentJoiners = members.filter((m) => new Date(m.joined_at) >= cutoff120 && m.status !== "lapsed");
    const recentActiveJoiners = recentJoiners.filter((m) => m.status === "active").length;
    const conversionRate =
      recentJoiners.length > 0 ? recentActiveJoiners / recentJoiners.length : 0.35;
    const trialMembers = members.filter((m) => m.status === "trial");
    // Average monthly value of active subs → expected value of a converted trial
    const activeMonthlyValues = active.map((m) => memberMonthlyCents(m.id)).filter((v) => v > 0);
    const avgActiveMonthlyCents = activeMonthlyValues.length
      ? Math.round(activeMonthlyValues.reduce((a, b) => a + b, 0) / activeMonthlyValues.length)
      : 0;
    const expectedNewFromTrialsCents = Math.round(
      trialMembers.length * conversionRate * avgActiveMonthlyCents,
    );

    // 90-day forecast: baseline = current MRR; subtract expected churn, add conversions
    const months: { label: string; baselineCents: number; forecastCents: number }[] = [];
    let runningActive = totalActiveMonthlyCents;
    for (let i = 1; i <= 3; i++) {
      const monthDate = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const label = monthDate.toLocaleString("en-US", { month: "short", year: "numeric" });
      runningActive = Math.max(0, runningActive - expectedChurnLossCents);
      const conversionsThisMonth = i === 1 ? expectedNewFromTrialsCents : Math.round(expectedNewFromTrialsCents * 0.3);
      const forecast = runningActive + conversionsThisMonth;
      months.push({ label, baselineCents: totalActiveMonthlyCents, forecastCents: forecast });
    }

    // Retention scenarios: what if we save X% of expected churn loss?
    const scenarios = [10, 25, 50].map((pct) => ({
      retentionPct: pct,
      monthlySavedCents: Math.round((expectedChurnLossCents * pct) / 100),
      quarterlySavedCents: Math.round((expectedChurnLossCents * pct * 3) / 100),
    }));

    return {
      generatedAt: new Date().toISOString(),
      currentMRRCents: totalActiveMonthlyCents,
      activeMembers: active.length,
      atRiskCount: atRisk.length,
      atRiskMRRCents: atRisk.reduce((a, b) => a + b.monthlyValueCents, 0),
      expectedChurnLossCents,
      conversionRate: Number(conversionRate.toFixed(2)),
      trialMembers: trialMembers.length,
      expectedNewFromTrialsCents,
      months,
      scenarios,
      atRisk,
    };
  });
