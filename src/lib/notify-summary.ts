// Client-safe shape describing what ACTUALLY happened when we tried to tell
// members about a change. Staff-facing UI must use this instead of asserting
// "the member was told" — a failed email that looks successful is worse than no
// email at all.

export type NotifyFailure = {
  memberId: string | null;
  name: string | null;
  to: string | null;
  error: string;
  /** Retryable: blocked pending sending-domain verification. */
  pending: boolean;
};

export type NotifySummary = {
  /** How many members we tried to notify. */
  attempted: number;
  /** Emails the provider accepted. */
  emailed: number;
  /** In-app messages written (always the durable record). */
  inApp: number;
  /** Members whose email did not go out. */
  failed: number;
  failures: NotifyFailure[];
};

export const EMPTY_NOTIFY_SUMMARY: NotifySummary = {
  attempted: 0,
  emailed: 0,
  inApp: 0,
  failed: 0,
  failures: [],
};

/** One plain-English sentence about the real outcome. Null when nothing was attempted. */
export function notifySentence(s: NotifySummary | null | undefined): string | null {
  if (!s || s.attempted === 0) return null;
  if (s.failed === 0) {
    return s.attempted === 1
      ? "The member was emailed and has an in-app message."
      : `All ${s.attempted} members were emailed and have an in-app message.`;
  }
  const who = s.failed === 1 ? "1 member" : `${s.failed} members`;
  const detail = s.failures[0]?.error ? ` (${s.failures[0]!.error})` : "";
  const inApp = s.inApp > 0 ? " The in-app message was still saved." : "";
  return `Email failed for ${who}${detail}.${inApp} Check Settings → Email to retry.`;
}

/** True when staff must be warned that someone was not actually reached. */
export function notifyHasFailure(s: NotifySummary | null | undefined): boolean {
  return !!s && s.failed > 0;
}
