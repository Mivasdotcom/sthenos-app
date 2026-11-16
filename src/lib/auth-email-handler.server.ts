import type { SupabaseClient } from "@supabase/supabase-js";
import {
  HookError,
  verifyAndParseHook,
  type AuthEmailType,
  type VerifiedAuthEmail,
} from "./auth-email-hook.ts";

// Alias-free on purpose: the Supabase Send Email Hook is tested directly with plain Node.
// Everything aliased or .tsx (env, the Supabase client, React Email rendering, branding,
// sender identity, the clock and UUIDs) is injected through AuthEmailDeps. The route
// (src/routes/api/public/hooks/auth-email.ts) builds the real deps.

export type AuthEmailTemplateProps = {
  siteName: string;
  siteUrl: string;
  recipient: string;
  confirmationUrl: string;
  token: string;
  email: string;
  oldEmail: string | undefined;
  newEmail: string | undefined;
};

export type RenderedEmail = { html: string; text: string };

export type AuthEmailDeps = {
  env: Record<string, string | undefined>;
  createSupabase: (url: string, serviceKey: string) => SupabaseClient;
  /** Returns null when there is no template for the type (the request is answered with 400). */
  renderEmail: (
    emailType: AuthEmailType,
    props: AuthEmailTemplateProps,
  ) => Promise<RenderedEmail | null>;
  resolveBrand: (supabase: SupabaseClient, email: string) => Promise<string>;
  senderDisplayName: (brand: string) => string;
  fromAddress: string;
  sendingDomain: string;
  siteUrl: string;
  randomUUID: () => string;
  /** Epoch milliseconds. */
  now: () => number;
};

export function subjectFor(emailType: AuthEmailType | string, brand: string): string {
  switch (emailType) {
    case "signup":
      return `Confirm your email for ${brand}`;
    case "invite":
      return `You've been invited to join ${brand}`;
    case "magiclink":
      return `Your ${brand} login link`;
    case "recovery":
      return `Reset your ${brand} password`;
    case "email_change":
      return `Confirm your new email for ${brand}`;
    case "reauthentication":
      return `Your ${brand} verification code`;
    default:
      return `${brand} notification`;
  }
}

export function redactEmail(email: string | null | undefined): string {
  if (!email) return "***";
  const [localPart, domain] = email.split("@");
  if (!localPart || !domain) return "***";
  return `${localPart[0]}***@${domain}`;
}

type EnqueueOneArgs = {
  supabase: SupabaseClient;
  deps: AuthEmailDeps;
  runId: string;
  emailType: AuthEmailType;
  recipient: string;
  brand: string;
  rendered: RenderedEmail;
};

/** Logs a pending row, then enqueues one email. Returns false when the enqueue failed. */
async function enqueueOne({
  supabase,
  deps,
  runId,
  emailType,
  recipient,
  brand,
  rendered,
}: EnqueueOneArgs): Promise<boolean> {
  const messageId = deps.randomUUID();

  // Log pending BEFORE enqueue so we have a record even if enqueue crashes.
  // A failed log write must not block the sign-in email, so it is reported and
  // enqueueing carries on. Only the error code is logged: the message can echo the address.
  const { error: pendingError } = await supabase.from("email_send_log").insert({
    message_id: messageId,
    template_name: emailType,
    recipient_email: recipient,
    status: "pending",
  });
  if (pendingError) {
    console.error("Failed to log pending auth email", {
      code: pendingError.code ?? null,
      message_id: messageId,
      template_name: emailType,
      email_redacted: redactEmail(recipient),
      run_id: runId,
    });
  }

  const { error: enqueueError } = await supabase.rpc("enqueue_email", {
    queue_name: "auth_emails",
    payload: {
      run_id: runId,
      message_id: messageId,
      to: recipient,
      from: `${deps.senderDisplayName(brand)} <${deps.fromAddress}>`,
      sender_domain: deps.sendingDomain,
      subject: subjectFor(emailType, brand),
      html: rendered.html,
      text: rendered.text,
      purpose: "transactional",
      label: emailType,
      queued_at: new Date(deps.now()).toISOString(),
    },
  });

  if (enqueueError) {
    // Same rule as the pending log: the RPC message can echo the address, so only the code is logged.
    console.error("Failed to enqueue auth email", {
      code: enqueueError.code ?? null,
      run_id: runId,
      emailType,
      email_redacted: redactEmail(recipient),
    });
    await supabase.from("email_send_log").insert({
      message_id: messageId,
      template_name: emailType,
      recipient_email: recipient,
      status: "failed",
      error_message: "Failed to enqueue email",
    });
    return false;
  }

  console.log("Auth email enqueued", {
    emailType,
    email_redacted: redactEmail(recipient),
    run_id: runId,
  });
  return true;
}

export async function handleAuthEmailHook(
  request: Request,
  deps: AuthEmailDeps,
): Promise<Response> {
  const raw = await request.text();
  const secret = deps.env["SEND_EMAIL_HOOK_SECRET"];
  const supabaseUrl = deps.env["SUPABASE_URL"];

  if (!secret || !supabaseUrl) {
    console.error("Auth email hook is missing SEND_EMAIL_HOOK_SECRET or SUPABASE_URL");
    return Response.json({ error: "Server configuration error" }, { status: 500 });
  }

  // Verify the Standard Webhooks signature and timestamp, then map the payload to its emails.
  let verified: VerifiedAuthEmail[];
  try {
    verified = verifyAndParseHook(raw, request.headers, secret, supabaseUrl);
  } catch (error) {
    if (error instanceof HookError) {
      console.error("Auth email hook rejected request", {
        status: error.status,
        error: error.message,
      });
      return Response.json(
        { error: { http_code: error.status, message: error.message } },
        { status: error.status },
      );
    }
    throw error;
  }

  // Every email in one request shares the type and webhook id.
  const [first] = verified;
  const { webhookId: run_id, emailType } = first;
  console.log("Received auth event", {
    emailType,
    email_redacted: redactEmail(first.recipient),
    emails: verified.length,
    run_id,
  });

  // Supabase (service role) — needed for branding lookup, logging and enqueue.
  const supabaseServiceKey = deps.env["SUPABASE_SERVICE_ROLE_KEY"];

  if (!supabaseServiceKey) {
    console.error("Missing Supabase environment variables");
    return Response.json({ error: "Server configuration error" }, { status: 500 });
  }

  const supabase = deps.createSupabase(supabaseUrl, supabaseServiceKey);

  // The gym name when the member belongs to exactly one live gym, otherwise the
  // product name. Never the project slug. For an email change, branding follows
  // the member's current address, so it is resolved once for the whole request.
  const brand = await deps.resolveBrand(supabase, first.templateProps.oldEmail ?? first.recipient);

  // Render every email before queuing any, so a missing template queues nothing.
  const renderedEmails: { recipient: string; rendered: RenderedEmail }[] = [];
  for (const email of verified) {
    const rendered = await deps.renderEmail(emailType, {
      siteName: brand,
      siteUrl: deps.siteUrl,
      recipient: email.recipient,
      confirmationUrl: email.templateProps.confirmationUrl,
      token: email.templateProps.token,
      email: email.recipient,
      oldEmail: email.templateProps.oldEmail,
      newEmail: email.templateProps.newEmail,
    });

    if (!rendered) {
      console.error("Unknown email type", { emailType, run_id });
      return Response.json({ error: `Unknown email type: ${emailType}` }, { status: 400 });
    }
    renderedEmails.push({ recipient: email.recipient, rendered });
  }

  // Enqueue in order and stop at the first failure, answering 500 so Supabase
  // treats the send as failed. An email already queued before the failure is not
  // recalled, so a retry may send that one again.
  for (const { recipient, rendered } of renderedEmails) {
    const enqueued = await enqueueOne({
      supabase,
      deps,
      runId: run_id,
      emailType,
      recipient,
      brand,
      rendered,
    });
    if (!enqueued) {
      return Response.json({ error: "Failed to enqueue email" }, { status: 500 });
    }
  }

  return Response.json({});
}
