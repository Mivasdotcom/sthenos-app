/**
 * Minors / guardian helpers.
 *
 * A member is a minor when their date of birth puts them under 18 today.
 * Minors sign the gym's MINOR waiver (when published) through a parent or
 * guardian, and all outbound contact goes to the guardian's email.
 */

export type WaiverAudience = "adult" | "minor";

export const GUARDIAN_RELATIONSHIPS = [
  "Mother",
  "Father",
  "Step-parent",
  "Grandparent",
  "Legal guardian",
  "Other",
] as const;

/** Age in whole years, or null when the date of birth is unknown/invalid. */
export function ageFromDob(dob: string | null | undefined): number | null {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  return age;
}

/** Under 18 today. Unknown date of birth is treated as an adult. */
export function isUnder18(dob: string | null | undefined): boolean {
  const age = ageFromDob(dob);
  return age != null && age < 18;
}

export function waiverAudienceFor(dob: string | null | undefined): WaiverAudience {
  return isUnder18(dob) ? "minor" : "adult";
}

/**
 * The address to use when contacting a member. Minors are contacted through
 * their guardian; everyone else through their own email.
 */
export function contactEmailFor(member: {
  email?: string | null;
  date_of_birth?: string | null;
  guardian_email?: string | null;
}): string | null {
  if (isUnder18(member.date_of_birth) && member.guardian_email) {
    return member.guardian_email;
  }
  return member.email ?? null;
}

/** True when a member turned 18 but their file still holds a guardian-signed waiver. */
export function needsAdultWaiverTransition(member: {
  date_of_birth?: string | null;
  waiver_audience_accepted?: string | null;
  waiver_signed_by?: string | null;
}): boolean {
  if (isUnder18(member.date_of_birth)) return false;
  if (!member.date_of_birth) return false;
  return (
    member.waiver_audience_accepted === "minor" || member.waiver_signed_by === "guardian"
  );
}
