// Server-only member notification. Used by billing changes (price changes,
// pauses, resumes) where the governing rule is that nobody's charge may change
// without them being told first.
//
// A notification is ALWAYS written to the member's in-app conversation (that is
// the durable record staff can point at), and additionally emailed when we have
// a contact address. Email failures never block the in-app record.

export type NotifyResult = {
  inApp: boolean;
  /** True only when the provider accepted the message. */
  emailed: boolean;
  /** Set when the email did NOT go out, so callers can tell staff the truth. */
  emailError: string | null;
  /** True when sending is blocked pending domain verification (retryable). */
  emailPending: boolean;
  /** The address we tried, for staff-facing messages. */
  to: string | null;
};

export async function notifyMember(args: {
  dojoId: string;
  memberId: string;
  subject: string;
  /** Plain text; newlines become paragraphs in the email. */
  body: string;
  actorUserId?: string | null;
  /** Stable per-intended-send key so a retry cannot double-send. */
  idempotencyKey: string;
  email?: boolean;
}): Promise<NotifyResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const result: NotifyResult = {
    inApp: false,
    emailed: false,
    emailError: null,
    emailPending: false,
    to: null,
  };

  try {
    let conversationId: string | null = null;
    const { data: existing } = await supabaseAdmin
      .from("conversations")
      .select("id")
      .eq("dojo_id", args.dojoId)
      .eq("member_id", args.memberId)
      .maybeSingle();
    if (existing?.id) {
      conversationId = existing.id as string;
    } else {
      const { data: created } = await supabaseAdmin
        .from("conversations")
        .insert({ dojo_id: args.dojoId, member_id: args.memberId })
        .select("id")
        .single();
      conversationId = (created?.id as string) ?? null;
    }
    if (conversationId) {
      const { data: inserted } = await supabaseAdmin
        .from("messages")
        .insert({
          conversation_id: conversationId,
          dojo_id: args.dojoId,
          member_id: args.memberId,
          sender_type: "staff",
          sender_user_id: args.actorUserId ?? null,
          channel: "in_app",
          body: `${args.subject}\n\n${args.body}`,
        })
        .select("id, created_at")
        .single();
      if (inserted?.created_at) {
        await supabaseAdmin
          .from("conversations")
          .update({ last_message_at: inserted.created_at })
          .eq("id", conversationId);
      }
      result.inApp = true;
    }
  } catch (e) {
    console.error("[member-notify] in-app notification failed", e);
  }

  if (args.email === false) return result;

  try {
    const { data: member } = await supabaseAdmin
      .from("members")
      .select("name, email, date_of_birth, guardian_email")
      .eq("id", args.memberId)
      .maybeSingle();
    const { contactEmailFor } = await import("@/lib/minors");
    const to = contactEmailFor(member as any);
    if (!to) {
      result.emailError = "No email address on file for this member";
      return result;
    }
    result.to = to;
    const { sendAppEmail } = await import("@/lib/email-send.server");
    const paragraphs = args.body
      .split(/\n{2,}/)
      .map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
      .join("");
    const res = await sendAppEmail({
      dojoId: args.dojoId,
      to,
      subject: args.subject,
      html: `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.55;color:#1b1b1b"><h2 style="font-size:18px;margin:0 0 14px">${escapeHtml(args.subject)}</h2>${paragraphs}</div>`,
      templateName: "membership-notice",
      idempotencyKey: args.idempotencyKey,
      marketing: false,
      memberId: args.memberId,
    });
    if ((res as any)?.ok) {
      result.emailed = true;
    } else {
      result.emailed = false;
      result.emailPending = !!(res as any)?.pending;
      result.emailError = String((res as any)?.error ?? "Email send failed");
    }
  } catch (e: any) {
    console.error("[member-notify] email failed", e);
    result.emailError = String(e?.message ?? "Email send failed").slice(0, 300);
  }

  return result;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Collects notify results so a server function can report the REAL outcome to
 * staff instead of assuming the member was reached.
 */
export function notifyCollector() {
  const summary = {
    attempted: 0,
    emailed: 0,
    inApp: 0,
    failed: 0,
    failures: [] as Array<{
      memberId: string | null;
      name: string | null;
      to: string | null;
      error: string;
      pending: boolean;
    }>,
  };
  return {
    summary,
    add(result: NotifyResult, who?: { memberId?: string | null; name?: string | null }) {
      summary.attempted += 1;
      if (result.inApp) summary.inApp += 1;
      if (result.emailed) {
        summary.emailed += 1;
      } else {
        summary.failed += 1;
        summary.failures.push({
          memberId: who?.memberId ?? null,
          name: who?.name ?? null,
          to: result.to,
          error: result.emailError ?? "Email send failed",
          pending: result.emailPending,
        });
      }
      return result;
    },
  };
}
