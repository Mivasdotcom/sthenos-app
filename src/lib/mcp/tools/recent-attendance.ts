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
  name: "recent_attendance",
  title: "Recent attendance",
  description:
    "Returns recent check-ins for a dojo (most recent first) with member name and class. Useful for summarising activity over the last few days/weeks.",
  inputSchema: {
    dojo_id: z.string().uuid().describe("Dojo id."),
    days: z.number().int().min(1).max(90).optional().describe("Look back this many days (default 14, max 90)."),
    limit: z.number().int().min(1).max(500).optional().describe("Max rows (default 100)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ dojo_id, days, limit }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);
    const since = new Date(Date.now() - (days ?? 14) * 86400_000).toISOString();
    const { data, error } = await supabase
      .from("attendances")
      .select("checked_in_at, member_id, class_id, members(name), classes(name)")
      .eq("dojo_id", dojo_id)
      .gte("checked_in_at", since)
      .order("checked_in_at", { ascending: false })
      .limit(limit ?? 100);
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    const rows = (data ?? []).map((a: any) => ({
      checked_in_at: a.checked_in_at,
      member: a.members?.name ?? null,
      class: a.classes?.name ?? null,
      member_id: a.member_id,
      class_id: a.class_id,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      structuredContent: { attendance: rows, since },
    };
  },
});
