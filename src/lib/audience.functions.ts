import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { contactEmailFor } from "@/lib/minors";
import type {
  AudienceFilter,
  RiskTier,
  ReadinessStatus,
  RetentionRiskLevel,
} from "./audience";

async function assertStaff(supabase: any, dojoId: string, userId: string) {
  const { data } = await supabase
    .from("dojo_memberships")
    .select("role")
    .eq("dojo_id", dojoId)
    .eq("user_id", userId)
    .single();
  if (!data || !["owner", "admin", "coach"].includes(data.role)) {
    throw new Error("Unauthorized");
  }
}

// ───────────── Shared evaluator ─────────────
// Loads members + dependent data, computes derived AI fields when the filter
// asks for them, and returns the matching member rows.

export type EvaluatedMember = {
  id: string;
  name: string;
  email: string | null;
  discipline: string;
  belt_color: string;
  belt_label: string;
  plan: string;
  status: string;
  payment_status: string | null;
  last_seen_at: string | null;
  joined_at: string;
  marketing_opt_out: boolean;
  visits30d: number;
  daysSinceLast: number;
  daysSinceLastSeen: number;
  overdueInvoices: number;
  riskTier: RiskTier;
  riskScore: number;
  readinessStatus: ReadinessStatus;
  readinessScore: number;
  /** Persisted retention snapshot (written by recomputeRetentionScores). */
  retentionRiskLevel: RetentionRiskLevel | null;
  retentionRiskScore: number | null;
  retentionRiskFactors: string[];
  noShowsLast30d: number;
};

const DAY = 86400000;
const TARGET_VISITS_30D = 12;

function clamp(n: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

export async function evaluateAudienceInternal(
  supabase: any,
  filter: AudienceFilter,
  dojoId?: string,
): Promise<EvaluatedMember[]> {
  const scope = (q: any) => (dojoId ? q.eq("dojo_id", dojoId) : q);
  const bookingsSince = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);

  const [memRes, attRes, invRes, proRes, bkRes] = await Promise.all([
    scope(
      supabase
        .from("members")
        .select(
          "id,name,email,date_of_birth,guardian_email,status,payment_status,plan,discipline,belt_color,belt_label,stripes,joined_at,last_seen_at,marketing_opt_out,retention_risk_level,retention_risk_score,retention_risk_factors,retention_scored_at",
        ),
    ),
    scope(supabase.from("attendances").select("member_id,checked_in_at,class_id")),
    scope(supabase.from("invoices").select("member_id,status,due_date")),
    scope(supabase.from("promotions").select("member_id,promoted_at")),
    scope(
      supabase
        .from("class_bookings")
        .select("member_id,booked_for_date,status")
        .gte("booked_for_date", bookingsSince),
    ),
  ]);

  const members = (memRes.data ?? []) as any[];
  const attendances = (attRes.data ?? []) as any[];
  const invoices = (invRes.data ?? []) as any[];
  const promotions = (proRes.data ?? []) as any[];
  const bookings = (bkRes.data ?? []) as any[];

  const now = new Date();
  const cutoff30 = new Date(now.getTime() - 30 * DAY);
  const cutoff60 = new Date(now.getTime() - 60 * DAY);
  const cutoff90 = new Date(now.getTime() - 90 * DAY);

  const attByMember = new Map<string, Date[]>();
  for (const a of attendances) {
    const arr = attByMember.get(a.member_id) ?? [];
    arr.push(new Date(a.checked_in_at));
    attByMember.set(a.member_id, arr);
  }
  const noShowsByMember = new Map<string, number>();
  for (const b of bookings) {
    if (b.status === "no_show") {
      noShowsByMember.set(b.member_id, (noShowsByMember.get(b.member_id) ?? 0) + 1);
    }
  }
  const overdueByMember = new Map<string, number>();
  for (const i of invoices) {
    if (i.status === "overdue" || (i.status === "due" && new Date(i.due_date) < now)) {
      overdueByMember.set(i.member_id, (overdueByMember.get(i.member_id) ?? 0) + 1);
    }
  }
  const lastPromoByMember = new Map<string, Date>();
  for (const p of promotions) {
    const t = new Date(p.promoted_at);
    const cur = lastPromoByMember.get(p.member_id);
    if (!cur || t > cur) lastPromoByMember.set(p.member_id, t);
  }

  const evaluated: EvaluatedMember[] = members.map((m) => {
    const visits = (attByMember.get(m.id) ?? []).sort((a, b) => b.getTime() - a.getTime());
    const last = visits[0] ?? null;
    const daysSinceLast = last ? Math.floor((now.getTime() - last.getTime()) / DAY) : 999;
    const daysSinceLastSeen = m.last_seen_at
      ? Math.floor((now.getTime() - new Date(m.last_seen_at).getTime()) / DAY)
      : daysSinceLast;
    const v30 = visits.filter((d) => d >= cutoff30).length;
    const v60_30 = visits.filter((d) => d >= cutoff60 && d < cutoff30).length;
    const v90 = visits.filter((d) => d >= cutoff90).length;
    const overdueInvoices = overdueByMember.get(m.id) ?? 0;
    const trendDrop = v60_30 > 0 ? Math.max(0, (v60_30 - v30) / v60_30) : v30 === 0 ? 1 : 0;

    // Risk
    let risk = 0;
    if (daysSinceLast > 21) risk += 35;
    else if (daysSinceLast > 14) risk += 25;
    else if (daysSinceLast > 7) risk += 12;
    if (v30 === 0) risk += 25;
    else if (v30 < 3) risk += 18;
    else if (v30 < 6) risk += 8;
    risk += Math.round(trendDrop * 20);
    if (overdueInvoices >= 2) risk += 15;
    else if (overdueInvoices === 1) risk += 8;
    risk = clamp(risk);
    const riskTier: RiskTier = risk >= 65 ? "high" : risk >= 35 ? "medium" : "low";

    // Readiness (only meaningful for active non-black)
    const consistency = clamp(Math.round((v30 / TARGET_VISITS_30D) * 100));
    const sinceRef = lastPromoByMember.get(m.id) ?? new Date(m.joined_at);
    const monthsAtBelt = Math.max(0, (now.getTime() - sinceRef.getTime()) / (DAY * 30.44));
    const timeScore = clamp(Math.round((monthsAtBelt / 12) * 100));
    const breadthScore = clamp(Math.round((v90 / (TARGET_VISITS_30D * 2)) * 100));
    const readinessScore = clamp(
      Math.round(consistency * 0.5 + timeScore * 0.35 + breadthScore * 0.15),
    );
    const readinessStatus: ReadinessStatus =
      readinessScore >= 85 ? "ready"
      : readinessScore >= 65 ? "almost"
      : readinessScore >= 40 ? "developing"
      : "early";

    return {
      id: m.id,
      name: m.name,
      // Minors are contacted through their parent or guardian.
      email: contactEmailFor(m),
      discipline: m.discipline,
      belt_color: m.belt_color,
      belt_label: m.belt_label,
      plan: m.plan,
      status: m.status,
      payment_status: m.payment_status ?? null,
      last_seen_at: m.last_seen_at,
      joined_at: m.joined_at,
      marketing_opt_out: !!m.marketing_opt_out,
      visits30d: v30,
      daysSinceLast,
      daysSinceLastSeen,
      overdueInvoices,
      riskTier,
      riskScore: risk,
      readinessStatus,
      readinessScore,
      retentionRiskLevel: (m.retention_risk_level ?? null) as RetentionRiskLevel | null,
      retentionRiskScore: m.retention_risk_score ?? null,
      retentionRiskFactors: Array.isArray(m.retention_risk_factors)
        ? (m.retention_risk_factors as string[])
        : [],
      noShowsLast30d: noShowsByMember.get(m.id) ?? 0,
    };
  });

  return evaluated.filter((m) => matchesFilter(m, filter, now));
}

const PLATEAU_RE = /belt for \d+\+ months|plateau/i;

export function matchesFilter(m: EvaluatedMember, f: AudienceFilter, now: Date): boolean {
  if (f.status?.length && !f.status.includes(m.status as any)) return false;
  if (f.plan?.length && !f.plan.includes(m.plan)) return false;
  if (f.discipline?.length && !f.discipline.includes(m.discipline)) return false;
  if (f.belt_color?.length && !f.belt_color.includes(m.belt_color)) return false;
  if (f.risk_tier?.length && !f.risk_tier.includes(m.riskTier)) return false;
  if (f.readiness_status?.length && !f.readiness_status.includes(m.readinessStatus)) return false;
  if (f.joined_within_days) {
    const joined = new Date(m.joined_at).getTime();
    if (now.getTime() - joined > f.joined_within_days * DAY) return false;
  }
  if (f.last_seen_min_days) {
    if (m.daysSinceLast < f.last_seen_min_days) return false;
  }
  if (f.min_visits_30d != null && m.visits30d < f.min_visits_30d) return false;
  if (f.has_overdue_invoice && m.overdueInvoices === 0) return false;
  if (f.exclude_marketing_opt_out && m.marketing_opt_out) return false;

  // ── Retention criteria ──
  if (f.retention_risk_level?.length) {
    if (!m.retentionRiskLevel || !f.retention_risk_level.includes(m.retentionRiskLevel)) return false;
  }
  if (f.retention_risk_score_gt != null) {
    if ((m.retentionRiskScore ?? -1) <= f.retention_risk_score_gt) return false;
  }
  if (f.days_since_last_seen_gt != null && m.daysSinceLastSeen <= f.days_since_last_seen_gt) {
    return false;
  }
  if (f.no_shows_last_30d_gte != null && m.noShowsLast30d < f.no_shows_last_30d_gte) return false;
  if (f.has_belt_plateau_factor && !m.retentionRiskFactors.some((r) => PLATEAU_RE.test(r))) {
    return false;
  }
  if (f.payment_status?.length && !f.payment_status.includes(m.payment_status ?? "")) return false;
  return true;
}


// ───────────── Server fns ─────────────

export const previewAudience = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { filter: AudienceFilter }) => d)
  .handler(async ({ data, context }) => {
    const { supabase } = context as any;
    const rows = await evaluateAudienceInternal(supabase, data.filter);
    return {
      total: rows.length,
      withEmail: rows.filter((r) => !!r.email).length,
      members: rows.slice(0, 50).map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        discipline: r.discipline,
        belt: r.belt_label,
        riskTier: r.riskTier,
        readinessStatus: r.readinessStatus,
        visits30d: r.visits30d,
        daysSinceLast: r.daysSinceLast,
      })),
    };
  });

export const listSegments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context as any;
    const { data, error } = await supabase
      .from("segments")
      .select("id,name,description,filter,created_at,updated_at")
      .order("name");
    if (error) throw error;
    return { segments: data ?? [] };
  });

export const saveSegment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id?: string; dojoId: string; name: string; description?: string; filter: AudienceFilter }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertStaff(supabase, data.dojoId, userId);
    if (data.id) {
      const { data: existing } = await supabase.from("segments").select("dojo_id").eq("id", data.id).single();
      if (!existing || existing.dojo_id !== data.dojoId) throw new Error("Unauthorized");
      const { error } = await supabase
        .from("segments")
        .update({ name: data.name, description: data.description ?? null, filter: data.filter })
        .eq("id", data.id);
      if (error) throw error;
      return { id: data.id };
    }
    const { data: row, error } = await supabase
      .from("segments")
      .insert({
        dojo_id: data.dojoId,
        name: data.name,
        description: data.description ?? null,
        filter: data.filter,
        created_by: userId,
      })
      .select("id")
      .single();
    if (error) throw error;
    return { id: row.id };
  });

export const deleteSegment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    const { data: row } = await supabase.from("segments").select("dojo_id").eq("id", data.id).single();
    if (!row) throw new Error("Not found");
    await assertStaff(supabase, row.dojo_id, userId);
    const { error } = await supabase.from("segments").delete().eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });
