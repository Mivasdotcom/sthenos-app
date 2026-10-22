/**
 * Free-trial policy, shared by client and server.
 *
 * A trial is described entirely by settings so both the old "one free class"
 * model and a "free trial week" are just configuration:
 *   - lengthDays: how long the trial runs from the FIRST ATTENDED class
 *                 (0 = no trial offered, null = no time limit)
 *   - perDay:     how many classes a trial member may take per day
 *   - maxTotal:   optional cap on total classes across the whole trial
 *
 * TIMEZONE: every date in a trial calculation is a calendar date in the GYM'S
 * timezone (`dojos.timezone`), the same way the monthly billing day resolves.
 * Mixing a local start date with a UTC "today" is what used to make "Day 1 of
 * 3" and "4 days left" disagree, so day number, end date and days remaining
 * are all derived here from one start date and one "today".
 *
 * START RULE: the clock starts on the first class the member ATTENDS, not the
 * first one they book. Booking ahead never burns trial days.
 */
export type TrialPolicy = {
  lengthDays: number | null;
  perDay: number;
  maxTotal: number | null;
};

export type TrialBlockReason =
  | "no_trial"
  | "window_ended"
  | "day_limit"
  | "total_cap"
  | "before_start"
  | "outside_window"
  | null;


export type TrialStatus = {
  memberId: string;
  policy: TrialPolicy;
  /** Gym timezone the dates below are expressed in. */
  timezone: string;
  /** Gym-local date this status was computed for. */
  date: string;
  /** Gym-local date of the first ATTENDED class; null until they attend. */
  startDate: string | null;
  clockStarted: boolean;
  /** True when they have not attended yet, so the trial has not begun. */
  notStarted: boolean;
  /** Next booked class date, used to say when the trial will start. */
  nextBookedDate: string | null;
  /** 1-based day of the trial for the date being asked about; 0 before it starts. */
  dayNumber: number;
  /** Last day of the trial window, null when unstarted or unlimited. */
  endsOn: string | null;
  usedToday: number;
  usedTotal: number;
  upcoming: number;
  /** Can they take a class on the date asked about? */
  allowed: boolean;
  reason: TrialBlockReason;
  message: string | null;
  /** The trial is over for good (window ended, cap hit, or none offered). */
  ended: boolean;
  /** Days left in the window (inclusive of today), null when unstarted/unlimited. */
  daysLeft: number | null;
  /**
   * Date the trial window is anchored to: the first ATTENDED class if they have
   * attended, otherwise the earliest class they have booked, otherwise today.
   */
  anchorDate: string | null;
  /** Last date a trial member may take (or book) a class; null = unlimited. */
  bookableUntil: string | null;
  /**
   * True when this is a SIGNUP FREE PERIOD (per-gym `signup_free_days`): full
   * class access for a fixed number of days from signup, with no per-day
   * allowance and no total cap. False for the attendance-based class trial.
   */
  fullAccess?: boolean;
};

/**
 * A signup free period: N free days from the MOMENT of signup (a rolling
 * window of N x 24 hours), ending at the exact instant the first payment is
 * taken. Comes from `dojos.signup_free_days` + `members.free_trial_ends_at`.
 *
 * ONE SOURCE OF TRUTH: every surface that talks about the free period — the
 * portal, the signup page, the welcome email, the reminder, the booking screen
 * and Stripe's `trial_end` — derives its numbers from this window, so they can
 * never disagree.
 *
 * CONVENTION: `endsOn` is the gym-local date the window closes, which is also
 * the date of the first payment. We always say "your free period runs until
 * <endsOn>, when your first payment is taken".
 */
export type FreeAccessWindow = {
  /** Length of the free period in days, as configured by the gym. */
  days: number;
  /** Exact instant the free period closes and the first charge is taken. */
  endsAt: string;
  /** Gym-local date of `endsAt` — also the first payment date. */
  endsOn: string;
  /** Whole days remaining, rounded up: on day 1 of 7 this is 7. */
  daysLeft: number;
  /** 1-based day of the free period, 1..days. */
  dayNumber: number;
  /** True once the window has closed. */
  ended: boolean;
};

/** Exact end instant of a free period that starts at `from`. */
export function signupFreePeriodEnd(days: number, from: Date = new Date()): Date {
  const n = Math.max(1, Math.round(Number(days) || 0) || 1);
  return new Date(from.getTime() + n * 86400000);
}

/**
 * Resolve a member's signup free period, or null when they aren't on one.
 * `freeTrialEndsAt` is the exact instant handed to Stripe as `trial_end`, so
 * the date shown to the member and the date they're charged always agree.
 */
export function freeAccessWindow(args: {
  freeTrialEndsAt: string | Date | null | undefined;
  timezone?: string | null;
  /** The gym's `signup_free_days`, used for "Day X of N". */
  days?: number | null;
  /** Instant to measure from; defaults to now. */
  now?: Date;
}): FreeAccessWindow | null {
  if (!args.freeTrialEndsAt) return null;
  const at = args.freeTrialEndsAt instanceof Date ? args.freeTrialEndsAt : new Date(args.freeTrialEndsAt);
  if (Number.isNaN(at.getTime())) return null;
  const days = Math.max(1, Math.round(Number(args.days ?? 0) || 0) || 1);
  const now = args.now ?? new Date();
  const remainingMs = at.getTime() - now.getTime();
  const startedMs = at.getTime() - days * 86400000;
  // Rolling window: day 1 begins at the moment of signup and lasts 24 hours, so
  // "day X of N" and "N days left" are two views of ONE elapsed figure and can
  // never disagree — a member on day 1 of 7 has 7 days left, not 8.
  const elapsedDays = Math.floor(Math.max(0, now.getTime() - startedMs) / 86400000);
  const dayNumber = Math.min(days, elapsedDays + 1);
  const ended = remainingMs <= 0;
  return {
    days,
    endsAt: at.toISOString(),
    endsOn: dojoTodayIso(args.timezone, at),
    daysLeft: ended ? 0 : days - dayNumber + 1,
    dayNumber,
    ended,
  };

}




export const DEFAULT_TRIAL_POLICY: TrialPolicy = {
  lengthDays: 7,
  perDay: 1,
  maxTotal: null,
};

/** Read a policy off a dojo row (any shape holding the three columns). */
export function trialPolicyFromDojo(dojo: unknown): TrialPolicy {
  const d = (dojo ?? {}) as Record<string, unknown>;
  const len = d["trial_length_days"];
  const perDay = Number(d["trial_classes_per_day"] ?? 1);
  const maxTotal = d["trial_max_total_classes"];
  return {
    lengthDays: len == null ? null : Math.max(0, Math.round(Number(len))),
    perDay: Number.isFinite(perDay) && perDay > 0 ? Math.round(perDay) : 1,
    maxTotal: maxTotal == null ? null : Math.max(0, Math.round(Number(maxTotal))),
  };
}

export function trialOffered(policy: TrialPolicy): boolean {
  if (policy.lengthDays === 0) return false;
  if (policy.maxTotal === 0) return false;
  return true;
}

/** Name the free option from the policy, or null when no trial is offered. */
export function trialPolicyLabel(policy: TrialPolicy): string | null {
  if (!trialOffered(policy)) return null;
  if (policy.maxTotal != null) {
    return policy.maxTotal === 1 ? "Free Trial Class" : `${policy.maxTotal} Free Trial Classes`;
  }
  const days = policy.lengthDays;
  if (days == null) return "Free Trial";
  if (days === 1) return "Free Trial Class";
  if (days === 7) return "Free Trial Week";
  if (days === 14) return "Free Trial Fortnight";
  return `${days}-Day Free Trial`;
}

/** One-line description for the public signup page. */
export function trialPolicyDescription(policy: TrialPolicy): string {
  const perDay =
    policy.perDay === 1 ? "one class a day" : `up to ${policy.perDay} classes a day`;
  if (policy.maxTotal != null) {
    return policy.maxTotal === 1
      ? "One free class, no payment. Choose a plan afterwards to keep training."
      : `${policy.maxTotal} free classes, no payment. Choose a plan afterwards to keep training.`;
  }
  if (policy.lengthDays == null) {
    return `${perDay}, no payment. Choose a plan whenever you're ready.`;
  }
  if (policy.lengthDays === 1) {
    return "One free class, no payment. Choose a plan afterwards to keep training.";
  }
  return `${perDay} for ${policy.lengthDays} days from the first class you attend, no payment. Choose a plan afterwards to keep training.`;
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000,
  );
}

/** Today's calendar date in the gym's timezone (falls back to UTC). */
export function dojoTodayIso(timezone?: string | null, at: Date = new Date()): string {
  const tz = timezone && timezone.trim() ? timezone : "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
    // en-CA yields YYYY-MM-DD.
    return parts.replace(/\//g, "-");
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** @deprecated use dojoTodayIso(dojo.timezone) — trial dates are gym-local. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Evaluate the policy for a member on a gym-local date. Mirrors the database
 * function (`public.trial_check`), which is the hard guarantee.
 *
 * Day number, end date and days remaining all come from `startDate`, so they
 * can never contradict each other.
 */
export function computeTrialStatus(args: {
  memberId: string;
  policy: TrialPolicy;
  /** Gym timezone; dates are calendar dates in this zone. */
  timezone?: string | null;
  /** Gym-local date of the first ATTENDED class, null until they attend. */
  startDate: string | null;
  /** Next booked class date, so we can say when the trial will start. */
  nextBookedDate?: string | null;
  /** Gym-local date to evaluate; defaults to today in the gym's timezone. */
  date?: string;
  /** Gym-local "today"; only differs from `date` when evaluating another day. */
  today?: string;
  usedToday: number;
  usedTotal: number;
  upcoming: number;
  /**
   * SIGNUP FREE PERIOD (per-gym `signup_free_days`, off by default). When set,
   * the member gets FULL access until `endsOn`: no attendance clock, no per-day
   * allowance, no total cap. Mirrors `public.trial_check`.
   */
  fullAccess?: FreeAccessWindow | null;
}): TrialStatus {
  if (args.fullAccess) {
    const tz = args.timezone && args.timezone.trim() ? args.timezone : "UTC";
    const today = args.today ?? dojoTodayIso(tz);
    const date = args.date ?? today;
    // Day number, days left and the end date all come straight from the one
    // rolling window (see `freeAccessWindow`), so they cannot contradict each
    // other or the date Stripe charges on.
    const { days, endsOn, dayNumber, daysLeft } = args.fullAccess;
    const start = addDays(endsOn, -Math.max(days, 1));
    const over = args.fullAccess.ended || date > endsOn;
    return {
      memberId: args.memberId,
      policy: { lengthDays: days, perDay: Number.MAX_SAFE_INTEGER, maxTotal: null },
      timezone: tz,
      date,
      startDate: start,
      clockStarted: true,
      notStarted: false,
      nextBookedDate: args.nextBookedDate ?? null,
      dayNumber,
      endsOn,
      usedToday: args.usedToday,
      usedTotal: args.usedTotal,
      upcoming: args.upcoming,
      allowed: !over,
      reason: over ? "window_ended" : null,
      message: over ? `Your free period ended on ${formatDay(endsOn)}.` : null,
      ended: over,
      daysLeft: over ? 0 : daysLeft,
      anchorDate: start,
      bookableUntil: endsOn,
      fullAccess: true,
    };
  }

  const { policy } = args;
  const timezone = args.timezone && args.timezone.trim() ? args.timezone : "UTC";
  const today = args.today ?? dojoTodayIso(timezone);
  const date = args.date ?? today;
  const recorded = args.startDate ?? null;
  // A start date after the date we're evaluating means the trial has not begun
  // yet (legacy rows set from a future booking); treat it as unstarted rather
  // than showing "Day 1" for a trial that hasn't started.
  const future = recorded != null && recorded > date;
  const start = future ? null : recorded;
  const clockStarted = start != null;
  const dayNumber = start != null ? daysBetween(start, date) + 1 : 0;

  // ONE window for everything: the trial is anchored to the first class they
  // ATTENDED; before they attend anything it is anchored provisionally to the
  // earliest class they have booked (or today when they have booked nothing).
  // Day number, days remaining, the last bookable day and the check-in cut-off
  // all come from this anchor, so they can never disagree.
  const provisional = recorded ?? args.nextBookedDate ?? null;
  const anchor = start ?? provisional ?? today;
  const len = policy.lengthDays == null ? null : Math.max(policy.lengthDays, 1);
  const bookableUntil = len == null ? null : addDays(anchor, len - 1);
  const endsOn = start != null && len != null ? addDays(start, len - 1) : null;
  const daysLeft = endsOn ? Math.max(0, daysBetween(date, endsOn) + 1) : null;

  let reason: TrialBlockReason = null;
  let message: string | null = null;

  if (!trialOffered(policy)) {
    reason = "no_trial";
    message = "This gym doesn't include free trial classes.";
  } else if (endsOn && date > endsOn) {
    reason = "window_ended";
    message = `The ${policy.lengthDays}-day free trial finished on ${formatDay(endsOn)}.`;
  } else if (bookableUntil && date > bookableUntil) {
    reason = "outside_window";
    message = `A ${policy.lengthDays}-day free trial runs to ${formatDay(
      bookableUntil,
    )}, so that class falls outside it.`;
  } else if (args.usedToday >= policy.perDay) {
    reason = "day_limit";
    message =
      policy.perDay === 1
        ? "A free trial allows one class a day, and that day is already taken."
        : `A free trial allows ${policy.perDay} classes a day, and that day is full.`;
  } else if (policy.maxTotal != null && args.usedTotal + args.upcoming >= policy.maxTotal) {
    reason = "total_cap";
    message =
      policy.maxTotal === 1
        ? "The free trial class has been used."
        : `All ${policy.maxTotal} free trial classes have been used.`;
  }

  const ended =
    reason === "no_trial" || reason === "window_ended" || reason === "total_cap";

  return {
    memberId: args.memberId,
    policy,
    timezone,
    date,
    startDate: start,
    clockStarted,
    notStarted: !clockStarted && !ended,
    nextBookedDate: args.nextBookedDate ?? (future ? recorded : null),
    dayNumber,
    endsOn,
    usedToday: args.usedToday,
    usedTotal: args.usedTotal,
    upcoming: args.upcoming,
    allowed: reason === null,
    reason,
    message,
    ended,
    daysLeft,
    anchorDate: anchor,
    bookableUntil,
  };

}

export function formatDay(iso: string): string {
  return new Date(iso + "T00:00:00Z").toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** "Day 3 of 7 · 1 class today" — the same phrasing for member and staff. */
export function trialProgressText(s: TrialStatus): string {
  if (s.fullAccess) {
    const total = s.policy.lengthDays ?? 0;
    return s.ended
      ? "Free period finished"
      : `Free period — day ${Math.min(s.dayNumber, total)} of ${total}, full access`;
  }
  if (!trialOffered(s.policy)) return "No free trial";
  if (!s.clockStarted) {
    const label = trialPolicyLabel(s.policy) ?? "Free trial";
    if (s.nextBookedDate) {
      return `${label} — starts at their first class on ${formatDay(s.nextBookedDate)}`;
    }
    return `${label} — starts at their first class`;
  }
  const parts: string[] = [];
  if (s.policy.lengthDays == null) parts.push(`Day ${s.dayNumber}`);
  else parts.push(`Day ${Math.min(s.dayNumber, s.policy.lengthDays)} of ${s.policy.lengthDays}`);
  parts.push(
    s.usedToday === 0
      ? "no class today"
      : `${s.usedToday} class${s.usedToday === 1 ? "" : "es"} today`,
  );
  if (s.policy.maxTotal != null) {
    parts.push(`${Math.min(s.usedTotal + s.upcoming, s.policy.maxTotal)}/${s.policy.maxTotal} used`);
  }
  return parts.join(" · ");
}

/**
 * One sentence describing where the member is, from the SAME status object as
 * the progress text — so a countdown can never disagree with "Day X of Y".
 */
export function trialCountdownText(s: TrialStatus): string | null {
  if (s.fullAccess) {
    if (s.ended) return "Your free period has finished.";
    const until = s.endsOn ? `, running until ${formatDay(s.endsOn)}` : "";
    if (s.daysLeft != null && s.daysLeft <= 1)
      return `Last day of your free period${until}, when your first payment is taken.`;
    return `${s.daysLeft} days left of your free period${until}, when your first payment is taken and your membership carries straight on.`;
  }

  if (!trialOffered(s.policy)) return null;
  if (s.notStarted) {
    return s.nextBookedDate
      ? `Your free trial starts on ${formatDay(s.nextBookedDate)}, at your first class.`
      : "Your free trial starts at your first class — book one whenever suits you.";
  }
  if (s.ended) return "Your free trial has finished — choose a plan to keep training.";
  if (s.daysLeft == null) return null;
  if (s.daysLeft <= 1) return "Today is the last day of your free trial.";
  return `${s.daysLeft} days left before you'll need a plan${
    s.endsOn ? `, ending ${formatDay(s.endsOn)}` : ""
  }.`;
}


/**
 * Why a trial member was refused, plus the conversion prompt — used at booking
 * and at check-in so both routes say the same thing.
 */
export function trialRefusalPrompt(s: TrialStatus): string {
  if (s.fullAccess) {
    return s.message ?? "Your free period has finished.";
  }
  const base = s.message ?? "Your free trial doesn't cover that class.";
  switch (s.reason) {
    case "day_limit":
      return `${base} Book another day within your trial, or choose a plan for unlimited access.`;
    case "outside_window":
      return `${base} Choose a plan to book beyond your free trial.`;
    default:
      return `${base} Choose a plan to keep training.`;
  }
}


/* ---------------------------------------------------------------------------
 * Deferring the first charge until a trial has actually run its course
 * -------------------------------------------------------------------------
 * When a trial member picks a plan we collect their payment method now but
 * set Stripe's `trial_end` so the first charge lands only once their free
 * trial is over. The trial clock starts on the member's FIRST ATTENDED class,
 * so until they attend there is nothing to count from and any date we choose
 * is provisional.
 *
 * PRINCIPLE: it is always better to charge a trial member slightly late than
 * slightly early. Late costs the gym a few days of revenue; early takes money
 * from someone who has not yet set foot in the gym.
 *
 * The provisional date is ALWAYS the gym's own trial length, never longer:
 *   - a class already booked  -> that class date plus the trial length
 *   - nothing booked yet      -> today plus the trial length
 * Stripe shows this figure to the member at checkout, so it must never promise
 * a longer trial than the gym offers. It is corrected (usually EXTENDED) to
 * the real trial end the moment they first attend.
 * ------------------------------------------------------------------------- */


export type TrialBillingEnd = {
  /** Gym-local date the first charge should fall on or after. */
  date: string;
  /** True while this is a placeholder awaiting the member's first class. */
  provisional: boolean;
};

/**
 * The date a trial member's first charge should be deferred to.
 * `null` when the gym offers no trial, or the trial has no time limit.
 */
export function trialBillingEnd(args: {
  policy: TrialPolicy;
  /** Gym-local date of the first ATTENDED class; null until they attend. */
  startDate: string | null;
  /** Earliest upcoming booked class date, if any. */
  nextBookedDate?: string | null;
  /** Gym-local today. */
  today: string;
}): TrialBillingEnd | null {
  const { policy } = args;
  if (!trialOffered(policy)) return null;
  const len = policy.lengthDays == null ? null : Math.max(policy.lengthDays, 1);
  if (len == null) return null;

  if (args.startDate) {
    // Real trial end: last day of the window from the first attended class.
    // A member three days in genuinely has fewer days left, so this stays as is.
    return { date: addDays(args.startDate, len - 1), provisional: false };
  }
  // NOT STARTED YET: the member has used none of their trial, so the placeholder
  // must be worth the FULL advertised length. The caller turns this date into
  // end-of-day, and Stripe counts from the moment of checkout — so we count the
  // full `len` days forward (not `len - 1`), otherwise a 7-day trial is shown at
  // checkout as "6 days free".
  if (args.nextBookedDate) {
    // They have a class booked — count the full trial from that class.
    return { date: addDays(args.nextBookedDate, len), provisional: true };
  }
  // Nothing booked yet: the full trial length from today.
  return { date: addDays(args.today, len), provisional: true };
}

