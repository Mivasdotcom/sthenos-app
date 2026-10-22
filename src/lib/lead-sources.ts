export const LEAD_SOURCES = [
  "Social media",
  "Word of mouth",
  "Referral",
  "Google / search",
  "Instagram",
  "Walk-in",
  "Event / seminar",
  "Other",
] as const;

export type LeadSource = (typeof LEAD_SOURCES)[number];

export const REFERRAL_LEAD_SOURCE = "Referral";

export function isReferralSource(value: string | null | undefined) {
  return value === REFERRAL_LEAD_SOURCE;
}
