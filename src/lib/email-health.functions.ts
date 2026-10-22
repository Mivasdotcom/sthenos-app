import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertDojoStaff } from "./dojo-access";

export type EmailLogRow = {
  id: string;
  messageId: string | null;
  template: string;
  recipient: string;
  status: string;
  error: string | null;
  createdAt: string;
  /** True when we stored enough to replay the exact message. */
  retryable: boolean;
  memberId: string | null;
};

export type EmailHealth = {
  domain: { name: string; verified: boolean; reason: string | null; fromAddress: string };
  stats: { total: number; sent: number; failed: number; pending: number; suppressed: number };
  rows: EmailLogRow[];
  /** Addresses the provider will refuse (bounced/complained/unsubscribed). */
  suppressed: Array<{ email: string; reason: string; createdAt: string }>;
};

/**
 * Recent sends for this gym, de-duplicated by message_id so one email is one
 * row (the log is append-only and records pending -> sent transitions).
 */
export const getEmailHealth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; days?: number }) => ({
    dojoId: d.dojoId,
    days: Math.min(Math.max(d.days ?? 7, 1), 90),
  }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "getEmailHealth");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { getSendingStatus, SENDING_DOMAIN, FROM_ADDRESS } = await import("./email-send.server");

    const since = new Date(Date.now() - data.days * 86_400_000).toISOString();
    const { data: raw } = await supabaseAdmin
      .from("email_send_log")
      .select("id, message_id, template_name, recipient_email, status, error_message, metadata, created_at")
      .gte("created_at", since)
      .contains("metadata", { dojo_id: data.dojoId })
      .order("created_at", { ascending: false })
      .limit(500);

    // Latest row wins per message_id; rows without one stand alone.
    const seen = new Set<string>();
    const rows: EmailLogRow[] = [];
    for (const r of ((raw ?? []) as any[])) {
      const key = (r.message_id as string | null) ?? `id:${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      rows.push({
        id: r.id as string,
        messageId: (r.message_id as string | null) ?? null,
        template: r.template_name as string,
        recipient: r.recipient_email as string,
        status: r.status as string,
        error: (r.error_message as string | null) ?? null,
        createdAt: r.created_at as string,
        retryable:
          r.status !== "sent" &&
          typeof meta["retry_html"] === "string" &&
          typeof meta["retry_subject"] === "string",
        memberId: (meta["member_id"] as string | null) ?? null,
      });
    }

    const stats = rows.reduce(
      (acc, r) => {
        acc.total += 1;
        if (r.status === "sent") acc.sent += 1;
        else if (r.status === "pending") acc.pending += 1;
        else if (r.status === "suppressed") acc.suppressed += 1;
        else acc.failed += 1;
        return acc;
      },
      { total: 0, sent: 0, failed: 0, pending: 0, suppressed: 0 },
    );

    const status = await getSendingStatus(true);
    const recipients = Array.from(new Set(rows.map((r) => r.recipient.toLowerCase())));
    const { data: sup } = recipients.length
      ? await supabaseAdmin
          .from("suppressed_emails")
          .select("email, reason, created_at")
          .in("email", recipients.slice(0, 200))
      : { data: [] as any[] };

    return {
      domain: {
        name: SENDING_DOMAIN,
        verified: status.verified,
        reason: status.reason ?? null,
        fromAddress: FROM_ADDRESS,
      },
      stats,
      rows,
      suppressed: ((sup ?? []) as any[]).map((s) => ({
        email: s.email as string,
        reason: (s.reason as string) ?? "unknown",
        createdAt: s.created_at as string,
      })),
    } satisfies EmailHealth;
  });

/** Replay a failed send using the exact subject/body we stored at the time. */
export const retryEmailSend = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; logId: string }) => {
    if (!d?.dojoId || !d?.logId) throw new Error("dojoId and logId required");
    return d;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "retryEmailSend");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: row } = await supabaseAdmin
      .from("email_send_log")
      .select("id, template_name, recipient_email, status, metadata")
      .eq("id", data.logId)
      .maybeSingle();
    if (!row) throw new Error("That send is no longer in the log");
    const meta = ((row as any).metadata ?? {}) as Record<string, unknown>;
    // Never let one gym replay another gym's email.
    if (meta["dojo_id"] !== data.dojoId) throw new Error("That send belongs to another gym");
    const subject = meta["retry_subject"];
    const html = meta["retry_html"];
    if (typeof subject !== "string" || typeof html !== "string") {
      throw new Error("This email is too old to retry — send it again from the member's page");
    }

    const { sendAppEmail } = await import("./email-send.server");
    const result = await sendAppEmail({
      dojoId: data.dojoId,
      to: (row as any).recipient_email as string,
      subject,
      html,
      templateName: (row as any).template_name as string,
      marketing: meta["marketing"] === true,
      // New key so the provider does not de-duplicate against the failed attempt.
      idempotencyKey: `retry-${data.logId}-${Date.now()}`,
      memberId: (meta["member_id"] as string | null) ?? null,
      supabase,
      metadata: { retried_from: data.logId, retried_by: userId },
    });
    return {
      ok: result.ok,
      pending: result.ok ? false : result.pending,
      error: result.ok ? null : (result.error ?? null),
      to: (row as any).recipient_email as string,
    };
  });
