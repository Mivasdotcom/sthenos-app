/**
 * Verifies and maps a Supabase Auth "Send Email Hook" request.
 *
 * Supabase signs the request with the Standard Webhooks scheme:
 *   signature = base64(HMAC-SHA256(key, `${webhook-id}.${webhook-timestamp}.${body}`))
 * where key is the base64-decoded part of the secret after the `v1,whsec_`
 * prefix. Pure module: no app imports, only node:crypto, so the Node test
 * runner can load it directly.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export class HookError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HookError";
    this.status = status;
  }
}

export const AUTH_EMAIL_TYPES = [
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "reauthentication",
] as const;

export type AuthEmailType = (typeof AUTH_EMAIL_TYPES)[number];

export interface VerifiedAuthEmail {
  webhookId: string;
  emailType: AuthEmailType;
  recipient: string;
  templateProps: {
    confirmationUrl: string;
    token: string;
    email: string;
    newEmail: string | undefined;
    oldEmail: string | undefined;
  };
}

/** Requests older (or further in the future) than this are replayed or skewed. */
const MAX_CLOCK_SKEW_SECONDS = 300;

/**
 * Verifies the signature and timestamp, then parses and maps the payload.
 * Throws HookError with the HTTP status the caller should answer with.
 */
export function verifyAndParseHook(
  rawBody: string,
  headers: Headers,
  secret: string,
  supabaseUrl: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): VerifiedAuthEmail {
  const webhookId = headers.get("webhook-id");
  const timestampHeader = headers.get("webhook-timestamp");
  const signatureHeader = headers.get("webhook-signature");
  if (!webhookId || !timestampHeader || !signatureHeader) {
    throw new HookError(400, "Missing webhook headers");
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > MAX_CLOCK_SKEW_SECONDS) {
    throw new HookError(401, "Invalid or stale webhook timestamp");
  }

  const signedContent = `${webhookId}.${timestampHeader}.${rawBody}`;
  if (!signatureMatches(signedContent, signatureHeader, signingKey(secret))) {
    throw new HookError(401, "Invalid webhook signature");
  }

  const parsed = parseBody(rawBody);
  return mapPayload(parsed, webhookId, supabaseUrl);
}

/** The HMAC key: the secret without its `v1,whsec_` prefix, base64-decoded. */
function signingKey(secret: string): Buffer {
  const withoutVersion = secret.trim().replace(/^v1,/, "");
  const encoded = withoutVersion.replace(/^whsec_/, "");
  return Buffer.from(encoded, "base64");
}

/** True when any `v1,<sig>` entry in the header matches the expected HMAC. */
function signatureMatches(signedContent: string, signatureHeader: string, key: Buffer): boolean {
  const expected = Buffer.from(createHmac("sha256", key).update(signedContent).digest("base64"));

  for (const entry of signatureHeader.split(/\s+/)) {
    const comma = entry.indexOf(",");
    if (comma === -1 || entry.slice(0, comma) !== "v1") continue;

    const candidate = Buffer.from(entry.slice(comma + 1));
    if (candidate.length !== expected.length) continue;
    if (timingSafeEqual(candidate, expected)) return true;
  }
  return false;
}

interface RawPayload {
  user: { email: string; new_email?: string };
  email_data: {
    email_action_type: string;
    token: string;
    token_hash: string;
    token_new: string;
    token_hash_new: string;
    redirect_to: string;
  };
}

function parseBody(rawBody: string): RawPayload {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new HookError(400, "Invalid JSON");
  }

  const user = isRecord(body) ? body.user : undefined;
  const emailData = isRecord(body) ? body.email_data : undefined;
  const email = isRecord(user) ? nonEmptyString(user.email) : undefined;
  const actionType = isRecord(emailData) ? nonEmptyString(emailData.email_action_type) : undefined;
  if (!isRecord(user) || !email || !isRecord(emailData) || !actionType) {
    throw new HookError(400, "Missing user.email or email_data.email_action_type");
  }

  return {
    user: { email, new_email: nonEmptyString(user.new_email) },
    email_data: {
      email_action_type: actionType,
      token: nonEmptyString(emailData.token) ?? "",
      token_hash: nonEmptyString(emailData.token_hash) ?? "",
      token_new: nonEmptyString(emailData.token_new) ?? "",
      token_hash_new: nonEmptyString(emailData.token_hash_new) ?? "",
      redirect_to: nonEmptyString(emailData.redirect_to) ?? "",
    },
  };
}

function mapPayload(
  payload: RawPayload,
  webhookId: string,
  supabaseUrl: string,
): VerifiedAuthEmail {
  const actionType = payload.email_data.email_action_type;
  if (!isAuthEmailType(actionType)) {
    throw new HookError(400, `Unknown email action type: ${actionType}`);
  }

  const { user, email_data: data } = payload;
  const isEmailChange = actionType === "email_change";

  // An email change goes to the NEW address, using the _new token when Supabase sent one.
  const recipient = isEmailChange ? (user.new_email ?? user.email) : user.email;
  const hash = isEmailChange && data.token_hash_new ? data.token_hash_new : data.token_hash;
  const token = isEmailChange && data.token_new ? data.token_new : data.token;

  const base = supabaseUrl.replace(/\/+$/, "");
  const confirmationUrl =
    `${base}/auth/v1/verify?token=${encodeURIComponent(hash)}` +
    `&type=${actionType}&redirect_to=${encodeURIComponent(data.redirect_to)}`;

  return {
    webhookId,
    emailType: actionType,
    recipient,
    templateProps: {
      confirmationUrl,
      token,
      email: recipient,
      newEmail: user.new_email,
      oldEmail: user.email,
    },
  };
}

function isAuthEmailType(value: string): value is AuthEmailType {
  return (AUTH_EMAIL_TYPES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
