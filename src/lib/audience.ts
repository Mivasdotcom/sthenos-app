// Shared audience filter definition — used by segments, marketing broadcasts,
// and workflow triggers. Lives in client-safe code so the segment builder UI
// and the server-side evaluator share one source of truth.

export type RiskTier = "high" | "medium" | "low";
export type ReadinessStatus = "ready" | "almost" | "developing" | "early";
export type MemberStatus = "active" | "trial" | "lapsed";
/** Persisted retention level, written by recomputeRetentionScores(). */
export type RetentionRiskLevel = "healthy" | "watch" | "high";

export const RETENTION_RISK_LEVELS: RetentionRiskLevel[] = ["high", "watch", "healthy"];

export type AudienceFilter = {
  status?: MemberStatus[];
  plan?: string[];
  discipline?: string[];
  belt_color?: string[];
  risk_tier?: RiskTier[];
  readiness_status?: ReadinessStatus[];
  joined_within_days?: number | null;       // joined in the last N days
  last_seen_min_days?: number | null;       // last_seen older than N days (or never)
  min_visits_30d?: number | null;
  has_overdue_invoice?: boolean | null;
  exclude_marketing_opt_out?: boolean;      // marketing always sets this to true

  // ── Retention criteria (persisted on members by the nightly recompute) ──
  /** Match members whose persisted retention level is one of these. */
  retention_risk_level?: RetentionRiskLevel[];
  /** Persisted retention score strictly greater than this. */
  retention_risk_score_gt?: number | null;
  /** Days since the member was last seen, strictly greater than this. */
  days_since_last_seen_gt?: number | null;
  /** No-shows in the last 30 days, at least this many. */
  no_shows_last_30d_gte?: number | null;
  /** Match members whose risk factors mention a belt plateau. */
  has_belt_plateau_factor?: boolean | null;
  /** Match on members.payment_status. */
  payment_status?: string[];
};

export const EMPTY_FILTER: AudienceFilter = {};

/**
 * The audiences a gym actually emails, ready to pick.
 *
 * Broadcasts offered the whole roster, or a filter you had to build yourself
 * before you had written a word -- so across every gym on the platform not one
 * segment was ever saved, and the only thing anyone could send was an email to
 * everybody.
 *
 * Nobody sets out to define an audience. They set out to write to the people
 * who have stopped turning up. These are the four cases that covers, expressed
 * with filters the evaluator already supports.
 */
export type BuiltInAudience = {
  id: string;
  label: string;
  /** What it means in the gym's terms, not the filter's. */
  hint: string;
  filter: AudienceFilter;
};

export const BUILT_IN_AUDIENCES: BuiltInAudience[] = [
  {
    id: "trial",
    label: "On a trial",
    hint: "Still deciding — worth a word before it runs out",
    filter: { status: ["trial"] },
  },
  {
    id: "drifting",
    label: "Not seen in 30 days",
    hint: "Still paying, but they have stopped coming",
    filter: { last_seen_min_days: 30 },
  },
  {
    id: "overdue",
    label: "Payment overdue",
    hint: "A payment failed or is unpaid",
    filter: { has_overdue_invoice: true },
  },
  {
    id: "new",
    label: "Joined in the last 30 days",
    hint: "New faces — a welcome, or a beginners' class",
    filter: { joined_within_days: 30 },
  },
];

export function describeFilter(f: AudienceFilter): string {
  const parts: string[] = [];
  if (f.status?.length) parts.push(`status: ${f.status.join("/")}`);
  if (f.plan?.length) parts.push(`plan: ${f.plan.join("/")}`);
  if (f.discipline?.length) parts.push(`discipline: ${f.discipline.join("/")}`);
  if (f.belt_color?.length) parts.push(`belt: ${f.belt_color.join("/")}`);
  if (f.risk_tier?.length) parts.push(`risk: ${f.risk_tier.join("/")}`);
  if (f.readiness_status?.length) parts.push(`readiness: ${f.readiness_status.join("/")}`);
  if (f.retention_risk_level?.length) parts.push(`retention risk: ${f.retention_risk_level.join("/")}`);
  if (f.retention_risk_score_gt != null) parts.push(`risk score >${f.retention_risk_score_gt}`);
  if (f.days_since_last_seen_gt != null) parts.push(`last seen >${f.days_since_last_seen_gt}d`);
  if (f.no_shows_last_30d_gte != null) parts.push(`≥${f.no_shows_last_30d_gte} no-shows/30d`);
  if (f.has_belt_plateau_factor) parts.push("belt plateau");
  if (f.payment_status?.length) parts.push(`payment: ${f.payment_status.join("/")}`);
  if (f.joined_within_days) parts.push(`joined ≤${f.joined_within_days}d`);
  if (f.last_seen_min_days) parts.push(`last seen >${f.last_seen_min_days}d`);
  if (f.min_visits_30d != null) parts.push(`≥${f.min_visits_30d} visits/30d`);
  if (f.has_overdue_invoice) parts.push("has overdue invoice");
  return parts.length ? parts.join(" · ") : "All members";
}
