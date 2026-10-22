import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";

function supabaseForUser(ctx: ToolContext) {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default defineTool({
  name: "list_members",
  title: "List members",
  description:
    "Lists members of a dojo. Returns name, discipline, belt, status, and last-seen date. RLS scopes results to dojos the caller can access.",
  inputSchema: {
    dojo_id: z.string().uuid().describe("Dojo id (get it from list_my_dojos)."),
    status: z.enum(["active", "paused", "cancelled", "all"]).optional().describe("Filter by member status. Default: active."),
    limit: z.number().int().min(1).max(200).optional().describe("Max rows to return (default 50)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ dojo_id, status, limit }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);
    let q = supabase
      .from("members")
      .select("id, name, discipline, belt_color, belt_label, stripes, status, last_seen_at")
      .eq("dojo_id", dojo_id)
      .order("name", { ascending: true })
      .limit(limit ?? 50);
    const effectiveStatus = status ?? "active";
    if (effectiveStatus !== "all") q = q.eq("status", effectiveStatus);
    const { data, error } = await q;
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? [], null, 2) }],
      structuredContent: { members: data ?? [] },
    };
  },
});
