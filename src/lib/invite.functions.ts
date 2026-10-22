import { PUBLIC_SITE_URL } from "@/lib/site";
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { contactEmailFor } from "@/lib/minors";

type InviteInput = { memberId: string; redirectTo?: string };

export type InviteErrorCode =
  | "invalid_input"
  | "member_not_found"
  | "missing_email"
  | "invalid_email"
  | "forbidden"
  | "already_linked"
  | "already_invited"
  | "invite_failed"
  | "internal_error";

const INVITE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

export class InviteError extends Error {
  code: InviteErrorCode;
  status: number;
  constructor(code: InviteErrorCode, message: string, status = 400) {
    super(message);
    this.name = "InviteError";
    this.code = code;
    this.status = status;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Send a portal invite to a manager-added member.
 * - Caller must be staff (owner/admin/coach/manager) in the member's dojo.
 * - If the email is already linked to an auth user, no email is sent.
 * - Otherwise an invite email is sent via Supabase Auth admin.
 *
 * Errors are thrown as `InviteError` with a stable `code` so the UI can map to
 * actionable messages. The thrown Error's message is safe to surface to users.
 */
export const sendPortalInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: InviteInput) => {
    if (!input || typeof input.memberId !== "string" || !input.memberId.trim()) {
      throw new InviteError("invalid_input", "A member must be selected before sending an invite.");
    }
    return { memberId: input.memberId.trim(), redirectTo: input.redirectTo };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: member, error } = await supabase
      .from("members")
      .select("id, email, name, dojo_id, user_id, last_invited_at, date_of_birth, guardian_email")
      .eq("id", data.memberId)
      .maybeSingle();
    if (error) {
      throw new InviteError("internal_error", "Could not load member record. Please try again.", 500);
    }
    if (!member) {
      throw new InviteError("member_not_found", "Member not found. They may have been removed.", 404);
    }
    // Minors are invited through their parent or guardian.
    const inviteEmail = contactEmailFor(member);
    if (!inviteEmail) {
      throw new InviteError(
        "missing_email",
        "This member has no email on file. Add an email address before sending an invite.",
      );
    }
    if (!EMAIL_RE.test(inviteEmail)) {
      throw new InviteError(
        "invalid_email",
        `The email on file ("${inviteEmail}") is not valid. Update the member's email and try again.`,
      );
    }

    // Authorize: caller must be staff in the member's dojo.
    const { data: isStaff, error: staffErr } = await supabase.rpc("is_dojo_staff", {
      _user_id: userId,
      _dojo_id: member.dojo_id,
    });
    if (staffErr) {
      throw new InviteError("internal_error", "Permission check failed. Please try again.", 500);
    }
    if (!isStaff) {
      throw new InviteError(
        "forbidden",
        "You don't have permission to invite members for this gym.",
        403,
      );
    }

    if (member.user_id) {
      return { ok: true as const, status: "already_linked" as const };
    }

    // Prevent double invites within the cooldown window.
    if (member.last_invited_at) {
      const last = new Date(member.last_invited_at).getTime();
      const elapsed = Date.now() - last;
      if (Number.isFinite(last) && elapsed < INVITE_COOLDOWN_MS) {
        const mins = Math.max(1, Math.ceil((INVITE_COOLDOWN_MS - elapsed) / 60000));
        throw new InviteError(
          "already_invited",
          `An invite was just sent to ${inviteEmail}. Wait ${mins} minute${mins === 1 ? "" : "s"} before re-sending, or ask them to check their inbox and spam folder.`,
          429,
        );
      }
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: existing, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("user_id")
      .ilike("email", inviteEmail)
      .maybeSingle();
    if (profileErr) {
      throw new InviteError("internal_error", "Could not check existing accounts. Please try again.", 500);
    }

    if (existing?.user_id) {
      const { error: updErr } = await supabaseAdmin
        .from("members")
        .update({ user_id: existing.user_id, updated_at: new Date().toISOString() })
        .eq("id", member.id);
      if (updErr) {
        throw new InviteError("internal_error", "Could not link the existing account. Please try again.", 500);
      }
      const { error: upsertErr } = await supabaseAdmin
        .from("dojo_memberships")
        .upsert(
          { user_id: existing.user_id, dojo_id: member.dojo_id, role: "member" },
          { onConflict: "dojo_id,user_id" },
        );
      if (upsertErr) {
        throw new InviteError("internal_error", "Could not attach the member to this gym. Please try again.", 500);
      }
      return { ok: true as const, status: "linked_existing" as const };
    }

    const redirectTo = data.redirectTo || `${PUBLIC_SITE_URL}/my-membership`;

    // Always generate a shareable invite link as a fallback in case email
    // sending isn't configured or fails. generateLink does not send an email.
    let inviteLink: string | null = null;
    try {
      const { data: linkData } = await supabaseAdmin.auth.admin.generateLink({
        type: "invite",
        email: inviteEmail,
        options: { redirectTo },
      });
      inviteLink = (linkData as any)?.properties?.action_link ?? null;
    } catch {
      inviteLink = null;
    }

    const { error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(inviteEmail, {
      redirectTo,
      data: {
        full_name: member.name,
        dojo_id: member.dojo_id,
        invited_member_id: member.id,
      },
    });
    if (inviteErr) {
      const raw = inviteErr.message?.toLowerCase() ?? "";
      if (raw.includes("already") && raw.includes("registered")) {
        throw new InviteError(
          "already_linked",
          "An account already exists for this email. Ask the member to sign in — they'll be linked automatically.",
        );
      }
      if (raw.includes("rate")) {
        throw new InviteError(
          "invite_failed",
          "Too many invites sent recently. Wait a few minutes and try again.",
          429,
        );
      }
      // Email sending isn't configured (or provider errored). Return the
      // fallback link so the UI can offer a copy-link action.
      await supabaseAdmin
        .from("members")
        .update({ last_invited_at: new Date().toISOString() })
        .eq("id", member.id);
      return {
        ok: true as const,
        status: "email_unavailable" as const,
        inviteLink,
      };
    }

    // Stamp the invite so a duplicate click within the cooldown window is rejected.
    await supabaseAdmin
      .from("members")
      .update({ last_invited_at: new Date().toISOString() })
      .eq("id", member.id);

    return { ok: true as const, status: "invite_sent" as const, inviteLink };
  });
