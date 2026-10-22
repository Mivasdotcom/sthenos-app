import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { evaluateAudienceInternal } from "./audience.functions";
import { assertDojoStaff } from "./dojo-access";
import { personalize } from "./marketing-personalize";
import type { AudienceFilter } from "./audience";


export const listBroadcasts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId);
    const { data: rows, error } = await supabase
      .from("marketing_broadcasts")
      .select("*")
      .eq("dojo_id", data.dojoId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    return { broadcasts: rows ?? [] };
  });

export const sendBroadcast = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      dojoId: string;
      name: string;
      subject: string;
      body_html: string;
      from_name?: string;
      segment_id?: string;
      filter?: AudienceFilter;
    }) => d,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId);

    const { sendAppEmail, resolveSenderIdentity, PENDING_MESSAGE } = await import("./email-send.server");
    const identity = await resolveSenderIdentity(supabase, data.dojoId);
    const sender = data.from_name ? { ...identity, fromName: data.from_name } : identity;

    // Resolve the audience filter — segment_id wins if provided.
    let filter: AudienceFilter = data.filter ?? {};
    if (data.segment_id) {
      const { data: seg, error } = await supabase
        .from("segments")
        .select("filter")
        .eq("id", data.segment_id)
        .eq("dojo_id", data.dojoId)
        .single();
      if (error) throw error;
      filter = (seg.filter ?? {}) as AudienceFilter;
    }
    // Marketing ALWAYS excludes opt-outs.
    filter = { ...filter, exclude_marketing_opt_out: true };

    const audience = await evaluateAudienceInternal(supabase, filter);
    const targets = audience.filter((m) => !!m.email);

    const { data: broadcast, error: bErr } = await supabase
      .from("marketing_broadcasts")
      .insert({
        dojo_id: data.dojoId,
        name: data.name,
        subject: data.subject,
        body_html: data.body_html,
        from_name: data.from_name ?? null,
        segment_id: data.segment_id ?? null,
        filter_snapshot: filter,
        recipient_count: targets.length,
        status: "sending",
        created_by: userId,
      })
      .select("id")
      .single();
    if (bErr) throw bErr;

    let sent = 0;
    let failed = 0;
    let pending = 0;
    let lastError: string | null = null;
    for (const m of targets) {
      // Same helper the Marketing page preview uses, so what staff previewed is
      // exactly what the recipient receives — subject included.
      const target = { name: m.name, discipline: m.discipline, belt: m.belt_label };
      const personalizedHtml = personalize(data.body_html, target);
      const personalizedSubject = personalize(data.subject, target);
      const r = await sendAppEmail({
        dojoId: data.dojoId,
        to: m.email!,
        subject: personalizedSubject,
        html: personalizedHtml,

        templateName: "marketing-broadcast",
        idempotencyKey: `broadcast:${broadcast.id}:${m.id}`,

        marketing: true,
        sender,
        memberId: m.id,
        metadata: { broadcast_id: broadcast.id },
      });
      if (r.ok) sent++;
      else {
        failed++;
        if (r.pending) pending++;
        lastError = r.error;
      }
    }

    const status = failed === 0 && sent > 0 ? "sent" : sent === 0 ? "failed" : "sent";
    const pendingVerification = pending > 0 && sent === 0;
    await supabase
      .from("marketing_broadcasts")
      .update({
        sent_count: sent,
        failed_count: failed,
        status,
        sent_at: new Date().toISOString(),
        error: lastError,
      })
      .eq("id", broadcast.id);

    return {
      id: broadcast.id,
      recipients: targets.length,
      sent,
      failed,
      pending,
      pendingVerification,
      error: pendingVerification ? PENDING_MESSAGE : lastError,
    };
  });
