// Abuse protection for the UNAUTHENTICATED public endpoints (member signup and
// first-class booking). Every attempt is recorded in
// public.public_request_attempts with hashed identifiers, so the ledger itself
// never becomes a store of raw IPs or emails.
//
// Limits are deliberately generous for a genuine person filling in one form and
// tight enough that a script cannot flood a gym's roster.

import { getRequest } from "@tanstack/react-start/server";

export type PublicEndpoint = "signup" | "book_class";

const LIMITS = {
  ipPerHour: 8,
  ipPerDay: 20,
  emailPerHour: 3,
  emailPerDay: 5,
  dojoSignupsPerDay: 25,
} as const;

const TOO_MANY =
  "Too many attempts — please try again shortly. If you think this is a mistake, contact the gym directly.";
const CEILING =
  "This gym has reached today's signup limit. Please contact the gym directly and they'll get you set up.";

/** Best-effort client IP from the edge headers. Returns null when unavailable. */
export function clientIp(): string | null {
  try {
    const h = getRequest().headers;
    const cf = h.get("cf-connecting-ip");
    if (cf) return cf.trim();
    const fwd = h.get("x-forwarded-for");
    if (fwd) return fwd.split(",")[0]!.trim() || null;
    const real = h.get("x-real-ip");
    return real?.trim() || null;
  } catch {
    return null;
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function since(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

async function countAttempts(
  supabaseAdmin: any,
  filters: { ipHash?: string; emailHash?: string; dojoId?: string; endpoint?: PublicEndpoint },
  hours: number,
): Promise<number> {
  let q = supabaseAdmin
    .from("public_request_attempts")
    .select("id", { count: "exact", head: true })
    .gte("created_at", since(hours));
  if (filters.ipHash) q = q.eq("ip_hash", filters.ipHash);
  if (filters.emailHash) q = q.eq("email_hash", filters.emailHash);
  if (filters.dojoId) q = q.eq("dojo_id", filters.dojoId);
  if (filters.endpoint) q = q.eq("endpoint", filters.endpoint);
  const { count, error } = await q;
  // Fail open on infrastructure errors: a broken ledger must never stop a
  // genuine signup, and the other limits still apply.
  if (error) return 0;
  return count ?? 0;
}

async function record(
  supabaseAdmin: any,
  row: {
    dojoId: string | null;
    endpoint: PublicEndpoint | "ceiling_alert";
    ipHash: string | null;
    emailHash: string | null;
    outcome: "allowed" | "blocked";
  },
): Promise<void> {
  try {
    await supabaseAdmin.from("public_request_attempts").insert({
      dojo_id: row.dojoId,
      endpoint: row.endpoint,
      ip_hash: row.ipHash,
      email_hash: row.emailHash,
      outcome: row.outcome,
    });
  } catch {
    // Never let ledger writes break the request path.
  }
}

/**
 * Throw a user-facing error when the caller is over any limit, otherwise record
 * the attempt and return. Always call this BEFORE creating members, auth users
 * or Stripe customers.
 */
export async function enforceRateLimit(args: {
  endpoint: PublicEndpoint;
  dojoId: string;
  email?: string | null;
}): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const ip = clientIp();
  const ipHash = ip ? await sha256(ip) : null;
  const email = args.email?.trim().toLowerCase() || null;
  const emailHash = email ? await sha256(email) : null;

  const deny = async (message: string) => {
    await record(supabaseAdmin, {
      dojoId: args.dojoId,
      endpoint: args.endpoint,
      ipHash,
      emailHash,
      outcome: "blocked",
    });
    throw new Error(message);
  };

  if (ipHash) {
    const [hour, day] = await Promise.all([
      countAttempts(supabaseAdmin, { ipHash }, 1),
      countAttempts(supabaseAdmin, { ipHash }, 24),
    ]);
    if (hour >= LIMITS.ipPerHour || day >= LIMITS.ipPerDay) await deny(TOO_MANY);
  }

  if (emailHash) {
    const [hour, day] = await Promise.all([
      countAttempts(supabaseAdmin, { emailHash }, 1),
      countAttempts(supabaseAdmin, { emailHash }, 24),
    ]);
    if (hour >= LIMITS.emailPerHour || day >= LIMITS.emailPerDay) await deny(TOO_MANY);
  }

  if (args.endpoint === "signup") {
    const dojoDay = await countAttempts(
      supabaseAdmin,
      { dojoId: args.dojoId, endpoint: "signup" },
      24,
    );
    if (dojoDay >= LIMITS.dojoSignupsPerDay) {
      await alertStaffOnce(supabaseAdmin, args.dojoId, dojoDay);
      await deny(CEILING);
    }
  }

  await record(supabaseAdmin, {
    dojoId: args.dojoId,
    endpoint: args.endpoint,
    ipHash,
    emailHash,
    outcome: "allowed",
  });
}

/** True when this gym has already tripped today's signup ceiling. */
export async function dojoSignupCeilingHit(dojoId: string): Promise<boolean> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const count = await countAttempts(supabaseAdmin, { dojoId, endpoint: "signup" }, 24);
  return count >= LIMITS.dojoSignupsPerDay;
}

export const DAILY_SIGNUP_CEILING = LIMITS.dojoSignupsPerDay;

/** One alert per gym per day, deduped through the same ledger. */
async function alertStaffOnce(
  supabaseAdmin: any,
  dojoId: string,
  attempts: number,
): Promise<void> {
  const alreadySent = await countAttempts(
    supabaseAdmin,
    { dojoId, endpoint: "ceiling_alert" as PublicEndpoint },
    24,
  );
  if (alreadySent > 0) return;
  await record(supabaseAdmin, {
    dojoId,
    endpoint: "ceiling_alert",
    ipHash: null,
    emailHash: null,
    outcome: "blocked",
  });

  try {
    const { data: dojo } = await supabaseAdmin
      .from("dojos")
      .select("name, contact_email")
      .eq("id", dojoId)
      .maybeSingle();
    const to = dojo?.contact_email;
    if (!to) return;
    const { sendAppEmail } = await import("@/lib/email-send.server");
    await sendAppEmail({
      dojoId,
      to,
      subject: "Unusual signup activity on your public signup page",
      html: `<p>Hi ${dojo?.name ?? "there"},</p>
<p>Your public signup page received <strong>${attempts}</strong> signup attempts in the last 24 hours, which is above the safety limit of ${LIMITS.dojoSignupsPerDay}.</p>
<p>Further signups are being turned away for the rest of the day to protect your member list. If you're running a launch or an open day and expect this volume, reply to this email and we'll raise your limit.</p>`,
      templateName: "signup-ceiling-alert",
      idempotencyKey: `ceiling:${new Date().toISOString().slice(0, 10)}`,
      supabase: supabaseAdmin,
    });
  } catch {
    // Alerting is best effort; the block itself already happened.
  }
}

/**
 * Cloudflare Turnstile verification. Returns true when the token is valid, or
 * when Turnstile is not configured yet (rate limiting still applies, so
 * behaviour is never worse than before this was added).
 */
export async function verifyTurnstile(token: string | null | undefined): Promise<boolean> {
  const secret = process.env["TURNSTILE_SECRET_KEY"];
  if (!secret) return true;
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    const ip = clientIp();
    if (ip) body.set("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await res.json()) as { success?: boolean };
    return !!json.success;
  } catch {
    // Cloudflare unreachable — don't lock genuine members out; limits apply.
    return true;
  }
}

export const BOT_CHECK_FAILED =
  "We couldn't verify that you're human. Please refresh the page and try again.";

/**
 * Password-reset requests. Returns false when the caller is over the limit —
 * the caller must still show the SAME confirmation message, it just skips the
 * send. Limits mirror the public signup protection (per email, per IP).
 */
export async function enforceResetRateLimit(email: string): Promise<boolean> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const endpoint = "password_reset" as PublicEndpoint;

  const ip = clientIp();
  const ipHash = ip ? await sha256(ip) : null;
  const normalised = email.trim().toLowerCase();
  const emailHash = normalised ? await sha256(normalised) : null;

  const blocked = async () => {
    await record(supabaseAdmin, {
      dojoId: null,
      endpoint,
      ipHash,
      emailHash,
      outcome: "blocked",
    });
    return false;
  };

  if (emailHash) {
    const [hour, day] = await Promise.all([
      countAttempts(supabaseAdmin, { emailHash, endpoint }, 1),
      countAttempts(supabaseAdmin, { emailHash, endpoint }, 24),
    ]);
    if (hour >= 3 || day >= 6) return blocked();
  }

  if (ipHash) {
    const [hour, day] = await Promise.all([
      countAttempts(supabaseAdmin, { ipHash, endpoint }, 1),
      countAttempts(supabaseAdmin, { ipHash, endpoint }, 24),
    ]);
    if (hour >= 10 || day >= 25) return blocked();
  }

  await record(supabaseAdmin, {
    dojoId: null,
    endpoint,
    ipHash,
    emailHash,
    outcome: "allowed",
  });
  return true;
}
