import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertDojoStaff } from "./dojo-access";

export const listConversations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => {
    if (!d?.dojoId) throw new Error("dojoId required");
    return d;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "listConversations");

    const { data: convs, error } = await supabase
      .from("conversations")
      .select("id, member_id, last_message_at, created_at, members:member_id (id, name, email)")
      .eq("dojo_id", data.dojoId)
      .order("last_message_at", { ascending: false, nullsFirst: false });
    if (error) throw error;

    const ids = (convs ?? []).map((c: any) => c.id);
    let previews: Record<string, { body: string; created_at: string }> = {};
    let unread: Record<string, number> = {};
    if (ids.length) {
      const { data: msgs } = await supabase
        .from("messages")
        .select("conversation_id, body, created_at, sender_type, read_at")
        .in("conversation_id", ids)
        .order("created_at", { ascending: false });
      for (const m of msgs ?? []) {
        if (!previews[m.conversation_id]) {
          previews[m.conversation_id] = { body: m.body, created_at: m.created_at };
        }
        if (m.sender_type === "member" && !m.read_at) {
          unread[m.conversation_id] = (unread[m.conversation_id] ?? 0) + 1;
        }
      }
    }

    return {
      conversations: (convs ?? []).map((c: any) => ({
        id: c.id,
        memberId: c.member_id,
        memberName: c.members?.name ?? "Member",
        memberEmail: c.members?.email ?? null,
        lastMessageAt: c.last_message_at,
        preview: previews[c.id]?.body ?? null,
        unread: unread[c.id] ?? 0,
      })),
    };
  });

export const unreadConversationsCount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => {
    if (!d?.dojoId) throw new Error("dojoId required");
    return d;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    const { callerRole } = await import("./communications.server");
    const role = await callerRole(supabase, userId, data.dojoId);
    let q = supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("dojo_id", data.dojoId)
      .is("read_at", null);
    if (role === "staff") {
      q = q.eq("sender_type", "member");
    } else {
      q = q.eq("sender_type", "staff");
      const { data: me } = await supabase
        .from("members")
        .select("id")
        .eq("dojo_id", data.dojoId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!me?.id) return { unread: 0 };
      q = q.eq("member_id", me.id);
    }
    const { count } = await q;
    return { unread: count ?? 0 };
  });

export const getConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberId: string }) => {
    if (!d?.dojoId || !d?.memberId) throw new Error("dojoId and memberId required");
    return d;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    const { callerRole, ensureConversation } = await import("./communications.server");
    const role = await callerRole(supabase, userId, data.dojoId);

    // Members can only access their own conversation.
    if (role === "member") {
      const { data: me } = await supabase
        .from("members")
        .select("id")
        .eq("dojo_id", data.dojoId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!me?.id || me.id !== data.memberId) {
        throw new Error("Not allowed");
      }
    }

    const conversationId = await ensureConversation(supabase, data.dojoId, data.memberId);

    const { data: msgs, error } = await supabase
      .from("messages")
      .select("id, sender_type, sender_user_id, channel, body, created_at, read_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    if (error) throw error;

    const { data: memberRow } = await supabase
      .from("members")
      .select("id, name, email")
      .eq("id", data.memberId)
      .maybeSingle();

    const senderIds = Array.from(
      new Set((msgs ?? []).map((m: any) => m.sender_user_id).filter(Boolean)),
    ) as string[];
    const senderNames = new Map<string, string>();
    if (senderIds.length) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("user_id,display_name")
        .in("user_id", senderIds);
      for (const profile of profiles ?? []) {
        if (profile.display_name) senderNames.set(profile.user_id, profile.display_name);
      }
    }

    // Mark incoming messages as read for the caller.
    const incomingType = role === "staff" ? "member" : "staff";
    await supabase
      .from("messages")
      .update({ read_at: new Date().toISOString() })
      .eq("conversation_id", conversationId)
      .eq("sender_type", incomingType)
      .is("read_at", null);

    return {
      conversationId,
      member: memberRow
        ? { id: memberRow.id, name: memberRow.name, email: memberRow.email }
        : null,
      messages: (msgs ?? []).map((m: any) => ({
        id: m.id,
        senderType: m.sender_type as "staff" | "member",
        senderUserId: m.sender_user_id,
        senderName: m.sender_user_id ? senderNames.get(m.sender_user_id) ?? null : null,
        channel: m.channel as "in_app" | "email" | "sms",
        body: m.body,
        createdAt: m.created_at,
        readAt: m.read_at,
      })),
    };
  });

export const sendMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { dojoId: string; memberId: string; body: string; channel?: "in_app" | "email" | "sms"; retentionOutreach?: boolean }) => {
      if (!d?.dojoId || !d?.memberId) throw new Error("dojoId and memberId required");
      const body = (d.body ?? "").trim();
      if (!body) throw new Error("Message body is required");
      if (body.length > 5000) throw new Error("Message too long (5000 max)");
      const channel = d.channel ?? "in_app";
      if (!["in_app", "email", "sms"].includes(channel)) throw new Error("Invalid channel");
      return { dojoId: d.dojoId, memberId: d.memberId, body, channel, retentionOutreach: d.retentionOutreach === true };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    const { callerRole, deliverStaffEmail, ensureConversation, recordRetentionContact } = await import(
      "./communications.server"
    );
    const role = await callerRole(supabase, userId, data.dojoId);

    if (role === "member") {
      const { data: me } = await supabase
        .from("members")
        .select("id")
        .eq("dojo_id", data.dojoId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!me?.id || me.id !== data.memberId) throw new Error("Not allowed");
      // Members can only use in_app.
      if (data.channel !== "in_app") throw new Error("Members can only send in-app messages");
    }

    if (data.channel === "sms") {
      throw new Error("SMS delivery is not yet available");
    }

    const conversationId = await ensureConversation(supabase, data.dojoId, data.memberId);

    const { data: inserted, error } = await supabase
      .from("messages")
      .insert({
        conversation_id: conversationId,
        dojo_id: data.dojoId,
        member_id: data.memberId,
        sender_type: role,
        sender_user_id: userId,
        channel: data.channel,
        body: data.body,
      })
      .select("id, created_at")
      .single();
    if (error) throw error;

    await supabase
      .from("conversations")
      .update({ last_message_at: inserted.created_at })
      .eq("id", conversationId);

    let deliveryNotice: string | null = null;

    if (data.channel === "email" && role === "staff") {
      const delivery = await deliverStaffEmail({
        supabase,
        dojoId: data.dojoId,
        memberId: data.memberId,
        messageId: inserted.id,
        conversationId,
        body: data.body,
        retentionOutreach: data.retentionOutreach,
      });
      deliveryNotice = delivery.notice;
      if (delivery.delivered) {
        await recordRetentionContact({
          supabase,
          dojoId: data.dojoId,
          memberId: data.memberId,
          body: data.body,
          contactedAt: inserted.created_at,
          createIfMissing: data.retentionOutreach,
          contactedBy: userId,
        });
      }
    }

    return {
      messageId: inserted.id,
      conversationId,
      deliveryNotice,
    };
  });
