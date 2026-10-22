import { createServerFn } from "@tanstack/react-start";

async function assertDojoPublic(dojoId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: dojo } = await supabaseAdmin
    .from("dojos")
    .select("id, public_page_enabled")
    .eq("id", dojoId)
    .maybeSingle();
  if (!dojo?.public_page_enabled) throw new Error("Not found");
}

export type TodayClass = {
  id: string;
  name: string;
  discipline: string | null;
  instructor: string | null;
  start_time: string;
  end_time: string;
  capacity: number | null;
  booked_today: number;
  spots_left: number | null;
};

export const getTodayClasses = createServerFn({ method: "GET" })
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data }): Promise<{ classes: TodayClass[]; weekday: number }> => {
    await assertDojoPublic(data.dojoId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // classes.weekday uses JS getDay convention: 0=Sun..6=Sat
    const now = new Date();
    const weekday = now.getDay();

    const { data: classes, error } = await supabaseAdmin
      .from("classes")
      .select("id, name, discipline, instructor, start_time, end_time, capacity")
      .eq("dojo_id", data.dojoId)
      .eq("weekday", weekday)
      .order("start_time", { ascending: true });
    if (error) throw error;

    const list = (classes ?? []) as any[];
    if (list.length === 0) return { classes: [], weekday };

    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const today = dayStart.toISOString().slice(0, 10);

    const ids = list.map((c) => c.id);
    const { data: bookings } = await supabaseAdmin
      .from("class_bookings")
      .select("class_id")
      .in("class_id", ids)
      .eq("booked_for_date", today)
      .in("status", ["booked", "attended"]);

    const counts = new Map<string, number>();
    for (const b of (bookings ?? []) as any[]) {
      counts.set(b.class_id, (counts.get(b.class_id) ?? 0) + 1);
    }


    return {
      weekday,
      classes: list.map((c) => {
        const booked = counts.get(c.id) ?? 0;
        return {
          id: c.id,
          name: c.name,
          discipline: c.discipline,
          instructor: c.instructor,
          start_time: c.start_time,
          end_time: c.end_time,
          capacity: c.capacity,
          booked_today: booked,
          spots_left: c.capacity == null ? null : Math.max(0, c.capacity - booked),
        };
      }),
    };
  });

export const bookFirstClass = createServerFn({ method: "POST" })
  .inputValidator((d: { dojoId: string; classId: string; memberId: string }) => d)
  .handler(async ({ data }) => {
    await assertDojoPublic(data.dojoId);
    const { enforceRateLimit } = await import("@/lib/rate-limit.server");
    await enforceRateLimit({ endpoint: "book_class", dojoId: data.dojoId });
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");


    const [{ data: member }, { data: klass }] = await Promise.all([
      supabaseAdmin
        .from("members")
        .select("id, dojo_id")
        .eq("id", data.memberId)
        .maybeSingle(),
      supabaseAdmin
        .from("classes")
        .select("id, dojo_id, capacity")
        .eq("id", data.classId)
        .maybeSingle(),
    ]);
    if (!member || member.dojo_id !== data.dojoId) throw new Error("Member not found");
    if (!klass || klass.dojo_id !== data.dojoId) throw new Error("Class not found");

    // Today's date in ISO (YYYY-MM-DD)
    const today = new Date().toISOString().slice(0, 10);

    // Server-side capacity check
    if (klass.capacity != null) {
      const { count, error: countErr } = await supabaseAdmin
        .from("class_bookings")
        .select("id", { count: "exact", head: true })
        .eq("class_id", data.classId)
        .eq("booked_for_date", today)
        .in("status", ["booked", "attended"]);
      if (countErr) throw countErr;
      if ((count ?? 0) >= klass.capacity) {
        throw new Error("Sorry, this class is fully booked.");
      }
    }

    const { error } = await supabaseAdmin.from("class_bookings").insert({
      dojo_id: data.dojoId,
      class_id: data.classId,
      member_id: data.memberId,
      booked_for_date: today,
      status: "booked",
    });
    if (error) {
      if ((error as any).code === "23505") {
        // Already booked for this class today — treat as success
        return { ok: true, alreadyBooked: true };
      }
      throw error;
    }
    return { ok: true };
  });

