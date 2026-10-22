/** Shared helpers for the gym's member agreements (waiver + terms). */

export const DEFAULT_TERMS_TITLE = "Membership Terms & Conditions";

export const DEFAULT_TERMS_BODY = `1. Membership and payment
Membership fees are due at the start of each billing period. Late or failed payments may result in access being paused until the balance is cleared.

2. Cancellation notice
Memberships may be cancelled with 30 days' written notice. Your access continues until the end of the notice period.

3. Class etiquette
Arrive on time, train in clean uniform, maintain personal hygiene, and follow instructor direction at all times. Respectful behaviour towards training partners is required.

4. Guests and trials
Guests must be registered and complete a waiver before training. Trial sessions are at the discretion of the gym.

5. Injuries and safety
Report any injury or illness to a coach before training. Members train within their own limits and must tap early when required.

6. Changes to these terms
We may update these terms from time to time. Members will be asked to review and accept the latest version.`;

export type AgreementDoc = {
  id: string;
  version: number;
  title: string;
  body_markdown: string;
  updated_at?: string | null;
} | null;

/** A terms document only counts as "set" when it has actual body text. */
export function hasTerms(terms: AgreementDoc): boolean {
  return !!terms && terms.body_markdown.trim().length > 0;
}

/** True when the member accepted an older version than the one published. */
export function isOutOfDate(
  currentVersion: number | null | undefined,
  acceptedVersion: number | null | undefined,
): boolean {
  if (currentVersion == null) return false;
  if (acceptedVersion == null) return true;
  return acceptedVersion < currentVersion;
}

export function versionLabel(version: number | null | undefined): string {
  return version == null ? "—" : `v${version}`;
}
