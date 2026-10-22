/**
 * Data-retention policy helpers (pure — safe on client and server).
 *
 * GDPR storage limitation: personal data must not be kept longer than
 * necessary. A gym sets two clocks, because they protect different things:
 *
 *  - MEMBER RECORDS of people who have left. Once the gym no longer needs to
 *    contact them, their personal details are anonymised. Financial records
 *    (invoices, payments, refunds) survive without personal data so revenue
 *    history and tax records stay intact.
 *
 *  - WAIVERS AND SAFETY RECORDS, deliberately kept LONGER. A signed waiver is
 *    the gym's defence if a former member brings a personal-injury claim, and
 *    those claims can surface years later. Deleting waivers early can actively
 *    harm the gym, so this clock is separate and defaults to 7 years.
 *
 * Either clock can be set to "retain indefinitely" (null) for gyms that prefer
 * to decide case by case.
 */

export type RetentionPolicy = {
  /** Automatic anonymisation runs only when the gym has switched it on. */
  autoEnabled: boolean;
  /** Months after departure before a member record is anonymised. null = keep indefinitely. */
  departedMonths: number | null;
  /** Months after signing before a waiver's personal details are scrubbed. null = keep indefinitely. */
  waiverMonths: number | null;
  /** How many days of in-app notice staff get before anything is anonymised. */
  noticeDays: number;
};

export const RETENTION_DEFAULTS: RetentionPolicy = {
  autoEnabled: false,
  departedMonths: 24,
  waiverMonths: 84,
  noticeDays: 14,
};

export const RETENTION_LIMITS = {
  departedMonthsMin: 1,
  departedMonthsMax: 240,
  waiverMonthsMin: 1,
  waiverMonthsMax: 480,
  noticeDaysMin: 0,
  noticeDaysMax: 90,
};

/** Read a policy off a dojos row, falling back to safe defaults. */
export function retentionPolicyFromDojo(dojo: any): RetentionPolicy {
  if (!dojo) return { ...RETENTION_DEFAULTS };
  const departed = dojo.retention_departed_months;
  const waiver = dojo.retention_waiver_months;
  return {
    autoEnabled: !!dojo.retention_auto_enabled,
    departedMonths: departed == null ? null : Number(departed),
    waiverMonths: waiver == null ? null : Number(waiver),
    noticeDays: Number(dojo.retention_notice_days ?? RETENTION_DEFAULTS.noticeDays),
  };
}

/** Add whole months to a date, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const targetDay = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(targetDay, lastDay));
  return d;
}

/** When a departed member's record falls due for anonymisation. */
export function anonymiseDueAt(
  departedAt: string | Date | null | undefined,
  months: number | null,
): Date | null {
  if (!departedAt || months == null) return null;
  const start = departedAt instanceof Date ? departedAt : new Date(departedAt);
  if (Number.isNaN(start.getTime())) return null;
  return addMonths(start, months);
}

export function daysUntil(date: Date | null, now = new Date()): number | null {
  if (!date) return null;
  return Math.ceil((date.getTime() - now.getTime()) / 86400000);
}

/** Reasons a record must never be anonymised automatically. */
export type RetentionBlocker =
  | "active_subscription"
  | "unpaid_balance"
  | "open_dispute"
  | "on_hold"
  | "still_a_member";

export const BLOCKER_LABELS: Record<RetentionBlocker, string> = {
  active_subscription: "Subscription still live",
  unpaid_balance: "Unpaid balance",
  open_dispute: "Open payment dispute",
  on_hold: "Excluded by staff",
  still_a_member: "Still a member",
};

/** Human summary of a policy, for settings and audit copy. */
export function retentionSummary(policy: RetentionPolicy): string {
  if (!policy.autoEnabled) return "Automatic anonymisation is off — nothing is deleted.";
  const member =
    policy.departedMonths == null
      ? "member records are kept indefinitely"
      : `member records are anonymised ${monthsLabel(policy.departedMonths)} after someone leaves`;
  const waiver =
    policy.waiverMonths == null
      ? "waivers are kept indefinitely"
      : `waivers are scrubbed after ${monthsLabel(policy.waiverMonths)}`;
  return `${member}; ${waiver}.`;
}

export function monthsLabel(months: number): string {
  if (months % 12 === 0) {
    const years = months / 12;
    return `${years} year${years === 1 ? "" : "s"}`;
  }
  return `${months} month${months === 1 ? "" : "s"}`;
}
