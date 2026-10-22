// Pure helpers for cash / offline payments. Safe to import from components.

export type BillingPeriod = { start: string; end: string };

function iso(d: Date) {
  return d.toISOString().slice(0, 10);
}

/** Is this plan interval billed yearly? */
export function isYearlyInterval(interval: string | null | undefined) {
  return ["year", "yearly", "annual"].includes((interval ?? "month").toLowerCase());
}

/**
 * The billing period that `ref` falls into for a given plan interval.
 * Monthly plans use the calendar month; yearly plans the calendar year.
 */
export function currentPeriod(
  interval: string | null | undefined,
  ref: Date = new Date(),
): BillingPeriod {
  const y = ref.getFullYear();
  if (isYearlyInterval(interval)) {
    return { start: iso(new Date(y, 0, 1)), end: iso(new Date(y, 11, 31)) };
  }
  const m = ref.getMonth();
  return { start: iso(new Date(y, m, 1)), end: iso(new Date(y, m + 1, 0)) };
}

/** Whole days between two ISO dates (b - a), never negative. */
export function daysBetween(a: string, b: string) {
  const diff =
    (new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) / 86400000;
  return Math.max(0, Math.floor(diff));
}

/** The date a cash period's payment becomes overdue, given the gym's grace days. */
export function dueDateFor(periodStart: string, graceDays: number) {
  const d = new Date(periodStart + "T00:00:00");
  d.setDate(d.getDate() + Math.max(0, graceDays || 0));
  return iso(d);
}

export function periodLabel(p: BillingPeriod) {
  const s = new Date(p.start + "T00:00:00");
  const e = new Date(p.end + "T00:00:00");
  const sameYear = s.getFullYear() === e.getFullYear();
  if (s.getMonth() === 0 && e.getMonth() === 11 && sameYear) return String(s.getFullYear());
  if (s.getMonth() === e.getMonth() && sameYear) {
    return s.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }
  return `${s.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${e.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

/** Is a member paying by cash / offline rather than card? */
export function isCashPayer(paymentMethod: string | null | undefined) {
  return (paymentMethod ?? "card").toLowerCase() === "cash";
}

/**
 * Is a cash member overdue for the current billing period?
 * `coveredThrough` is the latest `period_end` recorded in `cash_payments`.
 * A member is only overdue once the gym's grace days have elapsed.
 */
export function isCashOverdue(opts: {
  coveredThrough: string | null | undefined;
  graceDays?: number | null;
  interval?: string | null;
  ref?: Date;
}) {
  const ref = opts.ref ?? new Date();
  const today = ref.toISOString().slice(0, 10);
  const period = currentPeriod(opts.interval, ref);
  const covered = opts.coveredThrough ? opts.coveredThrough >= period.end : false;
  if (covered) return false;
  return today >= dueDateFor(period.start, opts.graceDays ?? 0);
}

/** Compact label for the period a one-tap payment refers to, e.g. "August" or "2026". */
export function shortPeriodLabel(interval: string | null | undefined, ref: Date = new Date()) {
  if (isYearlyInterval(interval)) return String(ref.getFullYear());
  return ref.toLocaleDateString(undefined, { month: "long" });
}
