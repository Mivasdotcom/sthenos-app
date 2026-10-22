import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertDojoStaff } from "@/lib/dojo-access";
import {
  computeTrialStatus,
  dojoTodayIso,
  freeAccessWindow,
  trialPolicyFromDojo,
  type TrialPolicy,
  type TrialStatus,
} from "@/lib/trial-policy";

export type { TrialStatus, TrialPolicy };

const DOJO_POLICY_COLS =
  "timezone, trial_length_days, trial_classes_per_day, trial_max_total_classes, signup_free_days";

type Counts = {
  usedToday: number;
  usedTotal: number;
  upcoming: number;
  /** Gym-local date of the first ATTENDED class — the trial start rule. */
  firstAttended: string | null;
  nextBooked: string | null;
};

function emptyCounts(): Counts {
  return { usedToday: 0, usedTotal: 0, upcoming: 0, firstAttended: null, nextBooked: null };
}

type Policy = { policy: TrialPolicy; timezone: string; freeDays: number };

async function loadPolicy(supabase: any, dojoId: string): Promise<Policy> {
  const { data: dojo, error } = await supabase
    .from("dojos")
    .select(DOJO_POLICY_COLS)
    .eq("id", dojoId)
    .maybeSingle();
  if (error) throw new Error(`Could not load trial policy: ${error.message}`);
  return {
    policy: trialPolicyFromDojo(dojo),
    timezone: (dojo as any)?.timezone || "UTC",
    freeDays: Number((dojo as any)?.signup_free_days ?? 0) || 0,
  };
}

/**
 * Gather per-member trial counts for one dojo, with every date resolved as a
 * calendar date in the gym's timezone.
 */
async function loadCounts(
  supabase: any,
  dojoId: string,
  memberIds: string[],
  date: string,
  timezone: string,
): Promise<Map<string, Counts>> {
  const out = new Map<string, Counts>();
  for (const id of memberIds) out.set(id, emptyCounts());
  if (!memberIds.length) return out;

  const [{ data: atts }, { data: bookings }] = await Promise.all([
    supabase
      .from("attendances")
      .select("member_id, checked_in_at")
      .eq("dojo_id", dojoId)
      .in("member_id", memberIds),
    supabase
      .from("class_bookings")
      .select("member_id, booked_for_date, status")
      .eq("dojo_id", dojoId)
      .in("member_id", memberIds),
  ]);

  const today = dojoTodayIso(timezone);

  for (const a of atts ?? []) {
    const c = out.get(a.member_id);
    if (!c) continue;
    const day = a.checked_in_at ? dojoTodayIso(timezone, new Date(a.checked_in_at)) : null;
    c.usedTotal += 1;
    if (day === date) c.usedToday += 1;
    if (day && (!c.firstAttended || day < c.firstAttended)) c.firstAttended = day;
  }
  for (const b of bookings ?? []) {
    const c = out.get(b.member_id);
    if (!c) continue;
    const day = String(b.booked_for_date ?? "").slice(0, 10);
    if (b.status === "booked" && day >= today) {
      c.upcoming += 1;
      if (!c.nextBooked || day < c.nextBooked) c.nextBooked = day;
    }
    if (day === date && (b.status === "booked" || b.status === "attended")) c.usedToday += 1;
  }
  return out;
}

/** Staff-facing: trial status for a set of members in one dojo. */
export const getTrialUsage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberIds: string[] }) => d)
  .handler(
    async ({ data, context }): Promise<{ policy: TrialPolicy; usage: TrialStatus[] }> => {
      const { supabase, userId } = context as any;
      await assertDojoStaff(supabase, userId, data.dojoId, "getTrialUsage");
      const ids = Array.from(new Set(data.memberIds)).filter(Boolean);

      const { policy, timezone, freeDays } = await loadPolicy(supabase, data.dojoId);
      if (!ids.length) return { policy, usage: [] };

      const date = dojoTodayIso(timezone);
      const [counts, { data: members }] = await Promise.all([
        loadCounts(supabase, data.dojoId, ids, date, timezone),
        supabase
          .from("members")
          .select("id, trial_started_at, free_trial_ends_at")
          .in("id", ids),
      ]);
      const startById = new Map<string, string | null>(
        (members ?? []).map((m: any) => [m.id, m.trial_started_at ?? null]),
      );
      const freeById = new Map<string, string | null>(
        (members ?? []).map((m: any) => [m.id, m.free_trial_ends_at ?? null]),
      );

      return {
        policy,
        usage: ids.map((id) => {
          const c = counts.get(id) ?? emptyCounts();
          return computeTrialStatus({
            memberId: id,
            policy,
            timezone,
            startDate: startById.get(id) ?? c.firstAttended ?? null,
            nextBookedDate: c.nextBooked,
            date,
            usedToday: c.usedToday,
            usedTotal: c.usedTotal,
            upcoming: c.upcoming,
            fullAccess: freeAccessWindow({
              freeTrialEndsAt: freeById.get(id) ?? null,
              timezone,
              days: freeDays,
            }),
          });
        }),
      };
    },
  );

/** Member-facing: my own trial status in this dojo. */
export const getMyTrialUsage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberId?: string | null }) => d)
  .handler(
    async ({ data, context }): Promise<(TrialStatus & { isTrial: boolean }) | null> => {
      const { supabase, userId } = context as any;
      // A parent reads their child's trial, and a child's rows are invisible
      // to the parent's own client, so counts come from the admin client once
      // the link has been checked.
      const { resolveActingMember } = await import("@/lib/managed-members.server");
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      let me: any = null;
      try {
        me = await resolveActingMember({
          db: supabaseAdmin,
          userId,
          dojoId: data.dojoId,
          memberId: data.memberId ?? null,
          columns: "id, status, trial_started_at, free_trial_ends_at",
        });
      } catch {
        return null;
      }
      if (!me) return null;

      const { policy, timezone, freeDays } = await loadPolicy(supabase, data.dojoId);

      const countsDb = data.memberId ? supabaseAdmin : supabase;
      const date = dojoTodayIso(timezone);
      const counts = (await loadCounts(countsDb, data.dojoId, [me.id], date, timezone)).get(me.id)!;

      return {
        ...computeTrialStatus({
          memberId: me.id,
          policy,
          timezone,
          startDate: me.trial_started_at ?? counts.firstAttended ?? null,
          nextBookedDate: counts.nextBooked,
          date,
          usedToday: counts.usedToday,
          usedTotal: counts.usedTotal,
          upcoming: counts.upcoming,
          fullAccess: freeAccessWindow({
            freeTrialEndsAt: me.free_trial_ends_at ?? null,
            timezone,
            days: freeDays,
          }),
        }),
        isTrial: me.status === "trial",
      };
    },
  );

export type RecordAttendanceResult =
  | { ok: true; overridden: boolean }
  | {
      ok: false;
      reason: NonNullable<TrialStatus["reason"]>;
      message: string;
      status: TrialStatus;
    };

/**
 * Staff check-in. Enforces the gym's trial policy — window, per-day limit and
 * optional total cap (a DB trigger is the hard guarantee); when a trial member
 * is out of allowance the caller gets a structured refusal it can turn into an
 * override prompt. Attending is also what STARTS the trial clock.
 */
export const recordAttendance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      dojoId: string;
      memberId: string;
      classId?: string | null;
      override?: boolean;
      overrideReason?: string | null;
    }) => d,
  )
  .handler(async ({ data, context }): Promise<RecordAttendanceResult> => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "recordAttendance");

    const { data: member, error: mErr } = await supabase
      .from("members")
      .select("id, status, trial_started_at, free_trial_ends_at")
      .eq("id", data.memberId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (mErr) throw mErr;
    if (!member) throw new Error("Member not found in this gym");

    let overriding = false;
    if (member.status === "trial") {
      const { policy, timezone, freeDays } = await loadPolicy(supabase, data.dojoId);
      const date = dojoTodayIso(timezone);
      const counts = (await loadCounts(supabase, data.dojoId, [member.id], date, timezone)).get(
        member.id,
      )!;
      const status = computeTrialStatus({
        memberId: member.id,
        policy,
        timezone,
        startDate: member.trial_started_at ?? counts.firstAttended ?? null,
        nextBookedDate: counts.nextBooked,
        date,
        usedToday: counts.usedToday,
        usedTotal: counts.usedTotal,
        upcoming: counts.upcoming,
        fullAccess: freeAccessWindow({
          freeTrialEndsAt: member.free_trial_ends_at ?? null,
          timezone,
          days: freeDays,
        }),
      });
      if (!status.allowed) {
        if (!data.override) {
          return {
            ok: false,
            reason: status.reason!,
            message: status.message ?? "This member's free trial is finished.",
            status,
          };
        }
        overriding = true;
      }
    }

    const nowIso = new Date().toISOString();
    const { error } = await supabase.from("attendances").insert({
      member_id: member.id,
      dojo_id: data.dojoId,
      class_id: data.classId ?? null,
      checked_in_at: nowIso,
      trial_override_by: overriding ? userId : null,
      trial_override_at: overriding ? nowIso : null,
      trial_override_reason: overriding
        ? (data.overrideReason ?? "Allowed by staff at check-in")
        : null,
    });
    if (error) throw new Error(error.message);

    await supabase.from("members").update({ last_seen_at: nowIso }).eq("id", member.id);

    // Their trial clock may have just started with this very check-in. If they
    // already picked a plan, correct the subscription's deferred first-charge
    // date to their real trial end (it was provisional until now).
    if (member.status === "trial") {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { syncTrialEndAfterAttendance } = await import("@/lib/trial-billing.server");
      await syncTrialEndAfterAttendance({
        supabaseAdmin,
        dojoId: data.dojoId,
        memberId: member.id,
      });
    }

    return { ok: true, overridden: overriding };

  });

export type TrialWindowBreach = {
  memberId: string;
  memberName: string;
  /** Last date the trial covers. */
  bookableUntil: string;
  /** Upcoming booked dates that fall beyond the trial window. */
  dates: string[];
};

/**
 * Staff-facing: upcoming bookings that fall OUTSIDE a trial member's window.
 * These are never cancelled automatically — the gym decides what to do, and
 * check-in still enforces the policy.
 */
export const getTrialWindowBreaches = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberIds?: string[] }) => d)
  .handler(async ({ data, context }): Promise<TrialWindowBreach[]> => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "getTrialWindowBreaches");

    const { policy, timezone, freeDays } = await loadPolicy(supabase, data.dojoId);
    if (policy.lengthDays == null && !freeDays) return [];
    const today = dojoTodayIso(timezone);

    let q = supabase
      .from("members")
      .select("id, name, trial_started_at, free_trial_ends_at")
      .eq("dojo_id", data.dojoId)
      .eq("status", "trial");
    if (data.memberIds?.length) q = q.in("id", data.memberIds);
    const { data: members, error } = await q;
    if (error) throw new Error(error.message);
    const ids = (members ?? []).map((m: any) => m.id);
    if (!ids.length) return [];

    const [counts, { data: bookings }] = await Promise.all([
      loadCounts(supabase, data.dojoId, ids, today, timezone),
      supabase
        .from("class_bookings")
        .select("member_id, booked_for_date, status")
        .eq("dojo_id", data.dojoId)
        .in("member_id", ids)
        .eq("status", "booked")
        .gte("booked_for_date", today),
    ]);

    const out: TrialWindowBreach[] = [];
    for (const m of members ?? []) {
      const c = counts.get(m.id) ?? emptyCounts();
      const status = computeTrialStatus({
        memberId: m.id,
        policy,
        timezone,
        startDate: (m as any).trial_started_at ?? c.firstAttended ?? null,
        nextBookedDate: c.nextBooked,
        date: today,
        usedToday: c.usedToday,
        usedTotal: c.usedTotal,
        upcoming: c.upcoming,
        fullAccess: freeAccessWindow({
          freeTrialEndsAt: (m as any).free_trial_ends_at ?? null,
          timezone,
          days: freeDays,
        }),
      });
      if (!status.bookableUntil) continue;
      const dates = (bookings ?? [])
        .filter(
          (b: any) =>
            b.member_id === m.id &&
            String(b.booked_for_date).slice(0, 10) > status.bookableUntil!,
        )
        .map((b: any) => String(b.booked_for_date).slice(0, 10))
        .sort();
      if (dates.length) {
        out.push({
          memberId: m.id,
          memberName: (m as any).name,
          bookableUntil: status.bookableUntil,
          dates: Array.from(new Set(dates)),
        });
      }
    }
    return out;
  });
