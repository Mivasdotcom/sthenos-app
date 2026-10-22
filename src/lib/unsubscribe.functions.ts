import { createServerFn } from "@tanstack/react-start";

/** Public: validate an unsubscribe token (no auth — recipients aren't logged in). */
export const checkUnsubscribeToken = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string }) => {
    const token = (d?.token ?? "").trim();
    if (!token || token.length > 200) throw new Error("Invalid token");
    return { token };
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("email_unsubscribe_tokens")
      .select("email, used_at")
      .eq("token", data.token)
      .maybeSingle();
    if (!row) return { state: "invalid" as const, email: null };
    if (row.used_at) return { state: "already" as const, email: row.email };
    return { state: "valid" as const, email: row.email };
  });

/** Public: apply the unsubscribe — sets marketing_opt_out on matching members. */
export const confirmUnsubscribe = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string }) => {
    const token = (d?.token ?? "").trim();
    if (!token || token.length > 200) throw new Error("Invalid token");
    return { token };
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("email_unsubscribe_tokens")
      .select("email, used_at")
      .eq("token", data.token)
      .maybeSingle();
    if (!row) return { state: "invalid" as const, email: null };

    const email = row.email as string;
    await supabaseAdmin
      .from("members")
      .update({ marketing_opt_out: true, updated_at: new Date().toISOString() })
      .ilike("email", email);

    await supabaseAdmin
      .from("suppressed_emails")
      .insert({ email, reason: "unsubscribe", metadata: { source: "email_footer" } as any });

    if (!row.used_at) {
      await supabaseAdmin
        .from("email_unsubscribe_tokens")
        .update({ used_at: new Date().toISOString() })
        .eq("token", data.token);
    }

    return { state: "done" as const, email };
  });
