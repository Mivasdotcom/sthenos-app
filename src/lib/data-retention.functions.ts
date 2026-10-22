import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertDojoStaff } from "./dojo-access";
import {
  RETENTION_LIMITS,
  retentionPolicyFromDojo,
  type RetentionPolicy,
} from "@/lib/retention-policy";
import type { RetentionSchedule } from "@/lib/data-retention.server";

/** Owner/admin only: retention is a policy decision, not day-to-day staff work. */
async function assertOwnerOrAdmin(supabase: any, userId: string, dojoId: string, fn: string) {
  await assertDojoStaff(supabase, userId, dojoId, fn);
  const { data, error } = await supabase
    .from("dojo_memberships")
    .select("role")
    .eq("user_id", userId)
    .eq("dojo_id", dojoId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || !["owner", "admin"].includes(String(data.role))) {
    throw new Error("Only gym owners or admins can change data retention settings");
  }
}

export const getRetentionPolicy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }): Promise<RetentionPolicy> => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "getRetentionPolicy");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { RETENTION_POLICY_COLS } = await import("@/lib/data-retention.server");
    const { data: dojo, error } = await supabaseAdmin
      .from("dojos")
      .select(RETENTION_POLICY_COLS)
      .eq("id", data.dojoId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return retentionPolicyFromDojo(dojo);
  });

export const updateRetentionPolicy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      dojoId: string;
      autoEnabled: boolean;
      departedMonths: number | null;
      waiverMonths: number | null;
      noticeDays: number;
    }) => {
      const clamp = (
        value: number | null,
        min: number,
        max: number,
        label: string,
      ): number | null => {
        if (value == null) return null;
        const n = Math.round(Number(value));
        if (!Number.isFinite(n) || n < min || n > max) {
          throw new Error(`${label} must be between ${min} and ${max} months`);
        }
        return n;
      };
      const notice = Math.round(Number(d.noticeDays));
      if (
        !Number.isFinite(notice) ||
        notice < RETENTION_LIMITS.noticeDaysMin ||
        notice > RETENTION_LIMITS.noticeDaysMax
      ) {
        throw new Error("Notice period must be between 0 and 90 days");
      }
      const departed = clamp(
        d.departedMonths,
        RETENTION_LIMITS.departedMonthsMin,
        RETENTION_LIMITS.departedMonthsMax,
        "Member retention",
      );
      const waiver = clamp(
        d.waiverMonths,
        RETENTION_LIMITS.waiverMonthsMin,
        RETENTION_LIMITS.waiverMonthsMax,
        "Waiver retention",
      );
      if (departed != null && waiver != null && waiver < departed) {
        throw new Error(
          "Waivers should be kept at least as long as member records — they are the gym's defence against a later injury claim",
        );
      }
      return { ...d, departedMonths: departed, waiverMonths: waiver, noticeDays: notice };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertOwnerOrAdmin(supabase, userId, data.dojoId, "updateRetentionPolicy");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("dojos")
      .update({
        retention_auto_enabled: data.autoEnabled,
        retention_departed_months: data.departedMonths,
        retention_waiver_months: data.waiverMonths,
        retention_notice_days: data.noticeDays,
      })
      .eq("id", data.dojoId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

/** What is due, what is held back and why — visible before anything is deleted. */
export const getRetentionSchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }): Promise<RetentionSchedule> => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "getRetentionSchedule");
    const { buildRetentionSchedule } = await import("@/lib/data-retention.server");
    return buildRetentionSchedule(data.dojoId);
  });

export type RetentionRunSummary = {
  id: string;
  status: string;
  triggerSource: string;
  startedAt: string;
  finishedAt: string | null;
  membersAnonymised: number;
  membersSkipped: number;
  waiversAnonymised: number;
  failures: number;
  error: string | null;
};

export const getRetentionHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }): Promise<RetentionRunSummary[]> => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "getRetentionHistory");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: runs, error } = await supabaseAdmin
      .from("data_retention_runs")
      .select(
        "id, status, trigger_source, started_at, finished_at, members_anonymised, members_skipped, waivers_anonymised, failures, error",
      )
      .eq("dojo_id", data.dojoId)
      .order("started_at", { ascending: false })
      .limit(10);
    if (error) throw new Error(error.message);
    return (runs ?? []).map((r: any) => ({
      id: r.id,
      status: r.status,
      triggerSource: r.trigger_source,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      membersAnonymised: r.members_anonymised ?? 0,
      membersSkipped: r.members_skipped ?? 0,
      waiversAnonymised: r.waivers_anonymised ?? 0,
      failures: r.failures ?? 0,
      error: r.error ?? null,
    }));
  });

/** Exclude (or re-include) one record from automatic anonymisation, with a reason. */
export const setRetentionHold = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberId: string; hold: boolean; reason?: string }) => {
    if (d.hold && !String(d.reason ?? "").trim()) {
      throw new Error("Please record why this record is being kept");
    }
    if ((d.reason ?? "").length > 500) throw new Error("Reason is too long");
    return d;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "setRetentionHold");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const reason = data.hold ? String(data.reason ?? "").trim() : null;
    const { error } = await supabaseAdmin
      .from("members")
      .update({
        retention_hold: data.hold,
        retention_hold_reason: reason,
        retention_hold_by: data.hold ? userId : null,
        retention_hold_at: data.hold ? new Date().toISOString() : null,
      })
      .eq("id", data.memberId)
      .eq("dojo_id", data.dojoId);
    if (error) throw new Error(error.message);

    await supabaseAdmin.from("data_retention_events").insert({
      dojo_id: data.dojoId,
      member_id: data.memberId,
      action: data.hold ? "hold_added" : "hold_removed",
      reason,
      details: { actor_user_id: userId } as any,
    });
    return { ok: true as const };
  });

/** Run the policy now, for gyms that want to act ahead of the nightly job. */
export const runRetentionNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertOwnerOrAdmin(supabase, userId, data.dojoId, "runRetentionNow");
    const { runRetentionSweepForDojo } = await import("@/lib/data-retention.server");
    return runRetentionSweepForDojo(data.dojoId, { source: "manual", force: true });
  });

/** Retention position for one member, shown on their profile. */
export const getMemberRetention = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "getMemberRetention");
    const { assessMemberRetention } = await import("@/lib/data-retention.server");
    return assessMemberRetention(data.dojoId, data.memberId);
  });
