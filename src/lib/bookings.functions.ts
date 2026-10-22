import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertDojoStaff } from "@/lib/dojo-access";

/**
 * How long before a class starts a member may still cancel their own place.
 * Staff are not bound by it -- they can cancel a booking at any time.
 *
 * A single constant today. If gyms ever want their own notice period this
 * becomes a column on `dojos` and the reads below take it from there.
 */
export const CANCEL_CUTOFF_HOURS = 2;

/** Milliseconds `timeZone` is ahead of UTC at the given instant. */
function tzOffsetMs(timeZone: string, at: Date): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const p: Record<string, string> = {};
    for (const part of fmt.formatToParts(at)) p[part.type] = part.value;
    const asUtc = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour) % 24,
      Number(p.minute),
      Number(p.second),
    );
    return asUtc - at.getTime();
  } catch {
    return 0;
  }
}

/**
 * The real instant a class starts.
 *
 * A booking stores a plain calendar date and the class stores a local clock
 * time, neither of which carries a timezone. The cutoff has to be measured in
 * the GYM'S timezone: Cyprus runs UTC+3 in summer, so reading these as UTC
 * would move every cutoff three hours and let members cancel after the class
 * had already started.
 */
function classStartMs(timezone: string, dateIso: string, startTime: string): number {
  const [y, m, d] = dateIso.slice(0, 10).split("-").map(Number);
  const [hh, mm] = String(startTime).slice(0, 5).split(":").map(Number);
  const naive = Date.UTC(y || 1970, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0);
  // Measure the offset at the naive instant, then once more at the corrected
  // one, so a class sitting on a daylight-saving change lands the right side.
  const firstPass = naive - tzOffsetMs(timezone, new Date(naive));
  return naive - tzOffsetMs(timezone, new Date(firstPass));
}

/**
 * Record the attendance a booking stands for, stamped at the CLASS'S start
 * time rather than whenever someone happened to tap a screen.
 *
 * Deliberately does NOT move a trial member's first-charge date. These are
 * presumed attendances -- a booking the coach hasn't marked absent -- and a
 * charge date should never shift on a presumption. A coach who forgets to
 * untick a no-show would otherwise move a real member's billing on the
 * strength of a class they skipped. Charge dates still follow genuine
 * check-ins made at the desk.
 */
async function recordAttendanceForBooking(
  db: any,
  args: {
    dojoId: string;
    bookingId: string;
    memberId: string;
    classId: string;
    date: string;
    startTime: string;
    timezone: string;
  },
) {
  const at = new Date(classStartMs(args.timezone, args.date, args.startTime)).toISOString();

  // Already recorded for this booking.
  const { data: mine } = await db
    .from("attendances")
    .select("id")
    .eq("booking_id", args.bookingId)
    .maybeSingle();
  if (mine) return;

  // A member checked in at the desk for this same class has an attendance
  // already -- from before bookings carried one. Adopt that row rather than
  // adding a second, or the old check-ins would each be counted twice.
  const dayStart = new Date(classStartMs(args.timezone, args.date, "00:00")).toISOString();
  const dayEnd = new Date(
    classStartMs(args.timezone, args.date, "00:00") + 86400000,
  ).toISOString();
  const { data: existing } = await db
    .from("attendances")
    .select("id")
    .eq("dojo_id", args.dojoId)
    .eq("member_id", args.memberId)
    .eq("class_id", args.classId)
    .is("booking_id", null)
    .gte("checked_in_at", dayStart)
    .lt("checked_in_at", dayEnd)
    .limit(1)
    .maybeSingle();
  if (existing) {
    await db.from("attendances").update({ booking_id: args.bookingId }).eq("id", existing.id);
    return;
  }

  // The unique index on booking_id is PARTIAL (booking_id is not null), so a
  // plain `on conflict (booking_id)` upsert is rejected by Postgres outright --
  // which is what made every tick fail. Insert, and treat a duplicate as the
  // success it is.
  const { error } = await db.from("attendances").insert({
    booking_id: args.bookingId,
    member_id: args.memberId,
    dojo_id: args.dojoId,
    class_id: args.classId,
    checked_in_at: at,
  });
  if (error && (error as any).code !== "23505") throw error;

  // Keep last_seen_at moving forward only -- confirming an old class must not
  // make a regular look lapsed.
  const { data: m } = await db
    .from("members")
    .select("last_seen_at")
    .eq("id", args.memberId)
    .maybeSingle();
  if (!m?.last_seen_at || new Date(m.last_seen_at) < new Date(at)) {
    await db.from("members").update({ last_seen_at: at }).eq("id", args.memberId);
  }
}

async function gymTimezone(db: any, dojoId: string): Promise<string> {
  const { data } = await db.from("dojos").select("timezone").eq("id", dojoId).maybeSingle();
  return (data as any)?.timezone || "UTC";
}

/**
 * A class that has finished counts everyone who booked it as having attended.
 *
 * This used to do the opposite: every booking nobody had checked in was
 * marked NO-SHOW, and no-shows feed the retention risk score. At a gym whose
 * coach runs the mats rather than a tablet, that recorded the whole of opening
 * night as absent and flagged paying members as likely to leave. Absence is
 * now the exception a coach marks, not the default a sweep assumes.
 *
 * Staff-only. Scoped to dojo. Idempotent.
 */
export const confirmPastBookings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertDojoStaff(supabase, userId, data.dojoId, "confirmPastBookings");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const timezone = await gymTimezone(supabaseAdmin, data.dojoId);

    const { data: rows, error } = await supabaseAdmin
      .from("class_bookings")
      .select("id, member_id, class_id, booked_for_date, classes:class_id(start_time, end_time)")
      .eq("dojo_id", data.dojoId)
      // 'attended' as well as 'booked': an earlier version flipped the status
      // and then failed to write the attendance, leaving bookings that say
      // attended with nothing behind them. Re-running heals those rather than
      // skipping them forever.
      .in("status", ["booked", "attended"]);
    if (error) throw error;

    const now = Date.now();
    const finished = ((rows ?? []) as any[]).filter((b) => {
      const end = b.classes?.end_time ?? b.classes?.start_time;
      return end && classStartMs(timezone, b.booked_for_date, end) < now;
    });

    for (const b of finished) {
      const { error: updErr } = await supabaseAdmin
        .from("class_bookings")
        .update({ status: "attended", updated_at: new Date().toISOString() })
        .eq("id", b.id)
        .eq("status", "booked");
      if (updErr) throw updErr;
      await recordAttendanceForBooking(supabaseAdmin, {
        dojoId: data.dojoId,
        bookingId: b.id,
        memberId: b.member_id,
        classId: b.class_id,
        date: b.booked_for_date,
        startTime: b.classes.start_time,
        timezone,
      });
    }

    const memberIds = Array.from(new Set(finished.map((r) => r.member_id)));
    if (memberIds.length) {
      try {
        const { recomputeRetentionForDojo } = await import("./retention.functions");
        await recomputeRetentionForDojo(supabaseAdmin, data.dojoId, memberIds);
      } catch (e) {
        console.error("[confirmPastBookings] retention recompute failed", e);
      }
    }
    return { updated: finished.length };
  });

export type SessionBooking = {
  bookingId: string;
  memberId: string;
  name: string;
  status: "booked" | "attended" | "no_show" | "cancelled";
};

export type ClassSession = {
  classId: string;
  name: string;
  startTime: string;
  endTime: string;
  capacity: number | null;
  // Begun: from here on the coach marks who came. Before it, the list is who
  // is booked, and staff can still take someone off it.
  started: boolean;
  finished: boolean;
  bookings: SessionBooking[];
};

/** Every class on a given day, with who booked it. Staff-only. */
export const getClassSessions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; date: string }) => d)
  .handler(async ({ data, context }): Promise<ClassSession[]> => {
    const { supabase, userId } = context;
    await assertDojoStaff(supabase, userId, data.dojoId, "getClassSessions");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const timezone = await gymTimezone(supabaseAdmin, data.dojoId);

    const weekday = new Date(`${data.date}T12:00:00Z`).getUTCDay();
    const { data: classes, error: cErr } = await supabaseAdmin
      .from("classes")
      .select("id, name, start_time, end_time, capacity")
      .eq("dojo_id", data.dojoId)
      .eq("weekday", weekday)
      .order("start_time");
    if (cErr) throw cErr;

    const ids = ((classes ?? []) as any[]).map((c) => c.id);
    const { data: bookings, error: bErr } = ids.length
      ? await supabaseAdmin
          .from("class_bookings")
          .select("id, class_id, member_id, status, members:member_id(name)")
          .eq("dojo_id", data.dojoId)
          .eq("booked_for_date", data.date)
          .in("class_id", ids)
      : { data: [], error: null };
    if (bErr) throw bErr;

    const now = Date.now();
    return ((classes ?? []) as any[]).map((c) => ({
      classId: c.id,
      name: c.name,
      startTime: c.start_time,
      endTime: c.end_time,
      capacity: c.capacity ?? null,
      started: classStartMs(timezone, data.date, c.start_time) < now,
      finished: classStartMs(timezone, data.date, c.end_time ?? c.start_time) < now,
      bookings: ((bookings ?? []) as any[])
        .filter((b) => b.class_id === c.id)
        .map((b) => ({
          bookingId: b.id,
          memberId: b.member_id,
          name: b.members?.name ?? "Member",
          status: b.status,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
  });

/**
 * A coach marking one booking as attended or absent. Unticking removes the
 * attendance the booking stood for, so a no-show no longer counts anywhere.
 */
export const setBookingAttendance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; bookingId: string; attended: boolean }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertDojoStaff(supabase, userId, data.dojoId, "setBookingAttendance");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: b, error } = await supabaseAdmin
      .from("class_bookings")
      .select("id, member_id, class_id, booked_for_date, status, classes:class_id(start_time)")
      .eq("id", data.bookingId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (error) throw error;
    if (!b) throw new Error("That booking no longer exists.");
    if ((b as any).status === "cancelled") {
      throw new Error("They cancelled this booking, so there's nothing to mark.");
    }

    if (data.attended) {
      await supabaseAdmin
        .from("class_bookings")
        .update({ status: "attended", updated_at: new Date().toISOString() })
        .eq("id", b.id);
      await recordAttendanceForBooking(supabaseAdmin, {
        dojoId: data.dojoId,
        bookingId: b.id,
        memberId: (b as any).member_id,
        classId: (b as any).class_id,
        date: (b as any).booked_for_date,
        startTime: (b as any).classes?.start_time ?? "00:00",
        timezone: await gymTimezone(supabaseAdmin, data.dojoId),
      });
    } else {
      // A booking's attendance is one of two things. Either it was created
      // from the booking itself -- stamped at the class's exact start minute --
      // or it was a real check-in at the desk that the booking later adopted,
      // stamped whenever someone tapped the screen. Only the first is ours to
      // remove. Deleting the second would destroy the one piece of evidence
      // that the member physically turned up, on the strength of an untick.
      const timezone = await gymTimezone(supabaseAdmin, data.dojoId);
      const createdFromBookingAt = classStartMs(
        timezone,
        (b as any).booked_for_date,
        (b as any).classes?.start_time ?? "00:00",
      );
      const { data: att } = await supabaseAdmin
        .from("attendances")
        .select("id, checked_in_at")
        .eq("booking_id", b.id)
        .maybeSingle();

      if (att && Date.parse(att.checked_in_at) !== createdFromBookingAt) {
        const when = new Intl.DateTimeFormat("en-GB", {
          timeZone: timezone,
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(att.checked_in_at));
        // Refuse BEFORE touching anything, so a refusal leaves both records
        // exactly as they were.
        throw new Error(
          `They checked in at the desk at ${when}, so they were here. If that check-in was a mistake, correct it on the check-in screen.`,
        );
      }

      await supabaseAdmin
        .from("class_bookings")
        .update({ status: "no_show", updated_at: new Date().toISOString() })
        .eq("id", b.id);
      if (att) await supabaseAdmin.from("attendances").delete().eq("id", att.id);
    }

    try {
      const { recomputeRetentionForDojo } = await import("./retention.functions");
      await recomputeRetentionForDojo(supabaseAdmin, data.dojoId, [(b as any).member_id]);
    } catch (e) {
      console.error("[setBookingAttendance] retention recompute failed", e);
    }
    return { ok: true };
  });

export type WeekClass = {
  id: string;
  name: string;
  discipline: string | null;
  instructor: string | null;
  weekday: number;
  start_time: string;
  end_time: string;
  capacity: number | null;
  booked_for_date: string;
  booked_count: number;
  spots_left: number | null;
  my_booking_id: string | null;
  my_status: "booked" | "attended" | "no_show" | null;
};

/**
 * List this week's classes (from today through +6 days) for a member with
 * per-occurrence booking counts and the member's own booking status.
 */
export const getWeekClassesForMe = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberId?: string | null }) => d)
  .handler(async ({ data, context }): Promise<WeekClass[]> => {
    const { supabase, userId } = context;

    // Whoever the caller is acting for: themselves, or a child they manage.
    const { resolveActingMember } = await import("@/lib/managed-members.server");
    const { supabaseAdmin: adminForMember } = await import(
      "@/integrations/supabase/client.server"
    );
    const me = await resolveActingMember({
      db: adminForMember,
      userId,
      dojoId: data.dojoId,
      memberId: data.memberId ?? null,
      columns: "id",
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days: { date: string; weekday: number }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      days.push({ date: d.toISOString().slice(0, 10), weekday: d.getDay() });
    }

    const { data: classes, error: classErr } = await supabase
      .from("classes")
      .select("id, name, discipline, instructor, weekday, start_time, end_time, capacity")
      .eq("dojo_id", data.dojoId)
      .in("weekday", days.map((d) => d.weekday));
    if (classErr) throw classErr;

    const dateSet = days.map((d) => d.date);
    // HOW FULL a class is counts everyone's bookings, not just this member's.
    // Row-level security lets a member read only their own row, so counting on
    // their client silently returns 1 -- every member saw "1 of 20 booked" for
    // a class nine people had booked. Only the NUMBER is returned to them;
    // who booked is never sent to another member.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: bookings, error: bkErr } = await supabaseAdmin
      .from("class_bookings")
      .select("id, class_id, member_id, booked_for_date, status")
      .eq("dojo_id", data.dojoId)
      .in("booked_for_date", dateSet)
      .in("status", ["booked", "attended"]);
    if (bkErr) throw bkErr;

    const countKey = (classId: string, date: string) => `${classId}|${date}`;
    const counts = new Map<string, number>();
    const mine = new Map<string, { id: string; status: "booked" | "attended" | "no_show" }>();
    for (const b of bookings ?? []) {
      counts.set(countKey(b.class_id, b.booked_for_date), (counts.get(countKey(b.class_id, b.booked_for_date)) ?? 0) + 1);
      if (b.member_id === me.id) {
        mine.set(countKey(b.class_id, b.booked_for_date), { id: b.id, status: b.status as any });
      }
    }

    const now = new Date();
    const rows: WeekClass[] = [];
    for (const day of days) {
      for (const c of classes ?? []) {
        if (c.weekday !== day.weekday) continue;
        // Hide past occurrences for today itself
        if (day.date === today.toISOString().slice(0, 10)) {
          const [hh, mm] = String(c.start_time).split(":");
          const startDt = new Date(today);
          startDt.setHours(Number(hh) || 0, Number(mm) || 0, 0, 0);
          if (startDt.getTime() < now.getTime()) continue;
        }
        const bookedCount = counts.get(countKey(c.id, day.date)) ?? 0;
        const my = mine.get(countKey(c.id, day.date)) ?? null;
        rows.push({
          id: c.id,
          name: c.name,
          discipline: c.discipline,
          instructor: c.instructor,
          weekday: c.weekday,
          start_time: c.start_time,
          end_time: c.end_time,
          capacity: c.capacity,
          booked_for_date: day.date,
          booked_count: bookedCount,
          spots_left: c.capacity == null ? null : Math.max(0, c.capacity - bookedCount),
          my_booking_id: my?.id ?? null,
          my_status: my?.status ?? null,
        });
      }
    }
    rows.sort((a, b) =>
      a.booked_for_date < b.booked_for_date
        ? -1
        : a.booked_for_date > b.booked_for_date
        ? 1
        : a.start_time.localeCompare(b.start_time),
    );
    return rows;
  });

/**
 * Member-facing booking with server-side capacity enforcement.
 * Authenticated as the member; RLS ensures they can only book for themselves.
 */
export const bookClassForMe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { dojoId: string; classId: string; bookedForDate: string; memberId?: string | null }) => d,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // A parent books for the child they manage, on the child's own record.
    const { resolveActingMember } = await import("@/lib/managed-members.server");
    const { supabaseAdmin: adminForMember } = await import(
      "@/integrations/supabase/client.server"
    );
    const me = await resolveActingMember({
      db: adminForMember,
      userId,
      dojoId: data.dojoId,
      memberId: data.memberId ?? null,
      columns: "id, payment_status, status, trial_started_at, free_trial_ends_at",
    });
    // Reads and writes against the member's own rows. A child's rows are
    // invisible to the parent's client, so acting for someone else means
    // going through the admin client -- authorised just above.
    const memberDb = data.memberId ? adminForMember : supabase;

    // Paused members: billing is stopped, so class access follows the gym's
    // policy. Default is no booking while paused.
    if ((me as any).status === "paused") {
      const { data: dojo, error: dojoErr } = await supabase
        .from("dojos")
        .select("paused_members_can_book")
        .eq("id", data.dojoId)
        .maybeSingle();
      if (dojoErr) throw new Error(`Could not load gym policy: ${dojoErr.message}`);
      if (!dojo?.paused_members_can_book) {
        throw new Error(
          "Your membership is paused, so class booking is paused too. Ask your gym to restart it whenever you're ready.",
        );
      }
    }

    // Overdue access policy: keep portal access and the pay action, but block
    // new bookings until the balance is settled. Applies to cash and card alike.
    if ((me as any).payment_status === "overdue") {
      throw new Error(
        "Your membership payment is overdue, so class booking is paused. Settle your balance from the My plan section to book again.",
      );
    }

    // Trial policy: classes per day and the trial window, counted in the GYM'S
    // timezone from the member's first ATTENDED class. A DB trigger enforces
    // this too; this is the friendly message.
    if ((me as any).status === "trial") {
      const {
        computeTrialStatus,
        trialPolicyFromDojo,
        dojoTodayIso,
        trialRefusalPrompt,
        freeAccessWindow,
      } = await import("@/lib/trial-policy");
      const { data: dojo, error: dojoErr } = await supabase
        .from("dojos")
        .select(
          "timezone, trial_length_days, trial_classes_per_day, trial_max_total_classes, signup_free_days",
        )
        .eq("id", data.dojoId)
        .maybeSingle();
      if (dojoErr) throw new Error(`Could not load trial policy: ${dojoErr.message}`);
      const policy = trialPolicyFromDojo(dojo);
      const timezone = (dojo as any)?.timezone ?? "UTC";
      const target = data.bookedForDate;
      const todayStr = dojoTodayIso(timezone);

      const [{ data: atts }, { data: bks }] = await Promise.all([
        memberDb
          .from("attendances")
          .select("checked_in_at")
          .eq("dojo_id", data.dojoId)
          .eq("member_id", me.id),
        memberDb
          .from("class_bookings")
          .select("booked_for_date, status")
          .eq("dojo_id", data.dojoId)
          .eq("member_id", me.id),
      ]);

      let usedToday = 0;
      let usedTotal = 0;
      let upcoming = 0;
      let firstAttended: string | null = null;
      let nextBooked: string | null = null;
      for (const a of atts ?? []) {
        const day = a.checked_in_at ? dojoTodayIso(timezone, new Date(a.checked_in_at)) : null;
        usedTotal += 1;
        if (day === target) usedToday += 1;
        if (day && (!firstAttended || day < firstAttended)) firstAttended = day;
      }
      for (const b of bks ?? []) {
        const day = String(b.booked_for_date ?? "").slice(0, 10);
        if (b.status === "booked" && day >= todayStr) {
          upcoming += 1;
          if (!nextBooked || day < nextBooked) nextBooked = day;
        }
        if (day === target && (b.status === "booked" || b.status === "attended")) usedToday += 1;
      }

      const status = computeTrialStatus({
        memberId: me.id,
        policy,
        timezone,
        startDate: (me as any).trial_started_at ?? firstAttended ?? null,
        nextBookedDate: nextBooked,
        date: target,
        today: todayStr,
        usedToday,
        usedTotal,
        upcoming,
        // Signup free period (per-gym setting): full access, no class limits.
        fullAccess: freeAccessWindow({
          freeTrialEndsAt: (me as any).free_trial_ends_at ?? null,
          timezone,
          days: Number((dojo as any)?.signup_free_days ?? 0) || 0,
        }),
      });

      if (!status.allowed) throw new Error(trialRefusalPrompt(status));
    }




    const { data: klass, error: klassErr } = await supabase
      .from("classes")
      .select("id, dojo_id, weekday, capacity")
      .eq("id", data.classId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (klassErr) throw klassErr;
    if (!klass) throw new Error("Class not found");

    // Validate date matches class weekday and is not in the past.
    const target = new Date(data.bookedForDate + "T00:00:00");
    if (Number.isNaN(target.getTime())) throw new Error("Invalid date");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (target.getTime() < today.getTime()) throw new Error("Cannot book past dates");
    if (target.getDay() !== klass.weekday) throw new Error("Class does not run on that date");

    // Server-side capacity check. It MUST count every booking, so it runs with
    // service-role access: on the member's own client, row-level security hides
    // everyone else's rows and the count comes back as 0 or 1, which let a
    // class of twelve take an unlimited number of bookings.
    if (klass.capacity != null) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { count, error: countErr } = await supabaseAdmin
        .from("class_bookings")
        .select("id", { count: "exact", head: true })
        .eq("dojo_id", data.dojoId)
        .eq("class_id", data.classId)
        .eq("booked_for_date", data.bookedForDate)
        .in("status", ["booked", "attended"]);
      if (countErr) throw countErr;
      if ((count ?? 0) >= klass.capacity) {
        throw new Error("Sorry, this class is fully booked.");
      }
    }

    const { error: insErr } = await memberDb.from("class_bookings").insert({
      dojo_id: data.dojoId,
      class_id: data.classId,
      member_id: me.id,
      booked_for_date: data.bookedForDate,
      status: "booked",
    });
    if (insErr) {
      if ((insErr as any).code === "23505") {
        // A row already exists for this member, class and date -- the unique
        // index covers all three regardless of status, so someone who
        // cancelled can never insert a fresh place. Revive theirs instead,
        // otherwise re-booking would report success while the row stayed
        // cancelled and they turned up to a class they weren't on.
        const { data: existing } = await memberDb
          .from("class_bookings")
          .select("id, status")
          .eq("dojo_id", data.dojoId)
          .eq("class_id", data.classId)
          .eq("member_id", me.id)
          .eq("booked_for_date", data.bookedForDate)
          .maybeSingle();
        if (existing?.status === "cancelled") {
          const { data: revived, error: revErr } = await memberDb
            .from("class_bookings")
            .update({ status: "booked", updated_at: new Date().toISOString() })
            .eq("id", existing.id)
            .eq("status", "cancelled")
            .select("id");
          if (revErr) throw revErr;
          // Same silent-failure risk as cancelling below: a write blocked by
          // row-level security matches no row and raises nothing, which would
          // promise a place they don't hold.
          if (!revived || revived.length === 0) {
            throw new Error(
              "Your place couldn't be booked just now. Please tell your gym so they can add you back.",
            );
          }
          return { ok: true, rebooked: true };
        }
        return { ok: true, alreadyBooked: true };
      }
      throw insErr;
    }
    return { ok: true };
  });


/**
 * Cancel a place the member holds themselves.
 *
 * Allowed up to CANCEL_CUTOFF_HOURS before the class starts. The cutoff is
 * enforced HERE rather than in the portal, because hiding a button is not a
 * rule -- the server function is reachable on its own.
 */
export const cancelMyBooking = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; bookingId: string; memberId?: string | null }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { resolveActingMember } = await import("@/lib/managed-members.server");
    const { supabaseAdmin: adminForMember } = await import(
      "@/integrations/supabase/client.server"
    );
    const me = await resolveActingMember({
      db: adminForMember,
      userId,
      dojoId: data.dojoId,
      memberId: data.memberId ?? null,
      columns: "id",
    });
    const memberDb = data.memberId ? adminForMember : supabase;

    const { data: booking, error: bkErr } = await memberDb
      .from("class_bookings")
      .select("id, member_id, status, booked_for_date, class_id")
      .eq("id", data.bookingId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (bkErr) throw bkErr;
    if (!booking) throw new Error("That booking no longer exists.");
    if (booking.member_id !== me.id) {
      throw new Error("That booking belongs to someone else.");
    }
    if (booking.status === "cancelled") return { ok: true, alreadyCancelled: true };
    if (booking.status !== "booked") {
      throw new Error(
        booking.status === "attended"
          ? "You've already been marked as attending that class."
          : "That class has already passed.",
      );
    }

    const [{ data: klass, error: clsErr }, { data: dojo, error: dojoErr }] = await Promise.all([
      supabase.from("classes").select("name, start_time").eq("id", booking.class_id).maybeSingle(),
      supabase.from("dojos").select("timezone").eq("id", data.dojoId).maybeSingle(),
    ]);
    if (clsErr) throw clsErr;
    if (dojoErr) throw dojoErr;
    if (!klass) throw new Error("That class no longer exists.");

    const timezone = (dojo as any)?.timezone || "UTC";
    const startsAt = classStartMs(timezone, booking.booked_for_date, klass.start_time);
    const cutoff = startsAt - CANCEL_CUTOFF_HOURS * 3600_000;

    if (Date.now() >= cutoff) {
      const started = Date.now() >= startsAt;
      throw new Error(
        started
          ? `${klass.name} has already started, so it can't be cancelled. Speak to your gym.`
          : `${klass.name} starts in under ${CANCEL_CUTOFF_HOURS} hours, so it can no longer be cancelled online. Let your gym know you can't make it.`,
      );
    }

    const { data: released, error: updErr } = await memberDb
      .from("class_bookings")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", booking.id)
      .eq("dojo_id", data.dojoId)
      // Only ever release a place that is still held -- never overwrite an
      // attendance record if one lands between the read above and this write.
      .eq("status", "booked")
      .select("id");
    if (updErr) throw updErr;

    // A row-level security gap raises no error: the update simply matches
    // nothing. Left unchecked, the member is told their place was released
    // while it is still held, and they are marked a no-show for a class they
    // believed they had cancelled. Never report a cancellation we didn't make.
    if (!released || released.length === 0) {
      throw new Error(
        "Your place couldn't be released just now. Please tell your gym so they can clear it for you.",
      );
    }

    return { ok: true, className: klass.name };
  });

/**
 * Staff cancelling someone else's place. No notice period applies: the gym
 * needs to be able to clear a booking whenever the situation calls for it.
 */
export const cancelBookingAsStaff = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; bookingId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertDojoStaff(supabase, userId, data.dojoId, "cancelBookingAsStaff");

    const { data: booking, error: bkErr } = await supabase
      .from("class_bookings")
      .select("id, status")
      .eq("id", data.bookingId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (bkErr) throw bkErr;
    if (!booking) throw new Error("That booking no longer exists.");
    if (booking.status === "cancelled") return { ok: true, alreadyCancelled: true };
    if (booking.status === "attended") {
      throw new Error(
        "That member is already marked as having attended. Change the attendance record instead.",
      );
    }

    const { error: updErr } = await supabase
      .from("class_bookings")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", booking.id)
      .eq("dojo_id", data.dojoId)
      .neq("status", "attended");
    if (updErr) throw updErr;
    return { ok: true };
  });

export type RosterEntry = {
  bookingId: string;
  memberId: string;
  name: string;
  status: "booked" | "attended" | "no_show" | "cancelled";
  beltColor: string | null;
};

export type ClassRoster = {
  classId: string;
  className: string;
  date: string;
  startTime: string;
  capacity: number | null;
  bookedCount: number;
  spotsLeft: number | null;
  entries: RosterEntry[];
};

/**
 * Who is coming to one occurrence of a class. Staff-only.
 *
 * Cancelled places are returned too, but never counted -- a gym wants to see
 * that three people dropped out of tonight's class, not have them silently
 * disappear from the list.
 */
export const getClassRoster = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; classId: string; date: string }) => d)
  .handler(async ({ data, context }): Promise<ClassRoster> => {
    const { supabase, userId } = context;
    await assertDojoStaff(supabase, userId, data.dojoId, "getClassRoster");

    const { data: klass, error: clsErr } = await supabase
      .from("classes")
      .select("id, name, start_time, capacity")
      .eq("id", data.classId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (clsErr) throw clsErr;
    if (!klass) throw new Error("That class no longer exists.");

    const { data: rows, error: bkErr } = await supabase
      .from("class_bookings")
      .select("id, member_id, status, members:member_id(name, belt_color)")
      .eq("dojo_id", data.dojoId)
      .eq("class_id", data.classId)
      .eq("booked_for_date", data.date);
    if (bkErr) throw bkErr;

    const entries: RosterEntry[] = (rows ?? []).map((r: any) => ({
      bookingId: r.id,
      memberId: r.member_id,
      name: r.members?.name ?? "Unknown member",
      status: r.status,
      beltColor: r.members?.belt_color ?? null,
    }));
    entries.sort((a, b) => {
      // Anyone still coming first, cancellations at the bottom.
      const rank = (s: string) => (s === "cancelled" ? 1 : 0);
      return rank(a.status) - rank(b.status) || a.name.localeCompare(b.name);
    });

    const bookedCount = entries.filter(
      (e) => e.status === "booked" || e.status === "attended",
    ).length;

    return {
      classId: klass.id,
      className: klass.name,
      date: data.date,
      startTime: klass.start_time,
      capacity: klass.capacity,
      bookedCount,
      spotsLeft: klass.capacity == null ? null : Math.max(0, klass.capacity - bookedCount),
      entries,
    };
  });

export type UpcomingClassCount = {
  classId: string;
  date: string;
  bookedCount: number;
  capacity: number | null;
};

/**
 * How many people are booked into the NEXT occurrence of each class.
 *
 * The staff schedule is a recurring week rather than real dates, so "how many
 * are coming to this class" can only mean the next time it actually runs.
 * Staff-only.
 */
export const getUpcomingBookingCounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }): Promise<UpcomingClassCount[]> => {
    const { supabase, userId } = context;
    await assertDojoStaff(supabase, userId, data.dojoId, "getUpcomingBookingCounts");

    const { data: dojo } = await supabase
      .from("dojos")
      .select("timezone")
      .eq("id", data.dojoId)
      .maybeSingle();
    const timezone = (dojo as any)?.timezone || "UTC";
    // "Today" is the gym's today, not the browser's or the server's.
    const todayIso = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .format(new Date())
      .replace(/\//g, "-");

    // First date in the next seven days that falls on each weekday.
    const start = new Date(`${todayIso}T00:00:00Z`);
    const nextDateForWeekday = new Map<number, string>();
    for (let i = 0; i < 7; i++) {
      const d = new Date(start.getTime() + i * 86400000);
      const wd = d.getUTCDay();
      if (!nextDateForWeekday.has(wd)) nextDateForWeekday.set(wd, d.toISOString().slice(0, 10));
    }

    const { data: classes, error: clsErr } = await supabase
      .from("classes")
      .select("id, weekday, capacity")
      .eq("dojo_id", data.dojoId);
    if (clsErr) throw clsErr;

    const wanted = (classes ?? [])
      .map((c: any) => ({
        classId: c.id as string,
        capacity: (c.capacity ?? null) as number | null,
        date: nextDateForWeekday.get(c.weekday) ?? null,
      }))
      .filter((r): r is { classId: string; capacity: number | null; date: string } => !!r.date);

    const dates = Array.from(new Set(wanted.map((w) => w.date)));
    if (dates.length === 0) return [];

    const { data: bookings, error: bkErr } = await supabase
      .from("class_bookings")
      .select("class_id, booked_for_date")
      .eq("dojo_id", data.dojoId)
      .in("booked_for_date", dates)
      .in("status", ["booked", "attended"]);
    if (bkErr) throw bkErr;

    const counts = new Map<string, number>();
    for (const b of bookings ?? []) {
      const k = `${b.class_id}|${b.booked_for_date}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }

    return wanted.map((w) => ({
      classId: w.classId,
      date: w.date,
      capacity: w.capacity,
      bookedCount: counts.get(`${w.classId}|${w.date}`) ?? 0,
    }));
  });
