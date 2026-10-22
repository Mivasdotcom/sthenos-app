// Scheduler for `scheduled` workflows and the nightly retention recompute.
// Server-only (never imported by client code).
import { runWorkflowInternal } from "./workflows.functions";
import { recomputeRetentionForDojo } from "./retention.functions";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Parse the human-friendly cron strings used in trigger_config, e.g.
 * "daily_9am", "daily_8am", "weekly_monday_9am", "weekly_thursday_10am".
 */
export function parseSchedule(
  cron: string | null | undefined,
): { kind: "daily" | "weekly"; hour: number; weekday: number | null } | null {
  if (!cron) return null;
  const s = String(cron).toLowerCase().trim();
  const hourMatch = s.match(/(\d{1,2})\s*(am|pm)/);
  let hour = 9;
  if (hourMatch) {
    hour = Number(hourMatch[1]) % 12;
    if (hourMatch[2] === "pm") hour += 12;
  }
  if (s.startsWith("weekly")) {
    const day = WEEKDAYS.findIndex((d) => s.includes(d));
    return { kind: "weekly", hour, weekday: day >= 0 ? day : 1 };
  }
  if (s.startsWith("daily")) return { kind: "daily", hour, weekday: null };
  return null;
}

/** Is a scheduled workflow due at `now`, given when it last ran? */
export function isDue(
  cron: string | null | undefined,
  lastRunAt: string | null,
  now = new Date(),
): boolean {
  const sched = parseSchedule(cron);
  if (!sched) return false;
  if (now.getUTCHours() < sched.hour) return false;
  if (sched.kind === "weekly" && now.getUTCDay() !== sched.weekday) return false;
  if (!lastRunAt) return true;
  const elapsed = now.getTime() - new Date(lastRunAt).getTime();
  const minGap = sched.kind === "weekly" ? 6 * 86400000 : 20 * 3600000;
  return elapsed >= minGap;
}

/** Run every due scheduled workflow across all dojos. */
export async function runDueScheduledWorkflows(now = new Date()) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: workflows, error } = await supabaseAdmin
    .from("workflows")
    .select("*")
    .eq("enabled", true)
    .eq("trigger_type", "scheduled");
  if (error) throw error;

  // Archived gyms are dormant: their scheduled workflows do not act on members.
  const { archivedDojoIds } = await import("@/lib/archived-dojos.server");
  const archived = await archivedDojoIds();

  const results: Array<Record<string, unknown>> = [];
  for (const wf of workflows ?? []) {
    if (archived.has(wf.dojo_id)) continue;
    const cron = (wf.trigger_config as any)?.cron ?? null;
    if (!isDue(cron, wf.last_run_at, now)) continue;

    try {
      const r = await runWorkflowInternal({
        client: supabaseAdmin,
        workflow: wf,
        dojoId: wf.dojo_id,
        triggerSource: "scheduled",
        actorUserId: null,
      });
      results.push({ workflow_id: wf.id, dojo_id: wf.dojo_id, ...r });
    } catch (e: any) {
      console.error("[scheduled-workflows] failed", wf.id, e?.message);
      results.push({ workflow_id: wf.id, dojo_id: wf.dojo_id, error: e?.message ?? "failed" });
    }
  }
  return { considered: workflows?.length ?? 0, ran: results.length, results };
}

/** Nightly retention recompute for every active dojo. */
export async function recomputeRetentionForAllDojos() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: dojos, error } = await supabaseAdmin
    .from("dojos")
    .select("id")
    .is("archived_at", null);
  if (error) throw error;

  const { resolveInterventionOutcomes } = await import("./retention-outcomes.server");

  const results: Array<Record<string, unknown>> = [];
  for (const d of dojos ?? []) {
    try {
      const scored = await recomputeRetentionForDojo(supabaseAdmin, d.id);
      const outcomes = await resolveInterventionOutcomes(supabaseAdmin, d.id);
      results.push({ ...scored, outcomes });
    } catch (e: any) {
      console.error("[retention-nightly] failed", d.id, e?.message);
      results.push({ dojoId: d.id, error: e?.message ?? "failed" });
    }
  }
  return { dojos: results.length, results };
}

export { authorizeCron } from "./cron-auth.server";
