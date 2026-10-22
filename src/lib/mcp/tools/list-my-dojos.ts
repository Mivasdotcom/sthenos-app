import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";

function supabaseForUser(ctx: ToolContext) {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default defineTool({
  name: "list_my_dojos",
  title: "List my dojos",
  description: "Lists the dojos the signed-in user belongs to, with their role in each.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (_input, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);
    const { data, error } = await supabase
      .from("dojo_memberships")
      .select("role, dojo_id, dojos(id, name)")
      .eq("user_id", ctx.getUserId());
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    const rows = (data ?? []).map((r: any) => ({
      dojo_id: r.dojo_id,
      name: r.dojos?.name ?? null,
      role: r.role,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      structuredContent: { dojos: rows },
    };
  },
});
