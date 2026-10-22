import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertDojoStaff } from "./dojo-access";

export type EmailSettings = {
  /** Sender name members see in their inbox (defaults to the dojo name). */
  from_name: string;
  /** Reply-to address (defaults to the owner's email). */
  from_address: string;
};

/** Current sender identity + provider/domain sending status for a dojo. */
export const getEmailSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "getEmailSettings");
    const { resolveSenderIdentity, getSendingStatus, FROM_ADDRESS, SENDING_DOMAIN } = await import(
      "./email-send.server"
    );

    // resolveSenderIdentity already ignores legacy placeholder values, so this
    // is the identity emails will actually be sent with.
    const identity = await resolveSenderIdentity(supabase, data.dojoId);
    const status = await getSendingStatus(true);

    return {
      settings: {
        from_name: identity.fromName,
        from_address: identity.replyTo ?? "",
      } as EmailSettings,
      defaults: { from_name: identity.fromName, from_address: identity.replyTo ?? "" },
      sending: {
        verified: status.verified,
        domain: SENDING_DOMAIN,
        fromAddress: FROM_ADDRESS,
        reason: status.reason,
      },
    };
  });

export const saveEmailSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { from_name: string; from_address: string; dojoId: string }) => {
    const name = d.from_name?.trim();
    const addr = d.from_address?.trim();
    if (!name || name.length > 80) throw new Error("Sender name must be 1–80 characters");
    if (!addr || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) || addr.length > 200) {
      throw new Error("Reply-to must be a valid email address");
    }
    if (!d.dojoId) throw new Error("dojoId required");
    return { from_name: name, from_address: addr, dojoId: d.dojoId };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "saveEmailSettings");

    const { data: existing } = await supabase
      .from("email_settings")
      .select("id")
      .eq("dojo_id", data.dojoId)
      .maybeSingle();

    if (existing) {
      const { error } = await supabase
        .from("email_settings")
        .update({
          from_name: data.from_name,
          from_address: data.from_address,
          updated_at: new Date().toISOString(),
          updated_by: userId,
        })
        .eq("dojo_id", data.dojoId);
      if (error) throw error;
    } else {
      const { error } = await supabase.from("email_settings").insert({
        dojo_id: data.dojoId,
        from_name: data.from_name,
        from_address: data.from_address,
        updated_by: userId,
      });
      if (error) throw error;
    }
    return { ok: true };
  });

/** Staff-only: send a test email to a chosen address (defaults to the caller). */
export const sendTestEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; to?: string }) => {
    if (!d?.dojoId) throw new Error("dojoId required");
    const to = d.to?.trim();
    if (to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error("Invalid email address");
    return { dojoId: d.dojoId, to: to ?? "" };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "sendTestEmail");
    const { sendAppEmail, resolveSenderIdentity, escapeHtml } = await import("./email-send.server");

    let to = data.to;
    if (!to) {
      const { data: prof } = await supabase
        .from("profiles")
        .select("email")
        .eq("user_id", userId)
        .maybeSingle();
      to = prof?.email ?? "";
    }
    if (!to) throw new Error("No email address to send to");

    const sender = await resolveSenderIdentity(supabase, data.dojoId);
    const result = await sendAppEmail({
      dojoId: data.dojoId,
      to,
      subject: `Test email from ${sender.fromName}`,
      html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:#111"><p>This is a test email from <strong>${escapeHtml(
        sender.fromName,
      )}</strong>.</p><p>If you can read this, email sending is working. Replies go to ${escapeHtml(
        sender.replyTo ?? "your gym",
      )}.</p></div>`,
      templateName: "test-email",
      // Stable within a 1-minute bucket so a retried click never double-sends.
      idempotencyKey: `test:${to.toLowerCase()}:${Math.floor(Date.now() / 60_000)}`,

      sender,
      supabase,
    });

    if (result.ok) {
      return {
        ok: true as const,
        to,
        pending: false,
        message: `Test email sent to ${to}`,
        detail: `From ${sender.fromName} <${sender.fromAddress}>${
          sender.replyTo ? `, replies to ${sender.replyTo}` : ""
        }${result.providerId ? ` · id ${result.providerId}` : ""}`,
      };
    }
    return { ok: false as const, to, pending: result.pending, message: result.error, detail: null };
  });
