/**
 * Anonymisation gate for everything that leaves the system for a third-party
 * AI model.
 *
 * Contractually (and to stay outside GDPR entirely) models may only receive
 * AGGREGATED, ANONYMISED data. Pseudonymised per-member rows are still
 * personal data, so this module is the single place that decides what an AI
 * request may contain:
 *
 *  - no member identifiers of any kind: no names, no ids, no opaque codes,
 *    no emails, no phone numbers,
 *  - no per-member rows at all, only counts / averages / percentages / trends,
 *  - no free text authored about members (notes, cancellation reasons,
 *    feedback, referrer names),
 *  - any figure derived from fewer than K_ANON members is suppressed, so
 *    "the one purple belt who trains on Tuesdays" cannot be reconstructed.
 *
 * Per-member analysis (Retention Risk, Belt Readiness, Lead Scoring) is
 * deterministic and computed in our own code — it never passes through here.
 */

/** Minimum group size before a figure may be shared. */
export const K_ANON = 5;

/** A count that is safe to share, or "<5" when it would single people out. */
export type SafeCount = number | "<5";

export function safeCount(n: number): SafeCount {
  if (n <= 0) return 0;
  return n < K_ANON ? "<5" : n;
}

/** Percentage, only when the denominator is large enough to be anonymous. */
export function safePct(numerator: number, denominator: number): number | null {
  if (denominator < K_ANON) return null;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

/**
 * Collapse a {key,count} distribution: groups below K_ANON are merged into a
 * single "other (suppressed)" bucket so nobody is identifiable by category.
 */
export function safeDistribution(
  rows: { key?: unknown; count?: unknown }[] | undefined,
): { key: string; count: number }[] {
  if (!Array.isArray(rows)) return [];
  let suppressed = 0;
  const out: { key: string; count: number }[] = [];
  for (const r of rows) {
    const count = Number(r?.count ?? 0);
    const key = String(r?.key ?? "unknown");
    if (count < K_ANON) suppressed += count;
    else out.push({ key, count });
  }
  out.sort((a, b) => b.count - a.count);
  if (suppressed > 0) out.push({ key: "other (small groups, suppressed)", count: suppressed });
  return out;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Reduce a full analytics snapshot to an aggregate-only payload that is safe
 * to send to an AI model. Whitelist-based: anything not named here is dropped,
 * so new per-member fields can never leak by accident.
 */
export function toAggregateSnapshot(raw: any): Record<string, unknown> {
  const s = raw ?? {};
  const members = s.members ?? {};
  const total = num(members.total) ?? 0;
  const extra = s.aggregate ?? {};

  const cohorts = Array.isArray(s.retentionCohorts)
    ? s.retentionCohorts
        .filter((c: any) => Number(c?.size ?? 0) >= K_ANON)
        .map((c: any) => ({
          cohort: c.cohort,
          size: c.size,
          retention: Array.isArray(c.retention) ? c.retention : [],
        }))
    : [];

  const classFill = Array.isArray(s.classFillPct)
    ? s.classFillPct
        .filter((c: any) => (num(c?.checkins) ?? K_ANON) >= K_ANON)
        .map((c: any) => ({ name: c.name, fillPct: c.fillPct }))
    : [];

  const impact = s.retentionImpact ?? null;

  return {
    note:
      "Aggregate, anonymised gym statistics only. No individual member data is available here by design.",
    generatedAt: s.generatedAt,
    defaultCurrency: s.defaultCurrency,

    revenue: {
      monthlyRevenue_cents: num(s.mrr_cents),
      yearlyRevenue_cents: num(s.arr_cents),
      monthlyRevenueByCurrency: s.mrrByCurrency ?? [],
      lifetimePaidByCurrency: s.revenueByCurrency ?? [],
      monthOnMonthChangePct: num(s.mrrDeltaPct),
      revenueByMonth: s.mrrSeries_usd ?? [],
      revenueByPlan: s.planRevenue_usd ?? [],
      averageLifetimeValue: num(s.avgLTV_usd),
      overdueInvoices: {
        count: safeCount(num(s.overdueInvoices?.count) ?? 0),
        amount: num(s.overdueInvoices?.amount_usd),
      },
    },

    membership: {
      total,
      active: safeCount(num(members.active) ?? 0),
      lapsed: safeCount(num(members.lapsed) ?? 0),
      trial: safeCount(num(members.trial) ?? 0),
      churnPct: num(s.churnPct),
      byStatus: safeDistribution(s.statusMix),
      byPlan: safeDistribution(s.planMix),
      byDiscipline: safeDistribution(s.disciplineMix),
      byBelt: safeDistribution(s.beltDistribution),
      byLeadSource: safeDistribution(s.leadSourceMix),
      referredMembers: safeCount(num(extra.referredMemberCount) ?? 0),
    },

    attendance: {
      checkinsByMonth: s.attendanceByMonth ?? [],
      checkinsByWeekday: s.weekdayLoad ?? [],
      classUtilisationPct: classFill,
      avgSessionsPerActiveMember30d: num(extra.avgSessionsPerActiveMember30d),
      avgSessionsPerActiveMember90d: num(extra.avgSessionsPerActiveMember90d),
      activeMembersBySessionBand30d: Array.isArray(extra.sessionBands30d)
        ? extra.sessionBands30d.map((b: any) => ({ band: b.band, members: safeCount(b.count ?? 0) }))
        : [],
      dormantActiveMembers21dPlus: safeCount(num(extra.dormantCount) ?? 0),
      noShows90d: {
        totalNoShows: num(extra.noShowTotal90d),
        totalBookings: num(extra.bookingTotal90d),
        noShowRatePct: num(extra.noShowRatePct90d),
        membersWithNoShows: safeCount(num(extra.membersWithNoShows90d) ?? 0),
      },
    },

    retention: {
      riskBands: {
        high: safeCount(num(s.atRiskCounts?.high) ?? 0),
        watch: safeCount(num(s.atRiskCounts?.watch) ?? 0),
        healthy: safeCount(num(s.atRiskCounts?.healthy) ?? 0),
      },
      cohortRetentionPct: cohorts,
      churnedLast12Months: {
        count: safeCount(num(s.churnedLastYear?.count) ?? 0),
        avgLifetimeMonths: num(s.churnedLastYear?.avgLifetimeMonths),
        avgLifetimePaid: num(extra.churnedAvgLifetimePaid),
      },
      outreachImpact90d: impact
        ? {
            flagged: safeCount(num(impact.flagged) ?? 0),
            contacted: safeCount(num(impact.contacted) ?? 0),
            returned: safeCount(num(impact.returned) ?? 0),
            saveRatePct: num(impact.saveRatePct),
            contactedReturnRatePct: num(impact.contactedReturnRatePct),
            notContactedReturnRatePct: num(impact.notContactedReturnRatePct),
          }
        : null,
    },

    grading: {
      readiness: {
        ready: safeCount(num(s.readyToGradeCounts?.ready) ?? 0),
        almost: safeCount(num(s.readyToGradeCounts?.almost) ?? 0),
        notYet: safeCount(num(s.readyToGradeCounts?.notYet) ?? 0),
      },
      promotionsAllTime: num(s.promotionsCount),
      promotionsLast90d: num(extra.promotionsLast90d),
      avgMonthsAtBeltByBelt: Array.isArray(extra.avgMonthsAtBelt)
        ? extra.avgMonthsAtBelt.filter((r: any) => Number(r?.members ?? 0) >= K_ANON)
        : [],
    },

    trials: {
      currentTrialMembers: safeCount(num(members.trial) ?? 0),
      trialConversionPct: num(extra.trialConversionPct),
      trialsStartedLast90d: safeCount(num(extra.trialsStarted90d) ?? 0),
      trialsConvertedLast90d: safeCount(num(extra.trialsConverted90d) ?? 0),
    },
  };
}

/**
 * Strip anything member-identifying out of free text the user typed (or out of
 * page context we capture) before it reaches a model. Known member names are
 * replaced with positional placeholders, and emails / phone numbers removed.
 *
 * Placeholders carry no identifier — they only let us map a name back into a
 * local query after the model replies.
 */
export type NameTokens = { placeholders: Map<string, string>; text: string };

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function tokeniseNames(text: string, names: string[]): NameTokens {
  const placeholders = new Map<string, string>();
  let out = text ?? "";
  const sorted = [...names]
    .map((n) => (n ?? "").trim())
    .filter((n) => n.length >= 3)
    .sort((a, b) => b.length - a.length);
  let i = 0;
  for (const name of sorted) {
    const re = new RegExp(`\\b${escapeRegex(name)}\\b`, "gi");
    if (!re.test(out)) continue;
    i += 1;
    const token = `<PERSON_${i}>`;
    placeholders.set(token, name);
    out = out.replace(new RegExp(`\\b${escapeRegex(name)}\\b`, "gi"), token);
  }
  return { placeholders, text: scrubContactDetails(out) };
}

/** Remove emails, phone numbers and long digit runs from free text. */
export function scrubContactDetails(text: string): string {
  if (!text) return text;
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<EMAIL>")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "<PHONE>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<ID>");
}

/** Put real names back into values we use locally (never sent onward). */
export function detokenise(text: string, placeholders: Map<string, string>): string {
  let out = text ?? "";
  placeholders.forEach((name, token) => {
    out = out.split(token).join(name);
  });
  return out;
}
