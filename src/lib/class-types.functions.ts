import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type Discipline = "BJJ" | "Judo" | "Karate" | "Muay Thai";

export type ClassType = {
  id: string;
  dojo_id: string;
  name: string;
  discipline: Discipline;
  sort_order: number;
};

export const listClassTypes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase } = context as any;
    const { data: rows, error } = await supabase
      .from("dojo_class_types")
      .select("*")
      .eq("dojo_id", data.dojoId)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });
    if (error) throw error;
    return { types: (rows ?? []) as ClassType[] };
  });

export const upsertClassType = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      id?: string;
      dojoId: string;
      name: string;
      discipline: Discipline;
      sortOrder?: number;
    }) => d,
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context as any;
    const payload = {
      dojo_id: data.dojoId,
      name: data.name.trim(),
      discipline: data.discipline,
      sort_order: data.sortOrder ?? 0,
    };
    if (!payload.name) throw new Error("Name is required");
    if (data.id) {
      const { data: row, error } = await supabase
        .from("dojo_class_types")
        .update(payload)
        .eq("id", data.id)
        .select("*")
        .single();
      if (error) throw error;
      return { type: row as ClassType };
    }
    const { data: row, error } = await supabase
      .from("dojo_class_types")
      .insert(payload)
      .select("*")
      .single();
    if (error) throw error;
    return { type: row as ClassType };
  });

export const deleteClassType = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase } = context as any;
    const { error } = await supabase
      .from("dojo_class_types")
      .delete()
      .eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });
