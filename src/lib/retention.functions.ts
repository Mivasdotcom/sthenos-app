import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertDojoStaff } from "./dojo-access";
import { scoreRetentionRisk, type BookingOutcome } from "./retention";

const DAY = 86400000;

export type RetentionRecomputeResult = {
  dojoId: string;
  scored: number;
  high: number;
  watch: number;
  healthy: number;
};

/**
 * Recompute persisted retention risk for a dojo using the SINGLE source of
 * truth — scoreRetentionRisk() from src/lib/retention.ts. Never duplicate the
 * scoring logic elsewhere (SQL included).
 *
 * `client` may be an RLS-scoped client (staff-triggered) or the service-role
 * admin client (nightly cron). Always scoped by dojo_id.
 */
export async function recomputeRetentionForDojo(
  client: any,
  dojoId: string,
  memberIds?: string[],
): Promise<RetentionRecomputeResult> {
  const now = Date.now();
  const since60 = new Date(now - 60 * DAY).toISOString();
  const since30 = new Date(now - 30 * DAY).toISOString();
  const bookingsSince = new Date(now - 30 * DAY).toISOString().slice(0, 10);

  let memberQuery = client
    .from("members")
    .select("id,name,belt_color,stripes,joined_at,last_seen_at,status,retention_risk_level")
    .eq("dojo_id", dojoId)
    .in("status", ["active", "trial"]);
  if (memberIds?.length) memberQuery = memberQuery.in("id", memberIds);

  const [memRes, attRes, bkRes] = await Promise.all([
    memberQuery,
    client
      .from("attendances")
      .select("member_id,checked_in_at")
      .eq("dojo_id", dojoId)
      .gte("checked_in_at", since60),
    client
      .from("class_bookings")
      .select("member_id,booked_for_date,status")
      .eq("dojo_id", dojoId)
      .gte("booked_for_date", bookingsSince),
  ]);
  if (memRes.error) throw memRes.error;
  if (attRes.error) throw attRes.error;
  if (bkRes.error) throw bkRes.error;

  const members = (memRes.data ?? []) as any[];
  const recent = new Map<string, number>();
  const previous = new Map<string, number>();
  for (const a of attRes.data ?? []) {
    const map = a.checked_in_at >= since30 ? recent : previous;
    map.set(a.member_id, (map.get(a.member_id) ?? 0) + 1);
  }
  const bookingsByMember = new Map<string, BookingOutcome[]>();
  for (const b of bkRes.data ?? []) {
    const arr = bookingsByMember.get(b.member_id) ?? [];
    arr.push({ booked_for_date: b.booked_for_date, status: b.status });
    bookingsByMember.set(b.member_id, arr);
  }

  const scoredAt = new Date().toISOString();
  const tally = { high: 0, watch: 0, healthy: 0 } as Record<string, number>;

  for (const m of members) {
    const score = scoreRetentionRisk({
      id: m.id,
      name: m.name,
      belt_color: m.belt_color,
      stripes: m.stripes ?? 0,
      joined_at: m.joined_at,
      last_seen_at: m.last_seen_at,
      recentSessions: recent.get(m.id) ?? 0,
      previousSessions: previous.get(m.id) ?? 0,
      recentBookings: bookingsByMember.get(m.id) ?? [],
    });
    tally[score.level] = (tally[score.level] ?? 0) + 1;

    // Outcome tracking: a member moving INTO watch/high opens a pending
    // intervention row (never duplicated while one is still open).
    const wasAtRisk = m.retention_risk_level === "watch" || m.retention_risk_level === "high";
    const isAtRisk = score.level === "watch" || score.level === "high";
    if (isAtRisk && !wasAtRisk) {
      const { data: openRows } = await client
        .from("retention_interventions")
        .select("id")
        .eq("dojo_id", dojoId)
        .eq("member_id", m.id)
        .eq("outcome", "pending")
        .limit(1);
      if (!openRows?.length) {
        await client.from("retention_interventions").insert({
          dojo_id: dojoId,
          member_id: m.id,
          flagged_at: scoredAt,
          risk_level_at_flag: score.level,
          risk_score_at_flag: score.score,
          risk_factors_at_flag: score.reasons,
          outcome: "pending",
        });
      }
    }

    const { error } = await client
      .from("members")
      .update({
        retention_risk_level: score.level,
        retention_risk_score: score.score,
        retention_risk_factors: score.reasons,
        retention_scored_at: scoredAt,
      })
      .eq("id", m.id)
      .eq("dojo_id", dojoId);
    if (error) throw error;
  }

  return {
    dojoId,
    scored: members.length,
    high: tally.high ?? 0,
    watch: tally.watch ?? 0,
    healthy: tally.healthy ?? 0,
  };
}

/** Staff-triggered recompute for the whole dojo. */
export const recomputeRetentionScores = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "recomputeRetentionScores");
    return await recomputeRetentionForDojo(supabase, data.dojoId);
  });

/**
 * Recompute a single member's score — called after a check-in or after
 * bookings are marked no_show, so the persisted score stays fresh between
 * nightly runs.
 */
export const recomputeMemberRetention = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberIds: string[] }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "recomputeMemberRetention");
    if (!data.memberIds?.length) return { scored: 0 };
    const res = await recomputeRetentionForDojo(supabase, data.dojoId, data.memberIds);
    return { scored: res.scored };
  });

/** Retention impact aggregates for the Analytics + Dashboard panels. */
export const getRetentionImpact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; days?: number }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "getRetentionImpact");
    const { computeRetentionImpact } = await import("./retention-outcomes.server");
    return await computeRetentionImpact(supabase, data.dojoId, data.days ?? 90);
  });

/** Interventions recorded for one member (member profile timeline). */
export const listMemberInterventions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "listMemberInterventions");
    const { data: rows, error } = await supabase
      .from("retention_interventions")
      .select(
        "id,flagged_at,risk_level_at_flag,risk_score_at_flag,risk_factors_at_flag,intervention_type,intervention_at,intervention_by,outcome,outcome_at,notes",
      )
      .eq("dojo_id", data.dojoId)
      .eq("member_id", data.memberId)
      .order("flagged_at", { ascending: false })
      .limit(20);
    if (error) throw error;
    const userIds = Array.from(
      new Set((rows ?? []).map((row: any) => row.intervention_by).filter(Boolean)),
    ) as string[];
    const names = new Map<string, string>();
    if (userIds.length) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("user_id,display_name")
        .in("user_id", userIds);
      for (const profile of profiles ?? []) {
        if (profile.display_name) names.set(profile.user_id, profile.display_name);
      }
    }
    return (rows ?? []).map((row: any) => ({
      ...row,
      intervention_by_name: row.intervention_by ? names.get(row.intervention_by) ?? "Staff" : null,
    }));
  });

/** Staff logs a call / in-person conversation with an at-risk member. */
export const logManualOutreach = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberId: string; notes?: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "logManualOutreach");
    const nowIso = new Date().toISOString();
    const notes = data.notes?.trim() ? data.notes.trim().slice(0, 2000) : null;

    const { data: open } = await supabase
      .from("retention_interventions")
      .select("id,notes")
      .eq("dojo_id", data.dojoId)
      .eq("member_id", data.memberId)
      .eq("outcome", "pending")
      .order("flagged_at", { ascending: false })
      .limit(1);

    if (open?.length) {
      const { error } = await supabase
        .from("retention_interventions")
        .update({
          intervention_type: "manual",
          intervention_at: nowIso,
          intervention_by: userId,
          notes: notes ?? open[0].notes,
        })
        .eq("id", open[0].id)
        .eq("dojo_id", data.dojoId);
      if (error) throw error;
      return { id: open[0].id as string, created: false };
    }

    const { data: m, error: mErr } = await supabase
      .from("members")
      .select("retention_risk_level,retention_risk_score,retention_risk_factors")
      .eq("id", data.memberId)
      .eq("dojo_id", data.dojoId)
      .single();
    if (mErr) throw mErr;

    const { data: created, error } = await supabase
      .from("retention_interventions")
      .insert({
        dojo_id: data.dojoId,
        member_id: data.memberId,
        flagged_at: nowIso,
        risk_level_at_flag: m?.retention_risk_level ?? "healthy",
        risk_score_at_flag: m?.retention_risk_score ?? 0,
        risk_factors_at_flag: m?.retention_risk_factors ?? [],
        intervention_type: "manual",
        intervention_at: nowIso,
        intervention_by: userId,
        outcome: "pending",
        notes,
      })
      .select("id")
      .single();
    if (error) throw error;
    return { id: created.id as string, created: true };
  });
