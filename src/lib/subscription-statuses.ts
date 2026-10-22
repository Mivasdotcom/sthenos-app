/**
 * Shared status constants for billing logic.
 *
 * These live in their own module because files that declare `createServerFn`
 * must be thin wrappers: automatic server-function splitting removes runtime
 * module-scope siblings, which would otherwise throw at module load.
 */
export const LIVE_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
] as const;

export const BILLABLE_MEMBER_STATUSES = ["active", "trial", "paused"] as const;
