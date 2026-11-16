import Stripe from "stripe";

const getEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is not configured`);
  return value;
};

export type StripeEnv = "sandbox" | "live";

/**
 * Pick the correct Stripe environment. Prefers live when the live secret
 * key is present AND we are running in a production build; falls back to sandbox
 * (which is what the preview / test flows always use).
 */
export function getStripeEnv(): StripeEnv {
  if (process.env.STRIPE_LIVE_API_KEY && process.env.NODE_ENV === "production") {
    return "live";
  }
  return "sandbox";
}

export function getConnectionApiKey(env: StripeEnv): string {
  return env === "sandbox"
    ? getEnv("STRIPE_SANDBOX_API_KEY")
    : getEnv("STRIPE_LIVE_API_KEY");
}

/**
 * Stripe SDK client for the selected environment. It calls api.stripe.com
 * directly and authenticates with the platform's own Stripe secret key for
 * that environment (STRIPE_SANDBOX_API_KEY or STRIPE_LIVE_API_KEY).
 */
export function createStripeClient(env: StripeEnv): Stripe {
  return new Stripe(getConnectionApiKey(env), {
    apiVersion: "2026-03-25.dahlia" as any,
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export function getStripeErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const err = error as {
      message?: string;
      type?: string;
      code?: string;
      decline_code?: string;
      param?: string;
      requestId?: string;
      raw?: {
        message?: string;
        type?: string;
        code?: string;
        decline_code?: string;
        param?: string;
        requestId?: string;
      };
    };
    const message = err.raw?.message ?? err.message;
    if (message) {
      const details = [
        err.raw?.type ?? err.type,
        err.raw?.code ?? err.code,
        err.raw?.decline_code ?? err.decline_code,
        err.raw?.param ?? err.param,
      ].filter(Boolean);
      return details.length ? `${message} (${details.join(", ")})` : message;
    }
  }
  return "Stripe request failed";
}

/**
 * Verify a Stripe webhook signature without depending on the Stripe SDK.
 * Uses HMAC-SHA256. Works in the Worker runtime.
 */
export async function verifyStripeWebhook(
  req: Request,
  env: StripeEnv,
): Promise<{ type: string; data: { object: any }; id: string }> {
  const signature = req.headers.get("stripe-signature");
  const body = await req.text();
  const secret =
    env === "sandbox"
      ? getEnv("PAYMENTS_SANDBOX_WEBHOOK_SECRET")
      : getEnv("PAYMENTS_LIVE_WEBHOOK_SECRET");

  if (!signature || !body) throw new Error("Missing signature or body");

  let timestamp: string | undefined;
  const v1Signatures: string[] = [];
  for (const part of signature.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key === "t") timestamp = value;
    if (key === "v1") v1Signatures.push(value);
  }
  if (!timestamp || v1Signatures.length === 0) throw new Error("Invalid signature format");

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
  if (!v1Signatures.some((sig) => timingSafeEqualHex(sig, expected))) {
    throw new Error("Invalid webhook signature");
  }
  return JSON.parse(body);
}

/**
 * Unix timestamp (seconds) of 00:00 UTC on the 1st of the next month.
 * Used as the Stripe subscription billing_cycle_anchor so all members
 * renew on the 1st, with a pro-rated first invoice for the partial period.
 */
export function firstOfNextMonthUnix(now: Date = new Date()): number {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
  return Math.floor(d.getTime() / 1000);
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
