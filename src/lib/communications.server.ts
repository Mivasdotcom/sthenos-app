import { contactEmailFor, isUnder18 } from "@/lib/minors";

const STAFF_ROLES = new Set(["owner", "admin", "coach"]);

export async function callerRole(
  supabase: any,
  userId: string,
  dojoId: string,
): Promise<"staff" | "member"> {
  const { assertDojoMember } = await import("./dojo-access");
  const role = await assertDojoMember(supabase, userId, dojoId, "communications");
  return STAFF_ROLES.has(role) ? "staff" : "member";
}

export async function ensureConversation(
  supabase: any,
  dojoId: string,
  memberId: string,
): Promise<string> {
  const { data: existing } = await supabase
    .from("conversations")
    .select("id")
    .eq("dojo_id", dojoId)
    .eq("member_id", memberId)
    .maybeSingle();
  if (existing?.id) return existing.id;
  const { data: created, error } = await supabase
    .from("conversations")
    .insert({ dojo_id: dojoId, member_id: memberId })
    .select("id")
    .single();
  if (error) throw error;
  return created.id;
}

export async function deliverStaffEmail(args: {
  supabase: any;
  dojoId: string;
  memberId: string;
  messageId: string;
  conversationId: string;
  body: string;
  retentionOutreach: boolean;
}) {
  const { data: memberRow } = await args.supabase
    .from("members")
    .select("name, email, date_of_birth, guardian_email")
    .eq("id", args.memberId)
    .eq("dojo_id", args.dojoId)
    .maybeSingle();
  const recipientEmail = memberRow ? contactEmailFor(memberRow) : null;
  if (!recipientEmail) {
    return {
      delivered: false,
      notice: memberRow && isUnder18(memberRow.date_of_birth)
        ? "Message logged. This member is under 18 and has no parent/guardian email on file."
        : "Message logged. Member has no email address on file.",
    };
  }

  const { sendAppEmail, resolveSenderIdentity } = await import("./email-send.server");
  const sender = await resolveSenderIdentity(args.supabase, args.dojoId);
  const { data: dojo } = await args.supabase
    .from("dojos")
    .select("name")
    .eq("id", args.dojoId)
    .maybeSingle();
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#111">${args.body
    .split(/\n+/)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("")}</div>`;
  const result = await sendAppEmail({
    dojoId: args.dojoId,
    to: recipientEmail,
    subject: `Message from ${sender.fromName || dojo?.name || "your gym"}`,
    html,
    templateName: "direct-message",
    idempotencyKey: `message:${args.messageId}`,
    marketing: args.retentionOutreach,
    sender,
    memberId: args.memberId,
    metadata: {
      message_id: args.messageId,
      conversation_id: args.conversationId,
      retention_outreach: args.retentionOutreach,
    },
  });
  if (result.ok) return { delivered: true, notice: null };
  return {
    delivered: false,
    notice: result.pending
      ? "Message logged in the conversation. Email pending domain verification."
      : `Message logged in the conversation, but email delivery failed: ${result.error}`,
  };
}

export async function recordRetentionContact(args: {
  supabase: any;
  dojoId: string;
  memberId: string;
  body: string;
  contactedAt: string;
  createIfMissing: boolean;
  contactedBy: string;
}) {
  const { data: open, error: openError } = await args.supabase
    .from("retention_interventions")
    .select("id,intervention_at,notes")
    .eq("dojo_id", args.dojoId)
    .eq("member_id", args.memberId)
    .eq("outcome", "pending")
    .order("flagged_at", { ascending: false })
    .limit(1);
  if (openError) throw openError;

  const contactNote = `Email sent ${args.contactedAt}: ${args.body}`.slice(0, 2000);
  if (open?.length) {
    const previous = String(open[0].notes ?? "").trim();
    const notes = previous ? `${previous}\n\n${contactNote}`.slice(-2000) : contactNote;
    const { error } = await args.supabase
      .from("retention_interventions")
      .update({
        intervention_type: "email",
        intervention_at: open[0].intervention_at ?? args.contactedAt,
        intervention_by: args.contactedBy,
        notes,
      })
      .eq("id", open[0].id)
      .eq("dojo_id", args.dojoId);
    if (error) throw error;
    return;
  }

  if (!args.createIfMissing) return;

  const { data: member, error: memberError } = await args.supabase
    .from("members")
    .select("retention_risk_level,retention_risk_score,retention_risk_factors")
    .eq("id", args.memberId)
    .eq("dojo_id", args.dojoId)
    .single();
  if (memberError) throw memberError;
  const { error } = await args.supabase.from("retention_interventions").insert({
    dojo_id: args.dojoId,
    member_id: args.memberId,
    flagged_at: args.contactedAt,
    risk_level_at_flag: member.retention_risk_level ?? "healthy",
    risk_score_at_flag: member.retention_risk_score ?? 0,
    risk_factors_at_flag: member.retention_risk_factors ?? [],
    intervention_type: "email",
    intervention_at: args.contactedAt,
    intervention_by: args.contactedBy,
    outcome: "pending",
    notes: contactNote,
  });
  if (error) throw error;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}