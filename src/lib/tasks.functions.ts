import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertDojoStaff } from "./dojo-access";

export const listTasks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId);
    const { data: rows, error } = await supabase
      .from("internal_tasks")
      .select("*, member:members(name,belt_label,discipline)")
      .eq("dojo_id", data.dojoId)
      .order("status")
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(200);
    if (error) throw error;
    return { tasks: rows ?? [] };
  });

export const setTaskStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; status: "open" | "done" | "dismissed"; dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId);
    const { error } = await supabase
      .from("internal_tasks")
      .update({
        status: data.status,
        completed_at: data.status === "done" ? new Date().toISOString() : null,
      })
      .eq("id", data.id)
      .eq("dojo_id", data.dojoId);
    if (error) throw error;
    return { ok: true };
  });
