/**
 * The one place Sthenos sends email. Transactional sends and the pgmq queue
 * worker both go through `sendEmail`, so provider behaviour (rate limits,
 * unverified domains, unsubscribe headers) is defined once.
 *
 * Deliberately alias-free and import-free: the Node test runner loads this file
 * directly with --experimental-strip-types, so it must not depend on `@/` paths
 * or on any other src file. Callers build the unsubscribe URL themselves.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export class EmailProviderError extends Error {
  /** HTTP status from the provider, or null when the request never got a response. */
  status: number | null;
  /** Seconds to wait, from the Retry-After header on a 429. */
  retryAfterSeconds: number | null;

  constructor(message: string, status: number | null, retryAfterSeconds: number | null) {
    super(message);
    this.name = "EmailProviderError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type SendEmailInput = {
  to: string;
  from: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  idempotencyKey?: string;
  /** Fully built one-click unsubscribe URL. When set, List-Unsubscribe headers are added. */
  unsubscribeUrl?: string;
  tags?: Record<string, string>;
};

export type SendEmailOptions = {
  apiKey?: string;
  fetchImpl?: typeof fetch;
};

/** Resend accepts only ASCII letters, numbers, underscores and dashes in tags. */
function sanitiseTagPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header.trim());
  return Number.isFinite(seconds) ? seconds : null;
}

/** Reads the provider's `{ message }` from an error body, if it has one. */
function providerMessage(bodyText: string): string | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed && typeof parsed === "object" && "message" in parsed) {
      const message = (parsed as { message: unknown }).message;
      return typeof message === "string" && message.length > 0 ? message : null;
    }
  } catch {
    // Not JSON: fall through to the generic message.
  }
  return null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Display name from `"Name <addr>"`, or the bare address. Surrounding quotes are removed. */
function displayName(from: string): string {
  const match = from.match(/^\s*(.*?)\s*<[^>]*>\s*$/);
  const raw = (match ? match[1] : from).trim();
  const unquoted =
    raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  return unquoted.trim() || from.trim();
}

/**
 * Inserts the one visible unsubscribe footer. It goes before the LAST `</body>`
 * (case-insensitive), or at the end when there is none.
 */
function withHtmlFooter(html: string, name: string, url: string): string {
  const footer =
    `<p style="margin:24px 0 0;font-size:12px;line-height:18px;color:#6b7280;text-align:center">` +
    `You received this email because of an action on ${escapeHtml(name)}. ` +
    `<a href="${escapeHtml(url)}" style="color:#6b7280;text-decoration:underline">Unsubscribe</a></p>`;
  const lastBodyClose = [...html.matchAll(/<\/body>/gi)].pop();
  if (lastBodyClose?.index === undefined) return html + footer;
  return html.slice(0, lastBodyClose.index) + footer + html.slice(lastBodyClose.index);
}

function buildBody(input: SendEmailInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    from: input.from,
    to: [input.to],
    subject: input.subject,
    html: input.html,
  };
  if (input.text !== undefined) body.text = input.text;
  if (input.replyTo !== undefined) body.reply_to = input.replyTo;
  if (input.unsubscribeUrl !== undefined) {
    const name = displayName(input.from);
    body.html = withHtmlFooter(input.html, name, input.unsubscribeUrl);
    if (input.text !== undefined) {
      body.text = `${input.text}\n\n—\nYou received this email because of an action on ${name}. Unsubscribe: ${input.unsubscribeUrl}`;
    }
    body.headers = {
      "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
  }
  if (input.tags !== undefined && Object.keys(input.tags).length > 0) {
    body.tags = Object.entries(input.tags).map(([name, value]) => ({
      name: sanitiseTagPart(name),
      value: sanitiseTagPart(value),
    }));
  }
  return body;
}

/**
 * Sends one email through Resend and returns Resend's message id.
 *
 * Throws EmailProviderError for every failure. The message never contains the
 * API key, because the provider's error text is scrubbed before it is thrown.
 */
export async function sendEmail(
  input: SendEmailInput,
  opts: SendEmailOptions = {},
): Promise<{ messageId: string }> {
  const apiKey = opts.apiKey ?? process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new EmailProviderError("RESEND_API_KEY is not configured", null, null);
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey;

  let res: Response;
  try {
    res = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(buildBody(input)),
    });
  } catch (error) {
    // Only the error type: the original message is not worth persisting.
    const type = error instanceof Error ? error.name : "unknown";
    throw new EmailProviderError(`Email provider unreachable (${type})`, null, null);
  }

  if (!res.ok) {
    const bodyText = await res.text();
    const message = providerMessage(bodyText) ?? `Resend error ${res.status}`;
    throw new EmailProviderError(
      message.replaceAll(apiKey, "[redacted]"),
      res.status,
      parseRetryAfter(res.headers.get("retry-after")),
    );
  }

  const json = (await res.json()) as { id: string };
  return { messageId: json.id };
}
