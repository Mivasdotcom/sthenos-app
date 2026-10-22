/**
 * Automatic data retention (GDPR storage limitation).
 *
 * Server-only engine. Two independent clocks per gym:
 *
 *   1. MEMBER RECORDS — anonymised `retention_departed_months` after the
 *      membership ended. Personal data goes; invoices, payments, refunds and
 *      attendance statistics stay so revenue history and tax records survive.
 *
 *   2. WAIVERS AND SAFETY RECORDS — scrubbed on their own, longer clock
 *      (`retention_waiver_months`, default 7 years) because a signed waiver is
 *      the gym's defence against a later personal-injury claim.
 *
 * Hard rules, never overridden by the schedule:
 *   - never anonymise someone with a live subscription
 *   - never anonymise someone with an unpaid balance
 *   - never anonymise someone with an open payment dispute
 *   - never anonymise a record staff have excluded (reason recorded)
 *
 * Every run is logged to data_retention_runs, and every individual action to
 * data_retention_events (which deliberately holds no personal data).
 *
 * Manual GDPR erasure (`deleteMember`) is unchanged and remains the immediate,
 * per-member response to an individual's request. This is the background policy.
 */

import {
  anonymiseDueAt,
  daysUntil,
  monthsLabel,
  retentionPolicyFromDojo,
  type RetentionBlocker,
  type RetentionPolicy,
} from "@/lib/retention-policy";

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

const LIVE_SUB_STATUSES = ["active", "trialing", "past_due", "unpaid", "incomplete"];
const UNPAID_INVOICE_STATUSES = ["due", "overdue"];
const UNPAID_PAYMENT_STATUSES = ["due", "overdue", "disputed"];

async function admin(): Promise<Admin> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

export const RETENTION_POLICY_COLS =
  "retention_auto_enabled, retention_departed_months, retention_waiver_months, retention_notice_days";

const MEMBER_COLS =
  "id, dojo_id, name, email, status, departed_at, anonymised_at, retention_hold, retention_hold_reason, retention_hold_at, retention_notified_at, payment_status, user_id, last_seen_at";

export type ScheduledMember = {
  id: string;
  name: string;
  email: string | null;
  status: string;
  departedAt: string | null;
  dueOn: string | null;
  daysUntilDue: number | null;
  blockers: RetentionBlocker[];
  holdReason: string | null;
  notifiedAt: string | null;
};

export type RetentionSchedule = {
  policy: RetentionPolicy;
  /** Past due and clear of blockers — will be anonymised on the next run. */
  dueNow: ScheduledMember[];
  /** Falls due inside the notice window. */
  dueSoon: ScheduledMember[];
  /** Past due but held back by a blocker or a staff exclusion. */
  blocked: ScheduledMember[];
  /** Departed, clock running, not due yet. */
  upcoming: ScheduledMember[];
  anonymisedCount: number;
  waiversDue: number;
};

/**
 * Load the blocker sets for a whole dojo in a handful of queries rather than
 * per member — sweeps run over every gym nightly.
 */
async function loadBlockerSets(db: Admin, dojoId: string) {
  const [subs, invoices, disputes] = await Promise.all([
    db
      .from("member_subscriptions")
      .select("member_id, status")
      .eq("dojo_id", dojoId)
      .in("status", LIVE_SUB_STATUSES as any),
    db
      .from("invoices")
      .select("member_id, status")
      .eq("dojo_id", dojoId)
      .in("status", UNPAID_INVOICE_STATUSES as any),
    db
      .from("disputes")
      .select("member_id, closed_at")
      .eq("dojo_id", dojoId)
      .is("closed_at", null),
  ]);

  if (subs.error) throw new Error(`Retention: subscription check failed — ${subs.error.message}`);
  if (invoices.error) throw new Error(`Retention: invoice check failed — ${invoices.error.message}`);
  if (disputes.error) throw new Error(`Retention: dispute check failed — ${disputes.error.message}`);

  return {
    liveSubs: new Set((subs.data ?? []).map((r: any) => r.member_id).filter(Boolean)),
    unpaid: new Set((invoices.data ?? []).map((r: any) => r.member_id).filter(Boolean)),
    disputed: new Set((disputes.data ?? []).map((r: any) => r.member_id).filter(Boolean)),
  };
}

function assess(
  member: any,
  policy: RetentionPolicy,
  sets: { liveSubs: Set<string>; unpaid: Set<string>; disputed: Set<string> },
  now: Date,
): ScheduledMember {
  const blockers: RetentionBlocker[] = [];
  if (!member.departed_at) blockers.push("still_a_member");
  if (member.retention_hold) blockers.push("on_hold");
  if (sets.liveSubs.has(member.id)) blockers.push("active_subscription");
  if (
    sets.unpaid.has(member.id) ||
    UNPAID_PAYMENT_STATUSES.includes(String(member.payment_status ?? ""))
  ) {
    blockers.push("unpaid_balance");
  }
  if (sets.disputed.has(member.id)) blockers.push("open_dispute");

  const due = anonymiseDueAt(member.departed_at, policy.departedMonths);
  return {
    id: member.id,
    name: member.name,
    email: member.email ?? null,
    status: member.status,
    departedAt: member.departed_at ?? null,
    dueOn: due ? due.toISOString() : null,
    daysUntilDue: daysUntil(due, now),
    blockers,
    holdReason: member.retention_hold_reason ?? null,
    notifiedAt: member.retention_notified_at ?? null,
  };
}

/** What is scheduled, what is held back and why — shown to staff before anything happens. */
export async function buildRetentionSchedule(
  dojoId: string,
  now = new Date(),
): Promise<RetentionSchedule> {
  const db = await admin();

  const { data: dojo, error: dojoErr } = await db
    .from("dojos")
    .select(RETENTION_POLICY_COLS)
    .eq("id", dojoId)
    .maybeSingle();
  if (dojoErr) throw new Error(`Retention: could not read the gym's policy — ${dojoErr.message}`);
  const policy = retentionPolicyFromDojo(dojo);

  const { data: members, error: memErr } = await db
    .from("members")
    .select(MEMBER_COLS)
    .eq("dojo_id", dojoId)
    .is("anonymised_at", null)
    .not("departed_at", "is", null)
    .order("departed_at", { ascending: true });
  if (memErr) throw new Error(`Retention: could not read members — ${memErr.message}`);

  const { count: anonymisedCount } = await db
    .from("members")
    .select("id", { count: "exact", head: true })
    .eq("dojo_id", dojoId)
    .not("anonymised_at", "is", null);

  const sets = await loadBlockerSets(db, dojoId);

  const dueNow: ScheduledMember[] = [];
  const dueSoon: ScheduledMember[] = [];
  const blocked: ScheduledMember[] = [];
  const upcoming: ScheduledMember[] = [];

  for (const m of members ?? []) {
    const row = assess(m, policy, sets, now);
    if (row.dueOn == null) {
      upcoming.push(row);
      continue;
    }
    const overdue = (row.daysUntilDue ?? 0) <= 0;
    if (overdue && row.blockers.length > 0) blocked.push(row);
    else if (overdue) dueNow.push(row);
    else if ((row.daysUntilDue ?? 0) <= policy.noticeDays) dueSoon.push(row);
    else upcoming.push(row);
  }

  let waiversDue = 0;
  if (policy.waiverMonths != null) {
    const cutoff = waiverCutoff(policy.waiverMonths, now);
    const { count } = await db
      .from("member_waivers")
      .select("id", { count: "exact", head: true })
      .eq("dojo_id", dojoId)
      .is("anonymised_at", null)
      .lt("signed_at", cutoff);
    waiversDue = count ?? 0;
  }

  return {
    policy,
    dueNow,
    dueSoon,
    blocked,
    upcoming,
    anonymisedCount: anonymisedCount ?? 0,
    waiversDue,
  };
}

function waiverCutoff(months: number, now: Date): string {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString();
}

async function logEvent(
  db: Admin,
  row: {
    dojoId: string;
    runId: string | null;
    memberId: string | null;
    action: string;
    reason?: string | null;
    departedAt?: string | null;
    policyMonths?: number | null;
    details?: Record<string, unknown>;
  },
) {
  const { error } = await db.from("data_retention_events").insert({
    dojo_id: row.dojoId,
    run_id: row.runId,
    member_id: row.memberId,
    action: row.action,
    reason: row.reason ?? null,
    departed_at: row.departedAt ?? null,
    policy_months: row.policyMonths ?? null,
    details: (row.details ?? {}) as any,
  });
  // A failure to audit must be visible, never silent.
  if (error) console.error("[retention] audit event insert failed", error, row);
}

/**
 * Strip a member's personal data in place, keeping the row so financial and
 * statistical history stays attached to something.
 *
 * Kept: invoices, payments, refunds, attendance and booking counts, belt and
 * discipline, join/leave dates, signed waivers (their own longer clock).
 * Removed: name, email, phone, date of birth, guardian details, free-text
 * notes and reasons, portal login, saved cards, message history, email log.
 */
export async function anonymiseMemberRecord(opts: {
  dojoId: string;
  memberId: string;
  runId?: string | null;
  source: "scheduled" | "manual";
  actorUserId?: string | null;
  reason?: string | null;
  policyMonths?: number | null;
}): Promise<{ ok: true }> {
  const db = await admin();
  const { dojoId, memberId } = opts;

  const { data: member, error: memErr } = await db
    .from("members")
    .select("id, dojo_id, email, departed_at, anonymised_at, user_id, stripe_customer_id")
    .eq("id", memberId)
    .eq("dojo_id", dojoId)
    .maybeSingle();
  if (memErr) throw new Error(memErr.message);
  if (!member) throw new Error("Member not found in this gym");
  if (member.anonymised_at) return { ok: true };

  // Message history is personal data on both sides of the conversation.
  const { data: convos } = await db
    .from("conversations")
    .select("id")
    .eq("member_id", memberId)
    .eq("dojo_id", dojoId);
  if ((convos ?? []).length > 0) {
    const ids = (convos ?? []).map((c: any) => c.id);
    const { error } = await db.from("messages").delete().in("conversation_id", ids);
    if (error) console.error("[retention] delete messages failed", error);
    const { error: cErr } = await db.from("conversations").delete().in("id", ids);
    if (cErr) console.error("[retention] delete conversations failed", cErr);
  }

  // Saved cards carry billing details.
  const { error: pmErr } = await db
    .from("member_payment_methods")
    .delete()
    .eq("member_id", memberId)
    .eq("dojo_id", dojoId);
  if (pmErr) console.error("[retention] delete member_payment_methods failed", pmErr);

  // The email log and unsubscribe tokens are keyed by address, not member.
  const memberEmail = (member as any).email as string | null;
  if (memberEmail) {
    const { error: logErr } = await db
      .from("email_send_log")
      .delete()
      .ilike("recipient_email", memberEmail);
    if (logErr) console.error("[retention] delete email_send_log failed", logErr);
    const { error: tokErr } = await db
      .from("email_unsubscribe_tokens")
      .delete()
      .ilike("email", memberEmail);
    if (tokErr) console.error("[retention] delete email_unsubscribe_tokens failed", tokErr);
  }


  // Free-text reasons in satellite tables can name people.
  const { error: cancelErr } = await db
    .from("cancellation_audit_log")
    .update({ reason: null })
    .eq("member_id", memberId)
    .eq("dojo_id", dojoId);
  if (cancelErr) console.error("[retention] cancellation reason scrub failed", cancelErr);

  const { error: histErr } = await db
    .from("member_status_history")
    .update({ reason: null })
    .eq("member_id", memberId)
    .eq("dojo_id", dojoId);
  if (histErr) console.error("[retention] status history scrub failed", histErr);

  // The member row itself.
  const { error: updErr } = await db
    .from("members")
    .update({
      name: "Former member",
      email: null,
      phone: null,
      date_of_birth: null,
      guardian_name: null,
      guardian_email: null,
      guardian_phone: null,
      guardian_relationship: null,
      cancellation_reason: null,
      pause_note: null,
      pause_reason: null,
      referred_by: null,
      user_id: null,
      stripe_customer_id: null,
      retention_risk_factors: [] as any,
      retention_notified_at: null,
      marketing_opt_out: true,
      partner_matching_opt_in: false,
      anonymised_at: new Date().toISOString(),
    })
    .eq("id", memberId)
    .eq("dojo_id", dojoId);
  if (updErr) throw new Error(`Anonymisation failed: ${updErr.message}`);

  // If they had a portal login used for nothing else, remove it too — the auth
  // account still holds their email address.
  if (member.user_id) {
    await removeOrphanedLogin(db, member.user_id as string);
  }

  await logEvent(db, {
    dojoId,
    runId: opts.runId ?? null,
    memberId,
    action: "member_anonymised",
    reason: opts.reason ?? (opts.source === "manual" ? "Anonymised by staff" : "Retention period elapsed"),
    departedAt: member.departed_at,
    policyMonths: opts.policyMonths ?? null,
    details: { source: opts.source, actor_user_id: opts.actorUserId ?? null },
  });

  return { ok: true };
}

/** Delete the auth login only when it is not used by any other member or staff role. */
async function removeOrphanedLogin(db: Admin, userId: string) {
  try {
    const { data: otherMembers } = await db
      .from("members")
      .select("id")
      .eq("user_id", userId)
      .is("anonymised_at", null)
      .limit(1);
    if ((otherMembers ?? []).length > 0) return;

    const { data: roles } = await db
      .from("dojo_memberships")
      .select("role")
      .eq("user_id", userId);
    const isStaff = (roles ?? []).some((r: any) =>
      ["owner", "manager", "admin", "coach"].includes(String(r.role)),
    );
    if (isStaff) return;

    await db.from("dojo_memberships").delete().eq("user_id", userId);
    await db.from("profiles").delete().eq("user_id", userId);
    const { error } = await db.auth.admin.deleteUser(userId);
    if (error) console.error("[retention] auth user delete failed", error);
  } catch (e) {
    console.error("[retention] orphaned login cleanup failed", e);
  }
}

/**
 * Scrub the personal details from waivers past their own, longer clock.
 * The proof a waiver was signed (version, audience, date) survives.
 */
export async function scrubDueWaivers(
  dojoId: string,
  policy: RetentionPolicy,
  runId: string | null,
  now = new Date(),
): Promise<number> {
  if (policy.waiverMonths == null) return 0;
  const db = await admin();
  const cutoff = waiverCutoff(policy.waiverMonths, now);

  const { data: rows, error } = await db
    .from("member_waivers")
    .select("id, member_id, signed_at")
    .eq("dojo_id", dojoId)
    .is("anonymised_at", null)
    .lt("signed_at", cutoff)
    .limit(500);
  if (error) throw new Error(`Retention: could not read waivers — ${error.message}`);
  if ((rows ?? []).length === 0) return 0;

  const { error: updErr } = await db
    .from("member_waivers")
    .update({
      signed_name: "[erased]",
      signature_text: "[erased]",
      guardian_name: null,
      guardian_email: null,
      guardian_phone: null,
      guardian_relationship: null,
      ip_address: null,
      user_agent: null,
      anonymised_at: new Date().toISOString(),
    })
    .in(
      "id",
      (rows ?? []).map((r: any) => r.id),
    );
  if (updErr) throw new Error(`Retention: waiver scrub failed — ${updErr.message}`);

  await logEvent(db, {
    dojoId,
    runId,
    memberId: null,
    action: "waivers_anonymised",
    reason: `Waiver retention of ${monthsLabel(policy.waiverMonths)} elapsed`,
    policyMonths: policy.waiverMonths,
    details: { count: (rows ?? []).length },
  });

  return (rows ?? []).length;
}

/** Raise one in-app task per gym when records first enter the notice window. */
async function raiseNotices(
  db: Admin,
  dojoId: string,
  schedule: RetentionSchedule,
  runId: string,
): Promise<number> {
  const fresh = [...schedule.dueSoon, ...schedule.dueNow].filter((m) => !m.notifiedAt);
  if (fresh.length === 0) return 0;

  const soonest = fresh
    .map((m) => m.dueOn)
    .filter(Boolean)
    .sort()[0];

  const { error: taskErr } = await db.from("internal_tasks").insert({
    dojo_id: dojoId,
    member_id: null,
    title: `${fresh.length} member record${fresh.length === 1 ? "" : "s"} due for anonymisation`,
    description:
      `Under your data retention policy, ${fresh.length} record${fresh.length === 1 ? "" : "s"} of members who have left ` +
      `will be anonymised${soonest ? ` from ${new Date(soonest).toLocaleDateString("en-GB")}` : " shortly"}. ` +
      `Personal details are removed; invoices, payments and training statistics are kept. ` +
      `Review the list in Settings → Data retention and exclude anyone you need to keep (ongoing dispute, unpaid balance, pending claim).`,
    status: "open",
  });
  if (taskErr) console.error("[retention] notice task insert failed", taskErr);

  const { error: markErr } = await db
    .from("members")
    .update({ retention_notified_at: new Date().toISOString() })
    .in(
      "id",
      fresh.map((m) => m.id),
    );
  if (markErr) console.error("[retention] notice mark failed", markErr);

  await logEvent(db, {
    dojoId,
    runId,
    memberId: null,
    action: "notice_raised",
    reason: "Advance notice given to staff",
    details: { count: fresh.length, soonest: soonest ?? null },
  });

  return fresh.length;
}

export type RetentionRunResult = {
  dojoId: string;
  status: "succeeded" | "partial" | "failed" | "skipped";
  considered: number;
  anonymised: number;
  skipped: number;
  waivers: number;
  notices: number;
  failures: number;
  error?: string;
};

/** Run the policy for one gym, logging the run and every action. */
export async function runRetentionSweepForDojo(
  dojoId: string,
  opts: { source?: "scheduled" | "manual"; force?: boolean } = {},
): Promise<RetentionRunResult> {
  const db = await admin();
  const source = opts.source ?? "scheduled";
  const now = new Date();

  const schedule = await buildRetentionSchedule(dojoId, now);
  const policy = schedule.policy;

  if (!policy.autoEnabled && !opts.force) {
    return {
      dojoId,
      status: "skipped",
      considered: 0,
      anonymised: 0,
      skipped: 0,
      waivers: 0,
      notices: 0,
      failures: 0,
    };
  }

  const { data: run, error: runErr } = await db
    .from("data_retention_runs")
    .insert({ dojo_id: dojoId, trigger_source: source, status: "running" })
    .select("id")
    .maybeSingle();
  if (runErr) throw new Error(`Retention: could not open a run log — ${runErr.message}`);
  const runId = (run as any)?.id as string;

  let anonymised = 0;
  let failures = 0;
  const errors: string[] = [];

  // Anything held back is recorded, so the reason is auditable later.
  for (const m of schedule.blocked) {
    await logEvent(db, {
      dojoId,
      runId,
      memberId: m.id,
      action: "skipped",
      reason: m.blockers.join(", ") + (m.holdReason ? ` — ${m.holdReason}` : ""),
      departedAt: m.departedAt,
      policyMonths: policy.departedMonths,
    });
  }

  for (const m of schedule.dueNow) {
    try {
      await anonymiseMemberRecord({
        dojoId,
        memberId: m.id,
        runId,
        source: "scheduled",
        policyMonths: policy.departedMonths,
      });
      anonymised += 1;
    } catch (e: any) {
      failures += 1;
      errors.push(`${m.id}: ${e?.message ?? "unknown error"}`);
      console.error("[retention] anonymise failed", { dojoId, memberId: m.id, error: e });
      await logEvent(db, {
        dojoId,
        runId,
        memberId: m.id,
        action: "failed",
        reason: e?.message ?? "unknown error",
        departedAt: m.departedAt,
        policyMonths: policy.departedMonths,
      });
    }
  }

  let waivers = 0;
  try {
    waivers = await scrubDueWaivers(dojoId, policy, runId, now);
  } catch (e: any) {
    failures += 1;
    errors.push(`waivers: ${e?.message ?? "unknown error"}`);
    console.error("[retention] waiver scrub failed", { dojoId, error: e });
  }

  let notices = 0;
  try {
    notices = await raiseNotices(db, dojoId, schedule, runId);
  } catch (e: any) {
    console.error("[retention] notices failed", { dojoId, error: e });
  }

  const status = failures > 0 ? (anonymised > 0 || waivers > 0 ? "partial" : "failed") : "succeeded";

  const { error: closeErr } = await db
    .from("data_retention_runs")
    .update({
      status,
      finished_at: new Date().toISOString(),
      members_considered: schedule.dueNow.length + schedule.blocked.length,
      members_anonymised: anonymised,
      members_skipped: schedule.blocked.length,
      waivers_anonymised: waivers,
      notices_raised: notices,
      failures,
      error: errors.length > 0 ? errors.join("; ").slice(0, 2000) : null,
      details: { policy } as any,
    })
    .eq("id", runId);
  if (closeErr) console.error("[retention] run close failed", closeErr);

  return {
    dojoId,
    status,
    considered: schedule.dueNow.length + schedule.blocked.length,
    anonymised,
    skipped: schedule.blocked.length,
    waivers,
    notices,
    failures,
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
  };
}

/** Nightly entry point: every gym that has switched automatic retention on. */
export async function runRetentionSweep(): Promise<{
  gyms: number;
  anonymised: number;
  waivers: number;
  notices: number;
  failed: number;
  results: RetentionRunResult[];
}> {
  const db = await admin();
  const { data: dojos, error } = await db
    .from("dojos")
    .select("id")
    .eq("retention_auto_enabled", true);
  if (error) throw new Error(`Retention: could not list gyms — ${error.message}`);

  const results: RetentionRunResult[] = [];
  for (const d of dojos ?? []) {
    try {
      results.push(await runRetentionSweepForDojo((d as any).id, { source: "scheduled" }));
    } catch (e: any) {
      console.error("[retention] sweep failed for gym", { dojoId: (d as any).id, error: e });
      results.push({
        dojoId: (d as any).id,
        status: "failed",
        considered: 0,
        anonymised: 0,
        skipped: 0,
        waivers: 0,
        notices: 0,
        failures: 1,
        error: e?.message ?? "unknown error",
      });
    }
  }

  return {
    gyms: results.length,
    anonymised: results.reduce((n, r) => n + r.anonymised, 0),
    waivers: results.reduce((n, r) => n + r.waivers, 0),
    notices: results.reduce((n, r) => n + r.notices, 0),
    failed: results.reduce((n, r) => n + r.failures, 0),
    results,
  };
}

/** Retention position for a single member, for their profile page. */
export async function assessMemberRetention(
  dojoId: string,
  memberId: string,
  now = new Date(),
): Promise<{ policy: RetentionPolicy; member: ScheduledMember | null; anonymisedAt: string | null }> {
  const db = await admin();
  const { data: dojo, error: dojoErr } = await db
    .from("dojos")
    .select(RETENTION_POLICY_COLS)
    .eq("id", dojoId)
    .maybeSingle();
  if (dojoErr) throw new Error(dojoErr.message);
  const policy = retentionPolicyFromDojo(dojo);

  const { data: member, error: memErr } = await db
    .from("members")
    .select(MEMBER_COLS)
    .eq("id", memberId)
    .eq("dojo_id", dojoId)
    .maybeSingle();
  if (memErr) throw new Error(memErr.message);
  if (!member) return { policy, member: null, anonymisedAt: null };

  const sets = await loadBlockerSets(db, dojoId);
  return {
    policy,
    member: assess(member, policy, sets, now),
    anonymisedAt: (member as any).anonymised_at ?? null,
  };
}
