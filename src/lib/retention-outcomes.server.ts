// Retention outcome tracking: resolve what happened after a member was flagged
// at risk, and aggregate the impact of outreach. Server-only.

const DAY = 86400000;

export type InterventionOutcome = "pending" | "returned" | "churned" | "no_change";

/**
 * Resolve open (pending) interventions for a dojo:
 *  - 'returned'  — a check-in after intervention_at (or flagged_at when no outreach)
 *  - 'churned'   — member status lapsed, or their subscription was canceled
 *  - 'no_change' — 30 days since flagged_at with neither of the above
 * Always scoped by dojo_id.
 */
export async function resolveInterventionOutcomes(client: any, dojoId: string) {
  const { data: open, error } = await client
    .from("retention_interventions")
    .select("id,member_id,flagged_at,intervention_at")
    .eq("dojo_id", dojoId)
    .eq("outcome", "pending");
  if (error) throw error;
  const rows = (open ?? []) as any[];
  if (!rows.length) return { resolved: 0, returned: 0, churned: 0, noChange: 0 };

  const memberIds = Array.from(new Set(rows.map((r) => r.member_id)));
  const earliest = rows.reduce(
    (min, r) => Math.min(min, new Date(r.intervention_at ?? r.flagged_at).getTime()),
    Date.now(),
  );

  const [memRes, attRes, subRes] = await Promise.all([
    client.from("members").select("id,status").eq("dojo_id", dojoId).in("id", memberIds),
    client
      .from("attendances")
      .select("member_id,checked_in_at")
      .eq("dojo_id", dojoId)
      .in("member_id", memberIds)
      .gte("checked_in_at", new Date(earliest).toISOString()),
    client
      .from("member_subscriptions")
      .select("member_id,status")
      .eq("dojo_id", dojoId)
      .in("member_id", memberIds),
  ]);
  if (memRes.error) throw memRes.error;
  if (attRes.error) throw attRes.error;
  if (subRes.error) throw subRes.error;

  const statusById = new Map<string, string>(
    (memRes.data ?? []).map((m: any) => [m.id, m.status]),
  );
  const lastSeenById = new Map<string, number>();
  for (const a of attRes.data ?? []) {
    const t = new Date(a.checked_in_at).getTime();
    if (t > (lastSeenById.get(a.member_id) ?? 0)) lastSeenById.set(a.member_id, t);
  }
  const subsByMember = new Map<string, string[]>();
  for (const s of subRes.data ?? []) {
    const arr = subsByMember.get(s.member_id) ?? [];
    arr.push(s.status);
    subsByMember.set(s.member_id, arr);
  }

  const now = Date.now();
  const tally = { returned: 0, churned: 0, noChange: 0 };

  for (const r of rows) {
    const anchor = new Date(r.intervention_at ?? r.flagged_at).getTime();
    const lastSeen = lastSeenById.get(r.member_id) ?? 0;
    const subStatuses = subsByMember.get(r.member_id) ?? [];
    const memberStatus = statusById.get(r.member_id);
    const churned =
      !memberStatus ||
      memberStatus === "lapsed" ||
      (subStatuses.length > 0 && subStatuses.every((s) => s === "canceled"));

    let outcome: InterventionOutcome | null = null;
    if (lastSeen > anchor) outcome = "returned";
    else if (churned) outcome = "churned";
    else if (now - new Date(r.flagged_at).getTime() >= 30 * DAY) outcome = "no_change";
    if (!outcome) continue;

    const { error: upErr } = await client
      .from("retention_interventions")
      .update({ outcome, outcome_at: new Date().toISOString() })
      .eq("id", r.id)
      .eq("dojo_id", dojoId);
    if (upErr) throw upErr;

    if (outcome === "returned") tally.returned++;
    else if (outcome === "churned") tally.churned++;
    else tally.noChange++;
  }

  return {
    resolved: tally.returned + tally.churned + tally.noChange,
    ...tally,
  };
}

export type RetentionImpact = {
  periodDays: number;
  flagged: number;
  contacted: number;
  notContacted: number;
  returned: number;
  churned: number;
  noChange: number;
  pending: number;
  saveRatePct: number | null;
  contactedReturnRatePct: number | null;
  notContactedReturnRatePct: number | null;
  contactedResolved: number;
  notContactedResolved: number;
  recentlySaved: Array<{
    memberId: string;
    name: string;
    factors: string[];
    returnedAt: string | null;
    contacted: boolean;
  }>;
  hasEnoughHistory: boolean;
};

/** Aggregate retention outreach impact for a dojo over the last `days` days. */
export async function computeRetentionImpact(
  client: any,
  dojoId: string,
  days = 90,
): Promise<RetentionImpact> {
  const since = new Date(Date.now() - days * DAY).toISOString();
  const { data, error } = await client
    .from("retention_interventions")
    .select(
      "id,member_id,flagged_at,intervention_at,outcome,outcome_at,risk_factors_at_flag,members(name)",
    )
    .eq("dojo_id", dojoId)
    .gte("flagged_at", since)
    .order("flagged_at", { ascending: false });
  if (error) throw error;
  const rows = (data ?? []) as any[];

  const contactedRows = rows.filter((r) => !!r.intervention_at);
  const notContactedRows = rows.filter((r) => !r.intervention_at);
  const returned = rows.filter((r) => r.outcome === "returned");
  const churned = rows.filter((r) => r.outcome === "churned").length;
  const noChange = rows.filter((r) => r.outcome === "no_change").length;
  const pending = rows.filter((r) => r.outcome === "pending").length;

  const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 100) : null);
  const contactedResolved = contactedRows.filter((r) => r.outcome !== "pending").length;
  const notContactedResolved = notContactedRows.filter((r) => r.outcome !== "pending").length;
  const contactedReturned = contactedRows.filter((r) => r.outcome === "returned").length;
  const notContactedReturned = notContactedRows.filter((r) => r.outcome === "returned").length;

  const recentlySaved = returned
    .slice()
    .sort((a, b) => String(b.outcome_at ?? "").localeCompare(String(a.outcome_at ?? "")))
    .slice(0, 8)
    .map((r) => ({
      memberId: r.member_id as string,
      name: (r.members?.name as string) ?? "Unknown",
      factors: Array.isArray(r.risk_factors_at_flag) ? (r.risk_factors_at_flag as string[]) : [],
      returnedAt: (r.outcome_at as string) ?? null,
      contacted: !!r.intervention_at,
    }));

  return {
    periodDays: days,
    flagged: rows.length,
    contacted: contactedRows.length,
    notContacted: notContactedRows.length,
    returned: returned.length,
    churned,
    noChange,
    pending,
    saveRatePct: pct(contactedReturned, contactedRows.length),
    contactedReturnRatePct: pct(contactedReturned, contactedResolved),
    notContactedReturnRatePct: pct(notContactedReturned, notContactedResolved),
    contactedResolved,
    notContactedResolved,
    recentlySaved,
    hasEnoughHistory: rows.length >= 3,
  };
}
