import type { SupabaseClient } from "@supabase/supabase-js";
import { isDomainNotVerified, sendEmail } from "./email-provider.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { PUBLIC_SITE_URL } from "./site";
import { normaliseDomain, resolveFromLocalPart } from "./email-sender-identity.ts";

/** Body of a Google DNS-over-HTTPS (`dns.google/resolve`) response. */
type DnsJsonResponse = { Answer?: { data?: unknown }[] };

/** The fields read from a thrown provider error. */
type ProviderError = { status?: unknown; message?: unknown };

/**
 * Single verified platform sending domain. Every email leaves from this
 * address, but the From *name* and Reply-To are the gym's, so members see
 * their own dojo in the inbox and replies go to the gym.
 *
 * The address is DERIVED from the configured sending domain — never
 * string-built by appending a subdomain, which previously produced the
 * doubled "notify@notify.sthenos.live".
 */
export const SENDING_DOMAIN = normaliseDomain(process.env.EMAIL_SENDING_DOMAIN, PUBLIC_SITE_URL);
/** Local part of the platform sender. */
export const FROM_LOCAL_PART = resolveFromLocalPart(process.env.EMAIL_SENDING_LOCAL_PART);
export const FROM_ADDRESS = `${FROM_LOCAL_PART}@${SENDING_DOMAIN}`;

export type SendingStatus = {
  verified: boolean;
  domain: string;
  fromAddress: string;
  /** True when we can still try the provider (verification status unknown). */
  canAttempt: boolean;
  reason: string | null;
};

let statusCache: { at: number; status: SendingStatus } | null = null;
const CACHE_MS = 5 * 60_000;

function apiKey(): string | undefined {
  return process.env.RESEND_API_KEY;
}

/**
 * Live DNS check of the managed sending domain. The email domain is delegated
 * to the platform nameservers, so once verification completes the SPF/MX
 * records resolve — that's the real, current source of truth rather than a
 * stale stored flag.
 */
async function dnsLooksVerified(domain: string): Promise<boolean | null> {
  async function lookup(type: "MX" | "TXT"): Promise<string[] | null> {
    try {
      const res = await fetch(
        `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${type}`,
        { headers: { accept: "application/dns-json" } },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as DnsJsonResponse;
      const answers = Array.isArray(body?.Answer) ? body.Answer : [];
      return answers.map((a) => String(a?.data ?? ""));
    } catch {
      return null;
    }
  }

  const [mx, txt] = await Promise.all([lookup("MX"), lookup("TXT")]);
  if (mx === null && txt === null) return null; // couldn't check
  const hasMx = (mx ?? []).length > 0;
  const hasSpf = (txt ?? []).some((v) => v.toLowerCase().includes("v=spf1"));
  return hasMx && hasSpf;
}

/**
 * Is the sending domain actually verified with the provider right now?
 * Cached briefly so sending flips on automatically the moment verification
 * completes, without hammering DNS.
 */
export async function getSendingStatus(force = false): Promise<SendingStatus> {
  if (!force && statusCache && Date.now() - statusCache.at < CACHE_MS) return statusCache.status;

  const base: Omit<SendingStatus, "verified" | "canAttempt" | "reason"> = {
    domain: SENDING_DOMAIN,
    fromAddress: FROM_ADDRESS,
  };
  let status: SendingStatus;

  if (!apiKey()) {
    status = {
      ...base,
      verified: false,
      canAttempt: false,
      reason: "Email provider is not connected yet.",
    };
  } else if (process.env.EMAIL_SENDING_VERIFIED === "true") {
    status = { ...base, verified: true, canAttempt: true, reason: null };
  } else {
    const dns = await dnsLooksVerified(SENDING_DOMAIN);
    if (dns === true) {
      status = { ...base, verified: true, canAttempt: true, reason: null };
    } else if (dns === false) {
      status = {
        ...base,
        verified: false,
        canAttempt: true,
        reason: "Pending domain verification.",
      };
    } else {
      // Couldn't check right now — still attempt, and let the provider be the
      // source of truth.
      status = {
        ...base,
        verified: false,
        canAttempt: true,
        reason: "Awaiting domain verification confirmation.",
      };
    }
  }

  statusCache = { at: Date.now(), status };
  return status;
}

function setStatus(patch: Partial<SendingStatus>) {
  const current = statusCache?.status ?? {
    domain: SENDING_DOMAIN,
    fromAddress: FROM_ADDRESS,
    verified: false,
    canAttempt: true,
    reason: null,
  };
  statusCache = { at: Date.now(), status: { ...current, ...patch } };
}

export { isDomainNotVerified };

/** Plain-text fallback body, required by the email API. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type SenderIdentity = {
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
};

/**
 * Legacy placeholder values that were seeded before real sending existed.
 * They are treated as "not set" so the real defaults win.
 */
const PLACEHOLDER_NAMES = ["your dojo", "your gym", "dojo connect", "xalarosi"];
const PLACEHOLDER_ADDRESSES = [
  "onboarding@resend.dev",
  "you@yourgym.com",
  "notify@notify.sthenos.live",
];

function explicitName(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  return PLACEHOLDER_NAMES.includes(v.toLowerCase()) ? null : v;
}

function explicitAddress(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  const lower = v.toLowerCase();
  if (PLACEHOLDER_ADDRESSES.includes(lower)) return null;
  if (lower.endsWith("@resend.dev") || lower.endsWith(`@${SENDING_DOMAIN}`)) return null;
  return v;
}

/**
 * Gym-specific From name + Reply-To.
 * Defaults: the dojo's own name, and the gym OWNER's account email. A stored
 * value only wins when the owner explicitly set one (placeholders ignored).
 */
export async function resolveSenderIdentity(
  supabase: SupabaseClient<Database>,
  dojoId: string,
): Promise<SenderIdentity> {
  const [{ data: settings }, { data: dojo }] = await Promise.all([
    supabase
      .from("email_settings")
      .select("from_name, from_address")
      .eq("dojo_id", dojoId)
      .maybeSingle(),
    supabase
      .from("dojos")
      .select("name, contact_email, owner_user_id")
      .eq("id", dojoId)
      .maybeSingle(),
  ]);

  // The owner's auth account email is the default reply-to.
  let ownerEmail: string | null = null;
  if (dojo?.owner_user_id) {
    const { data: prof } = await supabaseAdmin
      .from("profiles")
      .select("email")
      .eq("user_id", dojo.owner_user_id)
      .maybeSingle();
    ownerEmail = explicitAddress(prof?.email);
    if (!ownerEmail) {
      const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(dojo.owner_user_id);
      ownerEmail = explicitAddress(authUser?.user?.email ?? null);
    }
  }
  if (!ownerEmail) ownerEmail = explicitAddress(dojo?.contact_email);

  return {
    fromName: explicitName(settings?.from_name) || dojo?.name?.trim() || "Your gym",
    fromAddress: FROM_ADDRESS,
    replyTo: explicitAddress(settings?.from_address) || ownerEmail || null,
  };
}

/**
 * Every recipient gets a durable unsubscribe token. The provider REQUIRES an
 * unsubscribe_token on transactional mail as well as marketing, so the token is
 * always resolved — only the visible footer differs by category.
 *
 * The token is DURABLE and is reused regardless of used_at: there is exactly one
 * row per address (unique on email), so once a recipient has unsubscribed their
 * only token is marked used. Refusing to reuse it would make it impossible to
 * mint a token for them, and therefore impossible to send them any email at all
 * — including the service messages an unsubscribed member must still receive.
 * Suppression, not token state, decides whether marketing is blocked.
 */
async function unsubscribeFor(email: string): Promise<{ token: string; url: string }> {
  const lower = email.trim().toLowerCase();
  const pick = async (): Promise<string | null> => {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const { data, error } = await supabaseAdmin
        .from("email_unsubscribe_tokens")
        .select("token")
        .eq("email", lower)
        .limit(1)
        .maybeSingle();
      if (!error) return (data?.token as string | undefined) ?? null;

      lastError = new Error(error.message);
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 50));
      }
    }

    // A failed lookup is not evidence that the row is absent. In particular,
    // never turn a transient read failure into an INSERT against the unique
    // email constraint. sendAppEmail catches this and records the exact failure.
    throw lastError ?? new Error("Unsubscribe token lookup failed");
  };

  let token = await pick();
  if (!token) {
    const candidate = crypto.randomUUID().replace(/-/g, "");
    const { error } = await supabaseAdmin
      .from("email_unsubscribe_tokens")
      .insert({ token: candidate, email: lower });
    if (error) {
      // Raced with a concurrent send, or the row already exists — reuse it,
      // used or not. Retry the authoritative lookup; this must never be
      // filtered by used_at or interpret a lookup error as an absent row.
      token = await pick();
      if (!token) {
        throw new Error(`Unsubscribe token creation failed: ${error.message}`);
      }
    } else {
      token = candidate;
    }
  }
  return { token, url: `${PUBLIC_SITE_URL}/unsubscribe?token=${token}` };
}

async function logSend(row: {
  messageId: string | null;
  templateName: string;
  recipient: string;
  status: "sent" | "failed" | "pending" | "suppressed";
  error?: string | null;
  metadata?: Record<string, unknown>;
}) {
  try {
    await supabaseAdmin.from("email_send_log").insert({
      message_id: row.messageId,
      template_name: row.templateName,
      recipient_email: row.recipient,
      status: row.status,
      error_message: row.error ?? null,
      metadata: (row.metadata ?? {}) as Json,
    });
  } catch {
    // Logging must never break a send.
  }
}

export type SendResult =
  | { ok: true; providerId: string | null }
  | {
      ok: false;
      pending: boolean;
      error: string;
      /** The recipient opted out / bounced, so nothing was sent. Never retry. */
      suppressed?: boolean;
      /** Handed to the retry queue — a later cycle will try again. */
      queued?: boolean;
    };

export const PENDING_MESSAGE = "Email pending domain verification";

/**
 * SUPPRESSION POLICY — deliberate, not accidental.
 *
 * `suppressed_emails.reason` distinguishes WHY an address is on the list:
 *
 *  - "unsubscribe"  the person opted out of MARKETING. Marketing is blocked
 *                   absolutely. Service messages the member has a legitimate
 *                   interest in (password reset, receipts, failed-payment
 *                   notices, cancellation confirmations) are STILL sent: an
 *                   opt-out under GDPR/PECR covers direct marketing, not the
 *                   operation of a contract the member is party to. Members
 *                   cannot silently opt out of being told their card failed.
 *  - "bounce" / "complaint" / anything else
 *                   the address is undeliverable or the recipient reported us
 *                   as spam. NOTHING is sent, transactional included, because
 *                   continuing to send damages deliverability for every gym on
 *                   the platform and the mail cannot arrive anyway.
 *
 * Every skip is logged with status "suppressed" so staff can see in
 * Settings -> Email exactly why a member is not receiving mail.
 */
const MARKETING_ONLY_SUPPRESSION_REASONS = new Set(["unsubscribe", "unsubscribed", "opt_out"]);

export async function suppressionFor(
  email: string,
): Promise<{ reason: string; blocksTransactional: boolean } | null> {
  const lower = email.trim().toLowerCase();
  if (!lower) return null;
  const { data } = await supabaseAdmin
    .from("suppressed_emails")
    .select("reason, created_at")
    .ilike("email", lower)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const reason = String(data.reason ?? "unknown").toLowerCase();
  return { reason, blocksTransactional: !MARKETING_ONLY_SUPPRESSION_REASONS.has(reason) };
}

/**
 * Transient failures are worth retrying (the message will eventually land);
 * permanent ones are not (retrying just burns quota and reputation).
 */
function isTransient(statusCode: number | null, message: string): boolean {
  if (statusCode === 429) return true;
  if (statusCode !== null && statusCode >= 500) return true;
  if (statusCode !== null) return false; // 4xx: bad request / invalid address / auth
  const m = message.toLowerCase();
  return (
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("network") ||
    m.includes("fetch failed") ||
    m.includes("econn") ||
    m.includes("socket")
  );
}

/** Is the platform inside a provider-imposed rate-limit cooldown right now? */
async function inRateLimitCooldown(): Promise<boolean> {
  try {
    const { data } = await supabaseAdmin
      .from("email_send_state")
      .select("retry_after_until")
      .limit(1)
      .maybeSingle();
    const until = data?.retry_after_until;
    return !!until && new Date(until) > new Date();
  } catch {
    return false;
  }
}

/**
 * Hand a fully-composed message to the shared pgmq queue that already powers
 * auth email retries (the email queue worker): backoff via the message
 * visibility timeout, the `retry_after_until` throttle, a TTL, capped attempts
 * and a dead-letter queue. Nothing else needs to reimplement durability.
 */
async function enqueueForRetry(payload: Record<string, unknown>): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin.rpc("enqueue_email", {
      queue_name: "transactional_emails",
      payload: { ...payload, queued_at: new Date().toISOString() } as Json,
    });
    if (error) {
      console.error("[email] enqueue for retry failed", error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[email] enqueue for retry threw", e);
    return false;
  }
}

/** Stable, filesystem/header-safe idempotency key. */
function normaliseKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

export async function sendAppEmail(args: {
  dojoId: string;
  to: string;
  subject: string;
  html: string;
  templateName: string;
  /**
   * Deterministic per-intended-send key. Required by the email API (app
   * emails omit run_id and must supply idempotency_key + purpose). Must be
   * unique per intended send but identical on retry so a redelivered request
   * never double-sends.
   */
  idempotencyKey: string;
  /**
   * Email category. Marketing sends get an unsubscribe link + List-Unsubscribe
   * headers; transactional sends (1:1 messages, test emails, notifications)
   * must never carry one.
   */
  marketing?: boolean;
  sender?: SenderIdentity;
  supabase?: SupabaseClient<Database>;
  memberId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<SendResult> {
  const to = args.to?.trim();
  if (!to) return { ok: false, pending: false, error: "No email address on file" };

  // The gym's real name must appear in the inbox and in the platform footer.
  // Callers that don't hand us a request-scoped client still get a resolved
  // identity — falling back to the literal string "Your gym" made every
  // notification look anonymous.
  let sender = args.sender ?? null;
  if (!sender) {
    try {
      sender = await resolveSenderIdentity(args.supabase ?? supabaseAdmin, args.dojoId);
    } catch (e) {
      console.error("[email] sender identity lookup failed", e);
    }
  }
  const fromName = sender?.fromName?.trim() || "Your gym";
  const replyTo = sender?.replyTo ?? null;

  // Deterministic per-send key: stable on retry, unique per intended send.
  // Bind the provider run to its recipient. A reused business-event key can
  // never collide after an address changes, while retries of the same composed
  // message retain the exact same key.
  const rawKey = normaliseKey(
    `${args.dojoId}:${args.templateName}:${to.toLowerCase()}:${args.idempotencyKey}`,
  );
  // The email API rejects a send with no idempotency key ("Missing run_id or
  // idempotency_key"), so never let normalisation produce an empty string.
  const idempotencyKey = rawKey || normaliseKey(`${args.templateName}-${crypto.randomUUID()}`);
  const isMarketing = !!args.marketing;
  /**
   * PROVIDER TRANSPORT MODE — not a compliance label.
   *
   * The send API only knows two ways to open a message run:
   *   - `run_id`            supplied by an auth/build webhook (not available at
   *                         runtime, so unusable for app or bulk sends), or
   *   - `idempotency_key` + `purpose: "transactional"`.
   *
   * Any other `purpose` value (including "marketing" and "bulk") is rejected
   * with `400 missing_parameter — "Missing run_id or idempotency_key"`, which
   * is exactly why every marketing broadcast failed. There is no marketing or
   * broadcast mode on the API, so runtime sends MUST use this transport value.
   *
   * The marketing / transactional DISTINCTION IS NOT LOST — it is enforced
   * here, where it actually matters for GDPR/PECR:
   *   - unsubscribes suppress marketing absolutely (suppression gate above),
   *   - marketing carries a visible in-body opt-out link plus the
   *     `unsubscribe_token` the provider turns into List-Unsubscribe headers,
   *   - `email_send_log.metadata.category` records the true category.
   * The provider requires `unsubscribe_token` on transactional sends too, so
   * this transport value never weakens a recipient's opt-out.
   */
  const providerPurpose = "transactional";

  const baseMeta = {
    dojo_id: args.dojoId,
    member_id: args.memberId ?? null,
    marketing: isMarketing,
    category: isMarketing ? "marketing" : "transactional",
    from_name: fromName,
    reply_to: replyTo,
    idempotency_key: idempotencyKey,
    // Transport mode handed to the API, distinct from `category` above.
    provider_purpose: providerPurpose,

    ...(args.metadata ?? {}),
  };

  // SUPPRESSION GATE — see the policy note above. Unsubscribes block marketing
  // only; bounces/complaints block everything.
  const suppression = await suppressionFor(to);
  if (suppression && (isMarketing || suppression.blocksTransactional)) {
    const error = `Not sent: address suppressed (${suppression.reason})`;
    await logSend({
      messageId: null,
      templateName: args.templateName,
      recipient: to,
      status: "suppressed",
      error,
      metadata: baseMeta,
    });
    return { ok: false, pending: false, error, suppressed: true };
  }

  // The unsubscribe token and the final HTML must be resolved BEFORE any
  // queueing: the retry consumer sends the payload verbatim through the
  // provider, which rejects a message without from / sender_domain / purpose /
  // unsubscribe_token. Queuing a partial payload made every retry fail.
  let unsub: { token: string; url: string };
  try {
    unsub = await unsubscribeFor(to);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unsubscribe token creation failed";
    const sendError = `Email not sent: ${message}`.slice(0, 500);
    console.error("[email] required unsubscribe token unavailable", {
      recipient: to,
      template: args.templateName,
      error: message,
    });
    await logSend({
      messageId: null,
      templateName: args.templateName,
      recipient: to,
      status: "failed",
      error: sendError,
      metadata: { ...baseMeta, retry_subject: args.subject, retry_html: args.html },
    });
    return { ok: false, pending: false, error: sendError };
  }
  const unsubToken = unsub.token;

  // SINGLE FOOTER — DO NOT ADD ANOTHER, HERE OR IN ANY CALLER.
  // The email provider adapter (src/lib/email-provider.server.ts) appends exactly
  // one footer ("You received this email because of an action on <from_name>")
  // including the opt-out link built from `unsubscribe_token` below. We previously appended a second
  // marketing footer here, which is why retention/marketing emails arrived with
  // two footers and two unsubscribe links.
  //
  // Compliance is unaffected: the token is always sent, so marketing/retention
  // mail still carries a working one-click opt-out and List-Unsubscribe headers.
  // An opt-out lands in `suppressed_emails` with reason "unsubscribe", which the
  // suppression gate above treats as MARKETING-ONLY — retention and marketing
  // sends are blocked, while transactional mail (payment failures, price
  // changes, cancellations, password resets) still gets delivered.
  const html = args.html;

  // Exactly the shape the email queue worker hands to the provider.
  const queueMessageId = crypto.randomUUID();
  const retryPayload: Record<string, unknown> = {
    to,
    from: `${fromName} <${FROM_ADDRESS}>`,
    sender_domain: SENDING_DOMAIN,
    subject: args.subject,
    html,
    text: htmlToText(html),
    label: args.templateName,
    purpose: providerPurpose,
    idempotency_key: idempotencyKey,
    unsubscribe_token: unsubToken,
    message_id: queueMessageId,
    ...(replyTo ? { reply_to: replyTo } : {}),
    // Context for our own dashboards; ignored by the provider.
    dojo_id: args.dojoId,
    member_id: args.memberId ?? null,
    marketing: isMarketing,
    template_name: args.templateName,
  };

  // The provider has throttled us — queue instead of burning the attempt.
  if (await inRateLimitCooldown()) {
    const queued = await enqueueForRetry(retryPayload);
    if (queued) {
      await logSend({
        messageId: queueMessageId,
        templateName: args.templateName,
        recipient: to,
        status: "pending",
        error: "Queued: provider rate limit cooldown",
        metadata: { ...baseMeta, retry_subject: args.subject, retry_html: args.html },
      });
      return { ok: false, pending: true, error: "Queued for retry (rate limited)", queued: true };
    }
  }

  const status = await getSendingStatus();

  if (!status.verified && !status.canAttempt) {
    await logSend({
      messageId: null,
      templateName: args.templateName,
      recipient: to,
      status: "pending",
      error: status.reason ?? PENDING_MESSAGE,
      // Keep enough to replay the exact message from the email health page.
      metadata: { ...baseMeta, retry_subject: args.subject, retry_html: args.html },
    });
    return { ok: false, pending: true, error: PENDING_MESSAGE };
  }

  try {
    const res = await sendEmail(
      {
        to,
        from: `${fromName} <${FROM_ADDRESS}>`,
        subject: args.subject,
        html,
        text: htmlToText(html),
        replyTo: replyTo ?? undefined,
        idempotencyKey,
        unsubscribeUrl: `${PUBLIC_SITE_URL}/unsubscribe?token=${encodeURIComponent(unsubToken)}`,
        tags: { label: args.templateName, purpose: providerPurpose },
      },
      { apiKey: apiKey()! },
    );

    const providerId: string | null = res.messageId;
    // A successful send is proof the domain is verified.
    setStatus({ verified: true, canAttempt: true, reason: null });
    await logSend({
      messageId: providerId,
      templateName: args.templateName,
      recipient: to,
      status: "sent",
      metadata: baseMeta,
    });
    return { ok: true, providerId };
  } catch (e: unknown) {
    const err = e as ProviderError | null | undefined;
    const statusCode: number | null = typeof err?.status === "number" ? err.status : null;
    const message = String(err?.message ?? "Send failed");
    if (isDomainNotVerified(statusCode, message)) {
      setStatus({ verified: false, canAttempt: false, reason: "Pending domain verification." });
      await logSend({
        messageId: null,
        templateName: args.templateName,
        recipient: to,
        status: "pending",
        error: message,
        metadata: { ...baseMeta, retry_subject: args.subject, retry_html: args.html },
      });
      return { ok: false, pending: true, error: PENDING_MESSAGE };
    }
    const error = statusCode
      ? `Provider error ${statusCode}: ${message.slice(0, 300)}`
      : message.slice(0, 300);
    // Transient failures (429 / 5xx / network) go to the durable retry queue
    // rather than being reported as a permanent failure.
    if (isTransient(statusCode, message)) {
      const queued = await enqueueForRetry(retryPayload);
      if (queued) {
        await logSend({
          messageId: queueMessageId,
          templateName: args.templateName,
          recipient: to,
          status: "pending",
          error: `Queued for retry — ${error}`,
          metadata: { ...baseMeta, retry_subject: args.subject, retry_html: args.html },
        });
        return { ok: false, pending: true, error: `Queued for retry — ${error}`, queued: true };
      }
    }
    await logSend({
      messageId: null,
      templateName: args.templateName,
      recipient: to,
      status: "failed",
      error,
      metadata: { ...baseMeta, retry_subject: args.subject, retry_html: args.html },
    });
    return { ok: false, pending: false, error };
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
