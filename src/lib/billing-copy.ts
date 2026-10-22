/**
 * Member-facing wording about WHEN a plan is charged. Presentation only — the
 * actual anchoring/proration lives in `stripe-connect.server.ts` and the trial
 * deferral in `trial-billing.server.ts`; this module only describes them.
 *
 * Client-safe on purpose (the public signup page imports it), so it does not
 * touch the server-only billing modules.
 */

export type BillingModeCopy = "fixed_day" | "anniversary";

export function billingModeOf(dojo: unknown): BillingModeCopy {
  const raw = (dojo as Record<string, unknown> | null)?.["billing_mode"];
  return raw === "anniversary" ? "anniversary" : "fixed_day";
}

/** 1 -> "1st", 2 -> "2nd", 15 -> "15th", 22 -> "22nd". */
export function ordinal(n: number): string {
  const v = Math.trunc(n);
  const mod100 = Math.abs(v) % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${v}th`;
  const suffix = ["th", "st", "nd", "rd"][Math.abs(v) % 10] ?? "th";
  return `${v}${suffix}`;
}


/**
 * One sentence describing the first charge and the renewal date.
 *
 * - `onTrial`: nothing is taken today; the first charge lands at trial end.
 * - annual plans: charged in full on the signup date, renewing yearly.
 * - anniversary gyms: full price today, renewing on that same date monthly.
 * - fixed_day gyms: pro-rata now, then the full amount on the gym's own day.
 */
export function billingTimingSentence(args: {
  mode: BillingModeCopy;
  billingDayOfMonth?: number | null;
  /** Plan interval, e.g. "month" | "year". */
  interval?: string | null;
  onTrial?: boolean;
}): string {
  if (args.onTrial) {
    return "Nothing is charged today — your payment details are saved now and your first payment is only taken once your free trial has finished.";
  }
  if ((args.interval ?? "month") === "year") {
    return "You'll be charged the full amount today, and it renews on the same date each year.";
  }
  if (args.mode === "anniversary") {
    return "You'll be charged the full amount today, and it renews on the same date each month.";
  }
  const day = ordinal(args.billingDayOfMonth && args.billingDayOfMonth > 0 ? args.billingDayOfMonth : 1);
  return `You'll be charged a part-month amount for the rest of this period, then the full amount on the ${day} of each month.`;
}
