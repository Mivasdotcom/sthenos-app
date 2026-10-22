import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function supabaseForUser(ctx: ToolContext) {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default defineTool({
  name: "list_classes",
  title: "List classes",
  description: "Lists the weekly class schedule for a dojo (name, discipline, instructor, weekday, start/end).",
  inputSchema: {
    dojo_id: z.string().uuid().describe("Dojo id."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ dojo_id }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);
    const { data, error } = await supabase
      .from("classes")
      .select("id, name, discipline, instructor, weekday, start_time, end_time, capacity")
      .eq("dojo_id", dojo_id)
      .order("weekday", { ascending: true })
      .order("start_time", { ascending: true });
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    const rows = (data ?? [])
      .map((c: any) => ({
        ...c,
        weekday_label: WEEKDAYS[c.weekday] ?? String(c.weekday),
      }))
      // Monday-first ordering (UK/European convention).
      .sort(
        (a: any, b: any) =>
          ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7) ||
          String(a.start_time).localeCompare(String(b.start_time)),
      );

    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      structuredContent: { classes: rows },
    };
  },
});
