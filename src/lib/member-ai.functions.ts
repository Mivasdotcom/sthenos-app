import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertDojoMember } from "./dojo-access";

const beltRank: Record<string, number> = {
  white: 0, yellow: 1, orange: 2, green: 3, blue: 4, purple: 5, brown: 6, red: 7, black: 8,
};

const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ───────────── Smart Class Recommendations ─────────────

export const getClassRecommendations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoMember(supabase, userId, data.dojoId);

    const meRes = await supabase
      .from("members")
      .select("id,discipline,belt_color,belt_label")
      .eq("user_id", userId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    const me = meRes.data;
    if (!me) return { me: null, recommendations: [] as any[], reason: "No member profile linked." };

    const [classRes, attRes] = await Promise.all([
      supabase
        .from("classes")
        .select("id,name,discipline,instructor,weekday,start_time,end_time,capacity")
        .eq("dojo_id", data.dojoId),
      supabase
        .from("attendances")
        .select("class_id,checked_in_at")
        .eq("dojo_id", data.dojoId)
        .eq("member_id", me.id),
    ]);
    const classes = (classRes.data ?? []) as any[];
    const attendances = (attRes.data ?? []) as any[];

    const day = 86400000;
    const now = Date.now();
    const cutoff60 = now - 60 * day;

    // Attendance signals
    const visitsByClass = new Map<string, number>();
    const visitsByWeekday = new Array(7).fill(0);
    let recentVisits = 0;
    attendances.forEach((a) => {
      const t = new Date(a.checked_in_at).getTime();
      if (a.class_id) visitsByClass.set(a.class_id, (visitsByClass.get(a.class_id) ?? 0) + 1);
      const wd = new Date(a.checked_in_at).getDay();
      visitsByWeekday[wd] += 1;
      if (t >= cutoff60) recentVisits += 1;
    });
    const trainedWeekdays = new Set(visitsByWeekday.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0));

    const ranked = classes
      .filter((c) => c.discipline === me.discipline)
      .map((c) => {
        let score = 0;
        const reasons: string[] = [];

        // Familiarity bonus — but capped, we want to push variety
        const visited = visitsByClass.get(c.id) ?? 0;
        if (visited > 0 && visited < 4) {
          score += 15;
          reasons.push("you've trained here before");
        } else if (visited === 0) {
          score += 18;
          reasons.push("new class to try");
        }

        // Weekday gap-filling: prefer days you don't already train
        if (!trainedWeekdays.has(c.weekday)) {
          score += 25;
          reasons.push(`fills your ${weekdayLabels[c.weekday]} gap`);
        } else {
          score += 8;
        }

        // Recent activity floor — if you've been quiet, prioritise lower-intensity / morning classes
        if (recentVisits < 4) {
          const hour = parseInt(String(c.start_time).slice(0, 2), 10);
          if (hour < 12) {
            score += 10;
            reasons.push("gentle re-entry — morning class");
          }
        }

        // Discipline match (already filtered, small floor)
        score += 5;

        return {
          id: c.id,
          name: c.name,
          discipline: c.discipline,
          instructor: c.instructor,
          weekday: weekdayLabels[c.weekday],
          weekdayIndex: c.weekday,
          startTime: String(c.start_time).slice(0, 5),
          endTime: String(c.end_time).slice(0, 5),
          capacity: c.capacity,
          score,
          reasons,
          previousVisits: visited,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    return {
      me: { id: me.id, discipline: me.discipline, belt: { color: me.belt_color, label: me.belt_label } },
      recommendations: ranked,
      generatedAt: new Date().toISOString(),
    };
  });

// ───────────── Peer Training Matcher (opt-in only) ─────────────
//
// Privacy rules, enforced here:
//  - the gym can disable the feature entirely (dojos.partner_matching_enabled),
//  - a member sees nobody unless they themselves opted in,
//  - only members who opted in are ever returned,
//  - nothing that reveals WHEN another member trains is returned or computed
//    (no last_seen_at, no attendance, no shared-class overlap).

export const setPartnerMatching = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; optIn: boolean }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoMember(supabase, userId, data.dojoId);
    const meRes = await supabase
      .from("members")
      .select("id")
      .eq("user_id", userId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (!meRes.data) throw new Error("No member profile linked.");
    const { error } = await supabase.rpc("set_my_partner_matching", {
      p_member_id: meRes.data.id,
      p_opt_in: data.optIn,
    });
    if (error) throw new Error(error.message);
    return { optedIn: data.optIn };
  });

export const getPeerMatches = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoMember(supabase, userId, data.dojoId);

    const dojoRes = await supabase
      .from("dojos")
      .select("partner_matching_enabled")
      .eq("id", data.dojoId)
      .maybeSingle();
    const featureEnabled = dojoRes.data?.partner_matching_enabled !== false;

    const meRes = await supabase
      .from("members")
      .select("id,discipline,belt_color,belt_label,partner_matching_opt_in")
      .eq("user_id", userId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    const me = meRes.data;

    const base = {
      featureEnabled,
      optedIn: !!me?.partner_matching_opt_in,
      me: me
        ? { id: me.id, discipline: me.discipline, belt: { color: me.belt_color, label: me.belt_label } }
        : null,
      peers: [] as any[],
      generatedAt: new Date().toISOString(),
    };

    if (!featureEnabled || !me || !me.partner_matching_opt_in) return base;

    const othersRes = await supabase
      .from("members")
      .select("id,name,discipline,belt_color,belt_label,stripes")
      .eq("dojo_id", data.dojoId)
      .eq("status", "active")
      .eq("partner_matching_opt_in", true)
      .neq("id", me.id);
    const others = (othersRes.data ?? []) as any[];

    const myRank = beltRank[me.belt_color] ?? 0;

    const peers = others
      .filter((o) => o.discipline === me.discipline)
      .map((o) => {
        const beltDelta = Math.abs((beltRank[o.belt_color] ?? 0) - myRank);
        const score = beltDelta === 0 ? 40 : beltDelta === 1 ? 28 : 12;
        return {
          id: o.id,
          name: o.name,
          belt: { color: o.belt_color, label: o.belt_label, stripes: o.stripes ?? 0 },
          discipline: o.discipline,
          beltDelta,
          score,
        };
      })
      .filter((p) => p.beltDelta <= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    return { ...base, peers };
  });


