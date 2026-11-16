import Stripe from "stripe";
import { SITE_URL } from "@/lib/site";
import { envOptional } from "@/lib/env";

/**
 * BYOK Stripe Connect client — uses the platform's own STRIPE_SECRET_KEY
 * directly against api.stripe.com. Used for member-dues charges routed to
 * each gym's connected (Express) Stripe account with an application fee.
 *
 * The gateway-based `createStripeClient` in `stripe.server.ts` is used
 * only for platform SaaS billing (the platform is Merchant of Record).
 */

let _client: Stripe | null = null;

/** Pinned Stripe API version. Typed as string: the SDK's literal union does not include it. */
const STRIPE_API_VERSION: string = "2026-03-25.dahlia";

export function hasStripeSecret(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

export function getPlatformStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Stripe not configured");
  if (!_client) {
    _client = new Stripe(key, { apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion });
  }
  return _client;
}

/** The fields read from a thrown Stripe error (`raw` holds the API body). */
type StripeErrorLike = {
  raw?: { message?: string; code?: string };
  message?: string;
  code?: string;
};

/** The period-end fields read from a subscription: item first, then subscription. */
type PeriodEndSource =
  | {
      items?: { data?: { current_period_end?: number | string | null }[] };
      current_period_end?: number | string | null;
    }
  | null
  | undefined;

/** Platform fee we take on each member-dues charge, in percent. */
export {
  PLATFORM_FEE_PERCENT,
  grossChargeCents,
  platformFeeCents,
  stripeFeeCents,
  subscriptionAppFeePercent,
  totalAppFeeCents,
} from "@/lib/platform-fee";
import { PLATFORM_FEE_PERCENT } from "@/lib/platform-fee";

/** First-of-next-month unix timestamp for `billing_cycle_anchor`. */
export function firstOfNextMonthUnix(now: Date = new Date()): number {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
  return Math.floor(d.getTime() / 1000);
}

/* ---------------------------------------------------------------------------
 * Billing-cycle planning
 * -------------------------------------------------------------------------
 * Monthly dues anchor to the gym's configured billing day (1-28, capped so it
 * is always valid in February) computed in the gym's own timezone. ANNUAL
 * plans are never anchored: they charge in full on the signup date and renew
 * on that same date next year, with no proration line.
 * ------------------------------------------------------------------------- */

/** Clamp a configured billing day to a value valid in every month. */
export function normalizeBillingDay(day: unknown): number {
  const n = Number(day);
  if (!Number.isFinite(n)) return 1;
  return Math.min(28, Math.max(1, Math.round(n)));
}

function tzOffsetMs(timeZone: string, at: Date): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const p: Record<string, string> = {};
    for (const part of fmt.formatToParts(at)) p[part.type] = part.value;
    const asUtc = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour === "24" ? "0" : p.hour),
      Number(p.minute),
      Number(p.second),
    );
    return asUtc - at.getTime();
  } catch {
    return 0;
  }
}

/** Local calendar parts for `at` in `timeZone`. */
function zonedParts(timeZone: string, at: Date): { y: number; m: number; d: number } {
  const shifted = new Date(at.getTime() + tzOffsetMs(timeZone, at));
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
  };
}

/** Unix seconds for local midnight of y-m-d in `timeZone`. */
function zonedMidnightUnix(timeZone: string, y: number, m: number, d: number): number {
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0);
  let ms = naive - tzOffsetMs(timeZone, new Date(naive));
  // Refine once for DST boundaries.
  ms = naive - tzOffsetMs(timeZone, new Date(ms));
  return Math.floor(ms / 1000);
}

/**
 * Next occurrence of the gym's billing day at local midnight, strictly in the
 * future relative to `now`.
 */
export function monthlyAnchorUnix(
  billingDay: unknown,
  timeZone: string = "UTC",
  now: Date = new Date(),
): number {
  const day = normalizeBillingDay(billingDay);
  const tz = timeZone || "UTC";
  const { y, m } = zonedParts(tz, now);
  let candidate = zonedMidnightUnix(tz, y, m, day);
  if (candidate <= Math.floor(now.getTime() / 1000)) {
    const nextMonth = m === 12 ? 1 : m + 1;
    const nextYear = m === 12 ? y + 1 : y;
    candidate = zonedMidnightUnix(tz, nextYear, nextMonth, day);
  }
  return candidate;
}

/**
 * Unix seconds for the END of a gym-local calendar day (23:59:59 local), used
 * for Stripe `trial_end` so a trial member is never charged before the last
 * day of their trial is fully over.
 *
 * Stripe requires a Checkout `trial_end` at least 48 hours in the future, so
 * the value is clamped forward when the date is very close. Clamping can only
 * ever push the charge LATER, never earlier.
 */
export function endOfLocalDayUnix(
  dateIso: string,
  timeZone: string = "UTC",
  now: Date = new Date(),
): number {
  const [y, m, d] = dateIso.slice(0, 10).split("-").map(Number);
  const nextDay = new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + 1));
  const end =
    zonedMidnightUnix(
      timeZone || "UTC",
      nextDay.getUTCFullYear(),
      nextDay.getUTCMonth() + 1,
      nextDay.getUTCDate(),
    ) - 1;
  const minimum = Math.floor(now.getTime() / 1000) + 49 * 3600;
  return Math.max(end, minimum);
}

/**
 * Stripe's minimum chargeable amount per currency, in minor units.
 * https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts
 */
const STRIPE_MIN_CHARGE_CENTS: Record<string, number> = {
  usd: 50,
  eur: 50,
  gbp: 30,
  aud: 50,
  cad: 50,
  chf: 50,
  dkk: 250,
  nok: 300,
  sek: 300,
  nzd: 50,
  jpy: 50,
  hkd: 400,
  sgd: 50,
  mxn: 1000,
  brl: 50,
  pln: 200,
  czk: 1500,
  huf: 17500,
  ron: 200,
  bgn: 100,
  aed: 200,
  inr: 50,
};

export function minChargeCents(currency: string): number {
  return STRIPE_MIN_CHARGE_CENTS[(currency ?? "usd").toLowerCase()] ?? 50;
}

export type SubscriptionBillingPlan = {
  /** Present only for monthly plans. */
  billingCycleAnchor?: number;
  prorationBehavior: "create_prorations" | "none";
  /** Estimated proration in minor units (0 when there is none). */
  estimatedProrationCents: number;
  /** True when we deliberately dropped a below-minimum proration. */
  skippedTinyProration: boolean;
};

/** Per-gym billing mode. `fixed_day` is the default for every gym. */
export type BillingMode = "fixed_day" | "anniversary";

export function billingModeFromDojo(dojo: unknown): BillingMode {
  const raw = (dojo as Record<string, unknown> | null)?.["billing_mode"];
  return raw === "anniversary" ? "anniversary" : "fixed_day";
}

/**
 * Decide the anchor + proration behaviour for a dues subscription.
 *
 * - `anniversary` mode: no anchor and no proration in any interval — the full
 *   plan price is charged at signup and renews on that same date.
 * - `year`: no anchor, no proration — full annual charge today, renewing on
 *   the same date next year.
 * - `month` in `fixed_day` mode: anchor to the gym's billing day in its
 *   timezone. The stub-period proration is skipped entirely when it would land
 *   below Stripe's minimum charge for the currency (Stripe would otherwise
 *   reject the invoice), so the member simply starts on the next full cycle.
 */
export function planSubscriptionBilling(args: {
  interval: string;
  grossCents: number;
  currency: string;
  billingDay?: unknown;
  timezone?: string;
  billingMode?: BillingMode;
  now?: Date;
}): SubscriptionBillingPlan {
  const now = args.now ?? new Date();
  if (args.interval !== "month" || args.billingMode === "anniversary") {
    // Annual plans, and every plan at an anniversary-billing gym, anchor to
    // the signup date: full price now, renewing on that date.
    return {
      prorationBehavior: "none",
      estimatedProrationCents: 0,
      skippedTinyProration: false,
    };
  }

  const anchor = monthlyAnchorUnix(args.billingDay, args.timezone ?? "UTC", now);
  const nowSec = Math.floor(now.getTime() / 1000);
  const DAY = 86400;
  const daysToAnchor = Math.max(0, (anchor - nowSec) / DAY);
  // Length of the cycle the stub sits inside — approximate with the month
  // preceding the anchor, which is what Stripe prorates against.
  const cycleDays = 30;
  const estimated = Math.round((args.grossCents * Math.min(daysToAnchor, cycleDays)) / cycleDays);
  const minimum = minChargeCents(args.currency);
  if (estimated > 0 && estimated < minimum) {
    return {
      billingCycleAnchor: anchor,
      prorationBehavior: "none",
      estimatedProrationCents: 0,
      skippedTinyProration: true,
    };
  }
  return {
    billingCycleAnchor: anchor,
    prorationBehavior: estimated > 0 ? "create_prorations" : "none",
    estimatedProrationCents: estimated,
    skippedTinyProration: false,
  };
}

export function getConnectErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const err = error as StripeErrorLike;
    const msg = err.raw?.message ?? err.message;
    if (msg) return msg;
  }
  return "Stripe request failed";
}

/* ---------------------------------------------------------------------------
 * Member-dues subscriptions live on the PLATFORM account
 * -------------------------------------------------------------------------
 * Dues are created with destination charges (`transfer_data.destination` +
 * `on_behalf_of`) and NO `{ stripeAccount }` header, so the Subscription,
 * Customer and Invoice objects all belong to the platform account — not to
 * the gym's connected account. Every mutation must therefore also run on the
 * platform account. Use this helper everywhere so scoping can never drift:
 * it deliberately returns `undefined`.
 * ------------------------------------------------------------------------- */
export function duesRequestOptions(): Stripe.RequestOptions | undefined {
  return undefined;
}

/** Period end of a subscription, dahlia-safe (item first, then subscription). */
export function subscriptionPeriodEnd(sub: PeriodEndSource): string | null {
  const raw = sub?.items?.data?.[0]?.current_period_end ?? sub?.current_period_end ?? null;
  return raw ? new Date(Number(raw) * 1000).toISOString() : null;
}

export type DuesSubscriptionState =
  | { present: false }
  | {
      present: true;
      status: string;
      cancelAtPeriodEnd: boolean;
      currentPeriodEnd: string | null;
    };

/** Retrieve a dues subscription on the platform account. Never throws for 404. */
export async function getDuesSubscription(
  stripe: Stripe,
  subscriptionId: string,
): Promise<DuesSubscriptionState> {
  try {
    const sub = await stripe.subscriptions.retrieve(
      subscriptionId,
      undefined,
      duesRequestOptions(),
    );
    return {
      present: true,
      status: sub.status,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      currentPeriodEnd: subscriptionPeriodEnd(sub),
    };
  } catch (err: unknown) {
    const stripeErr = err as StripeErrorLike | null | undefined;
    const code = stripeErr?.raw?.code ?? stripeErr?.code;
    if (code === "resource_missing") return { present: false };
    throw err;
  }
}

export type DuesCancelOutcome = {
  /** True when Stripe confirmed the subscription is ended / ending. */
  verified: true;
  /** False when the subscription genuinely does not exist in Stripe. */
  existed: boolean;
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
};

/**
 * Cancel a member-dues subscription on the PLATFORM account and VERIFY the
 * result before the caller writes any local state.
 *
 * - `resource_missing` is never treated as success blindly: we re-retrieve on
 *   the platform account and only accept absence when Stripe confirms it.
 * - After a successful mutation we re-fetch and assert the subscription is
 *   canceled (immediate) or `cancel_at_period_end === true` (period end).
 * - Anything else throws, so local status stays untouched.
 */
export async function cancelDuesSubscription(
  stripe: Stripe,
  subscriptionId: string,
  mode: "immediate" | "period_end" = "immediate",
): Promise<DuesCancelOutcome> {
  const opts = duesRequestOptions();
  try {
    if (mode === "immediate") {
      await stripe.subscriptions.cancel(subscriptionId, undefined, opts);
    } else {
      await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true }, opts);
    }
  } catch (err: unknown) {
    const stripeErr = err as StripeErrorLike | null | undefined;
    const code = stripeErr?.raw?.code ?? stripeErr?.code;
    if (code !== "resource_missing") {
      throw new Error(
        `Stripe would not stop this subscription, so nothing was changed: ${getConnectErrorMessage(err)}`,
      );
    }
    // Re-verify on the platform account before believing it's gone.
    const state = await getDuesSubscription(stripe, subscriptionId);
    if (!state.present) {
      return {
        verified: true,
        existed: false,
        status: "canceled",
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
      };
    }
    if (state.status === "canceled") {
      return { verified: true, existed: true, ...pick(state) };
    }
    throw new Error(
      "Stripe reported this subscription as missing, but it is still live on the platform account. Nothing was changed — resolve this in Stripe before retrying.",
    );
  }

  // Verify the mutation actually landed.
  const after = await getDuesSubscription(stripe, subscriptionId);
  if (!after.present) {
    return {
      verified: true,
      existed: true,
      status: "canceled",
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
    };
  }
  const ok =
    mode === "immediate"
      ? after.status === "canceled"
      : after.cancelAtPeriodEnd || after.status === "canceled";
  if (!ok) {
    throw new Error(
      `Stripe accepted the request but the subscription is still ${after.status} and not set to cancel. Nothing was changed locally.`,
    );
  }
  return { verified: true, existed: true, ...pick(after) };
}

function pick(state: Extract<DuesSubscriptionState, { present: true }>) {
  return {
    status: state.status,
    cancelAtPeriodEnd: state.cancelAtPeriodEnd,
    currentPeriodEnd: state.currentPeriodEnd,
  };
}

/** True when Stripe confirms this subscription is no longer billing. */
export async function isDuesSubscriptionEnded(
  stripe: Stripe,
  subscriptionId: string,
): Promise<boolean> {
  const state = await getDuesSubscription(stripe, subscriptionId);
  return !state.present || state.status === "canceled";
}

/**
 * Verify a Stripe webhook signature (HMAC-SHA256) without depending on the
 * Stripe SDK's crypto module. Reads STRIPE_WEBHOOK_SECRET.
 */
export async function verifyConnectWebhook(req: Request): Promise<{
  type: string;
  data: { object: Record<string, unknown> };
  id: string;
  account?: string;
}> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET not configured");
  const signature = req.headers.get("stripe-signature");
  const body = await req.text();
  if (!signature || !body) throw new Error("Missing signature or body");

  let timestamp: string | undefined;
  const v1: string[] = [];
  for (const part of signature.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === "t") timestamp = v;
    if (k === "v1") v1.push(v);
  }
  if (!timestamp || v1.length === 0) throw new Error("Invalid signature format");
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > 300) throw new Error("Webhook timestamp too old");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  const expected = Buffer.from(new Uint8Array(signed)).toString("hex");
  // Constant-time comparison so a timing side-channel cannot be used to
  // forge a signature byte by byte.
  if (!v1.some((sig) => timingSafeEqualHex(sig, expected))) {
    throw new Error("Invalid webhook signature");
  }
  return JSON.parse(body);
}

export function getOrigin(): string {
  const env = envOptional(process.env.APP_URL) ?? envOptional(process.env.SITE_URL);
  if (env) return env.replace(/\/$/, "");
  return SITE_URL;
}

/**
 * Stripe rejects `proration_behavior` unless a `billing_cycle_anchor` is also
 * set. Build the subscription_data billing fields from a billing plan so both
 * checkout paths (member self-signup and admin-initiated payment link) send an
 * identical, valid combination.
 */
export function subscriptionBillingParams(billing: SubscriptionBillingPlan): {
  billing_cycle_anchor?: number;
  proration_behavior?: "create_prorations" | "none";
} {
  if (!billing.billingCycleAnchor) return {};
  return {
    billing_cycle_anchor: billing.billingCycleAnchor,
    proration_behavior: billing.prorationBehavior,
  };
}

/** Constant-time hex-string comparison (length-guarded). */
// Constant-time string compare. Implemented in pure JS rather than
// node:crypto's timingSafeEqual so this module never pulls a Node built-in
// into a bundle.
function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
