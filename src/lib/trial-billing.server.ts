/**
 * Trial-aware billing: a member who picks a plan while their free trial is
 * still running must not be charged until the trial has actually run its
 * course. We set Stripe's `trial_end` on the subscription, so the payment
 * method is collected at checkout and the first charge lands afterwards.
 *
 * The trial clock starts on the member's FIRST ATTENDED class, so before they
 * attend, any trial end date is provisional (see `trialBillingEnd`). The
 * moment they do attend, `syncTrialEndAfterAttendance` corrects the live
 * subscription to their real trial end.
 */
import {
  dojoTodayIso,
  formatDay,
  trialBillingEnd,
  trialPolicyFromDojo,
  type TrialBillingEnd,
} from "@/lib/trial-policy";
import { endOfLocalDayUnix, getPlatformStripe, hasStripeSecret } from "@/lib/stripe-connect.server";

const DOJO_TRIAL_COLS =
  "timezone, trial_length_days, trial_classes_per_day, trial_max_total_classes, signup_free_days";

export type TrialDeferral = TrialBillingEnd & {
  /** Unix seconds to hand Stripe as `trial_end`. */
  unix: number;
  timezone: string;
  /** Plain-language line for the member: "Nothing to pay until 14 Sep". */
  message: string;
};

/**
 * Work out whether this member's first charge should be deferred, and to when.
 * Returns null when they are not on a trial (or the gym offers none), in which
 * case checkout charges immediately exactly as before.
 */
export async function resolveTrialDeferral(
  supabaseAdmin: any,
  dojoId: string,
  memberId: string,
): Promise<TrialDeferral | null> {
  const [{ data: member }, { data: dojo }] = await Promise.all([
    supabaseAdmin
      .from("members")
      .select("id, status, trial_started_at, free_trial_ends_at, created_at")
      .eq("id", memberId)
      .eq("dojo_id", dojoId)
      .maybeSingle(),
    supabaseAdmin.from("dojos").select(DOJO_TRIAL_COLS).eq("id", dojoId).maybeSingle(),
  ]);
  if (!member || member.status !== "trial") return null;

  const timezone = (dojo as any)?.timezone || "UTC";
  const policy = trialPolicyFromDojo(dojo);
  const today = dojoTodayIso(timezone);

  // SIGNUP FREE PERIOD (per-gym `signup_free_days`, off by default). A rolling
  // window of N x 24 hours from the moment of signup — nothing to do with the
  // attendance clock — so the end instant is known exactly and never
  // provisional.
  const freeDays = Math.round(Number((dojo as any)?.signup_free_days ?? 0)) || 0;
  if (freeDays > 0) {
    const stored = member.free_trial_ends_at ? new Date(member.free_trial_ends_at) : null;
    const from = member.created_at ? new Date(member.created_at) : new Date();
    const anchor =
      stored && !Number.isNaN(stored.getTime())
        ? stored
        : new Date(from.getTime() + freeDays * 86400000);
    // Stripe counts the ACTUAL time between now and `trial_end` and rounds
    // down, so an end instant even seconds short of N x 24 hours is advertised
    // as "N-1 days free". Never hand Stripe less than the full window measured
    // from this moment.
    const floorUnix = Math.floor(Date.now() / 1000) + freeDays * 86400 + 300;
    // The floor belongs to the FIRST calculation only, where it stops Stripe
    // rounding a full window down to "N-1 days free". Re-applying it to a date
    // already stored turns a floor into a ratchet: this runs on every check-in,
    // so each class pushed the charge another N days out and a member training
    // regularly would never have been billed at all.
    //
    // Once a date is stored it IS the answer. The member has been told it and
    // Stripe holds it, so it does not move again.
    const unix =
      stored && !Number.isNaN(stored.getTime())
        ? Math.floor(stored.getTime() / 1000)
        : Math.max(Math.floor(anchor.getTime() / 1000), floorUnix);
    const date = dojoTodayIso(timezone, new Date(unix * 1000));
    // Keep the member record on the very instant handed to Stripe, so the
    // portal countdown and the charge date are literally the same number.
    const endsAtIso = new Date(unix * 1000).toISOString();
    if (!stored || Math.abs(stored.getTime() / 1000 - unix) > 60) {
      try {
        await supabaseAdmin
          .from("members")
          .update({ free_trial_ends_at: endsAtIso })
          .eq("id", memberId)
          .eq("dojo_id", dojoId);
      } catch (e) {
        console.error("free period end write-back failed", e);
      }
    }

    return {
      date,
      provisional: false,
      timezone,
      unix,
      message: `Nothing to pay today. Your ${freeDays} free days run until ${formatDay(date)}, when your first payment is taken.`,
    } as TrialDeferral;
  }


  let nextBooked: string | null = null;
  if (!member.trial_started_at) {
    const { data: bookings } = await supabaseAdmin
      .from("class_bookings")
      .select("booked_for_date")
      .eq("dojo_id", dojoId)
      .eq("member_id", memberId)
      .eq("status", "booked")
      .gte("booked_for_date", today)
      .order("booked_for_date", { ascending: true })
      .limit(1);
    nextBooked = (bookings ?? [])[0]?.booked_for_date
      ? String((bookings as any)[0].booked_for_date).slice(0, 10)
      : null;
  }

  const end = trialBillingEnd({
    policy,
    startDate: member.trial_started_at ?? null,
    nextBookedDate: nextBooked,
    today,
  });
  if (!end) return null;

  return {
    ...end,
    timezone,
    unix: endOfLocalDayUnix(end.date, timezone),
    message: end.provisional
      ? "Nothing to pay today. Your free trial starts at your first class, and your first payment is only taken once it has finished — we'll set the exact date then."
      : `Nothing to pay today. Your free trial runs to ${formatDay(end.date)}, and your first payment is taken after that.`,
  };
}

/**
 * Called after a trial member is checked in. If their trial clock has just
 * started, correct the live subscription's `trial_end` to their real trial end
 * date, so a provisional (deliberately generous) placeholder never charges
 * them at the wrong time.
 *
 * Best-effort: never let this block a check-in.
 */
export async function syncTrialEndAfterAttendance(args: {
  supabaseAdmin: any;
  dojoId: string;
  memberId: string;
}): Promise<void> {
  const { supabaseAdmin, dojoId, memberId } = args;
  if (!hasStripeSecret()) return;
  try {
    const deferral = await resolveTrialDeferral(supabaseAdmin, dojoId, memberId);
    // Only a known (non-provisional) trial end is worth writing to Stripe.
    if (!deferral || deferral.provisional) return;

    const { data: subs } = await supabaseAdmin
      .from("member_subscriptions")
      .select("id, stripe_subscription_id, status, trial_end")
      .eq("dojo_id", dojoId)
      .eq("member_id", memberId)
      .not("stripe_subscription_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(3);

    const sub = (subs ?? []).find((s: any) => s.status === "trialing");
    if (!sub?.stripe_subscription_id) return;

    const nextIso = new Date(deferral.unix * 1000).toISOString();
    if (sub.trial_end) {
      const currentUnix = new Date(sub.trial_end).getTime() / 1000;
      if (Math.abs(currentUnix - deferral.unix) < 60) return; // already correct
      // Never shorten a trial the member was already shown at checkout: the
      // provisional date they saw is a promise. Only move the end date out.
      if (deferral.unix < currentUnix) return;
    }

    const stripe = getPlatformStripe();
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      trial_end: deferral.unix,
      proration_behavior: "none",
    });
    await supabaseAdmin
      .from("member_subscriptions")
      .update({ trial_end: nextIso })
      .eq("id", sub.id);
  } catch (e) {
    console.error("syncTrialEndAfterAttendance failed", e);
  }
}
