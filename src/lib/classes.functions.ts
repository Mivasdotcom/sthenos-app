import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertManager(supabase: any, dojoId: string, userId: string) {
  const { data } = await supabase
    .from("dojo_memberships")
    .select("role")
    .eq("dojo_id", dojoId)
    .eq("user_id", userId)
    .single();
  if (!data || !["owner", "admin"].includes(data.role)) {
    throw new Error("Unauthorized");
  }
}

export type ClassRow = {
  id: string;
  dojo_id: string;
  name: string;
  discipline: "BJJ" | "Judo" | "Karate" | "Muay Thai";
  instructor: string;
  weekday: number; // 0=Mon ... 6=Sun (we store ISO: 0=Sun..6=Sat in postgres? we use 0..6 freely; UI maps it)
  start_time: string; // HH:MM:SS
  end_time: string;
  capacity: number;
};

export const listClasses = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase } = context as any;
    const { data: rows, error } = await supabase
      .from("classes")
      .select("*")
      .eq("dojo_id", data.dojoId)
      .order("weekday", { ascending: true })
      .order("start_time", { ascending: true });
    if (error) throw error;
    return { classes: (rows ?? []) as ClassRow[] };
  });

export const upsertClass = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      id?: string;
      dojoId: string;
      name: string;
      discipline: ClassRow["discipline"];
      instructor: string;
      weekday: number;
      startTime: string; // HH:MM
      endTime: string;
      capacity: number;
    }) => d,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertManager(supabase, data.dojoId, userId);
    if (data.startTime >= data.endTime) {
      throw new Error("End time must be after start time");
    }
    const payload = {
      dojo_id: data.dojoId,
      name: data.name.trim(),
      discipline: data.discipline,
      instructor: data.instructor.trim(),
      weekday: data.weekday,
      start_time: data.startTime,
      end_time: data.endTime,
      capacity: Math.max(1, Math.round(data.capacity)),
    };
    if (data.id) {
      const { data: row, error } = await supabase
        .from("classes")
        .update(payload)
        .eq("id", data.id)
        .select("*")
        .single();
      if (error) throw error;
      return { class: row as ClassRow };
    }
    const { data: row, error } = await supabase
      .from("classes")
      .insert(payload)
      .select("*")
      .single();
    if (error) throw error;
    return { class: row as ClassRow };
  });

export const deleteClass = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    const { data: cls } = await supabase.from("classes").select("dojo_id").eq("id", data.id).single();
    if (!cls) throw new Error("Class not found");
    await assertManager(supabase, cls.dojo_id, userId);
    const { error } = await supabase.from("classes").delete().eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });
