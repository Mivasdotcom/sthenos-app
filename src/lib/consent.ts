/** Shared media-consent helpers. */

/** True when the date of birth means the person is under 18 today. */
export function isMinor(dateOfBirth?: string | null): boolean {
  if (!dateOfBirth) return false;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return false;
  const eighteenth = new Date(
    dob.getFullYear() + 18,
    dob.getMonth(),
    dob.getDate(),
  );
  return eighteenth.getTime() > Date.now();
}

export function mediaConsentLabel(gymName: string, minor: boolean): string {
  return minor
    ? `I confirm that, as parent or guardian, I consent to ${gymName} using photos and training footage of this member for social media and marketing.`
    : `I consent to ${gymName} using photos and training footage of me for social media and marketing.`;
}

export const MEDIA_CONSENT_HINT =
  "This is optional — you can join without agreeing, and you can withdraw consent at any time.";
