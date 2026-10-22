import { PUBLIC_SITE_URL } from "@/lib/site";
import { recomputeMemberRetention } from "@/lib/retention.functions";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { PageHeader } from "@/components/PageHeader";
import { RefreshControl } from "@/components/RefreshControl";
import { BeltChip, MemberAvatar } from "@/components/BeltChip";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import type { Belt, BeltColor } from "@/lib/belt-colors";
import { Check, ChevronLeft, ChevronRight, ScanLine } from "lucide-react";
import { toast } from "sonner";
import { confirmPastBookings } from "@/lib/bookings.functions";
import { ClassSessions } from "@/components/ClassSessions";
import { recordAttendance } from "@/lib/trial.functions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/attendance")({
  head: () => ({
    meta: [
      { title: "Attendance \u2014 Sthenos" },
      { name: "description", content: "Live class check-in and recent attendance history for your dojo." },
      { property: "og:title", content: "Attendance \u2014 Sthenos" },
      { property: "og:description", content: "Live class check-in and recent attendance history for your dojo." },
      { property: "og:url", content: `${PUBLIC_SITE_URL}/attendance` },
      { name: "twitter:title", content: "Attendance \u2014 Sthenos" },
      { name: "twitter:description", content: "Live class check-in and recent attendance history for your dojo." },
    ],
    links: [
      { rel: "canonical", href: `${PUBLIC_SITE_URL}/attendance` },
    ],
  }),
  component: AttendancePage,
});

type WeekAttendance = {
  id: string;
  checked_in_at: string;
  member_id: string;
  members: { name: string } | null;
  classes: { name: string } | null;
};

type RosterMember = { id: string; name: string; status: string };

type TodayClass = {
  id: string;
  name: string;
  instructor: string;
  start_time: string;
  end_time: string;
  capacity: number;
  discipline: string;
};

type SearchMember = {
  id: string;
  name: string;
  discipline: string;
  belt_color: BeltColor;
  belt_label: string;
  stripes: number;
};

type CheckedInMember = SearchMember & { checked_in_at: string };

type RecentCheckin = {
  id: string;
  checked_in_at: string;
  members: { name: string; belt_color: BeltColor; belt_label: string; stripes: number; discipline: string } | null;
  classes: { name: string } | null;
};

type TodayBooking = {
  id: string;
  class_id: string;
  member_id: string;
  status: "booked" | "attended" | "no_show";
  classes: { name: string; start_time: string } | null;
  members:
    | {
        id: string;
        name: string;
        discipline: string;
        belt_color: BeltColor;
        belt_label: string;
        stripes: number;
      }
    | null;
};


function toBelt(m: { belt_color: BeltColor; belt_label: string; stripes: number }): Belt {
  return { color: m.belt_color, label: m.belt_label, stripes: m.stripes ?? 0 };
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function AttendancePage() {
  const { activeDojoId } = useCurrentDojo();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [checkedIn, setCheckedIn] = useState<CheckedInMember[]>([]);
  const confirmFn = useServerFn(confirmPastBookings);

  // Opening this page used to mark every unchecked booking from past days as a
  // NO-SHOW. A coach who runs the mats instead of a tablet opened it after
  // class and recorded the whole session as absent. Finished classes now count
  // everyone who booked; the coach marks the exceptions below.
  useEffect(() => {
    if (!activeDojoId) return;
    confirmFn({ data: { dojoId: activeDojoId } })
      .then((res) => {
        if (res?.updated && res.updated > 0) {
          qc.invalidateQueries({ queryKey: ["today-bookings", activeDojoId] });
          qc.invalidateQueries({ queryKey: ["week-attendance", activeDojoId] });
          qc.invalidateQueries({ queryKey: ["class-sessions", activeDojoId] });
        }
      })
      .catch((err) => console.error("confirmPastBookings failed", err));
  }, [activeDojoId, confirmFn, qc]);

  const { data: todaysClasses = [] } = useQuery({
    queryKey: ["today-classes", activeDojoId],
    enabled: !!activeDojoId,
    queryFn: async () => {
      const weekday = new Date().getDay();
      const { data } = await supabase
        .from("classes")
        .select("id, name, instructor, start_time, end_time, capacity, discipline")
        .eq("dojo_id", activeDojoId!)
        .eq("weekday", weekday)
        .order("start_time");
      return (data ?? []) as TodayClass[];
    },
  });

  const activeClass = todaysClasses[0];

  const { data: searchResults = [] } = useQuery({
    queryKey: ["member-search", activeDojoId, search],
    enabled: !!activeDojoId && search.length >= 2,
    queryFn: async () => {
      const { data } = await supabase
        .from("members")
        .select("id, name, discipline, belt_color, belt_label, stripes")
        .eq("dojo_id", activeDojoId!)
        .in("status", ["active", "trial"])
        .ilike("name", `%${search}%`)
        .limit(6);
      return (data ?? []) as SearchMember[];
    },
  });

  const { data: recentCheckins = [] } = useQuery({
    queryKey: ["recent-checkins", activeDojoId],
    enabled: !!activeDojoId,
    refetchInterval: 30000,
    queryFn: async () => {
      const { data } = await supabase
        .from("attendances")
        .select("id, checked_in_at, members(name, belt_color, belt_label, stripes, discipline), classes(name)")
        .eq("dojo_id", activeDojoId!)
        .order("checked_in_at", { ascending: false })
        .limit(20);
      return (data ?? []) as unknown as RecentCheckin[];
    },
  });

  const todayIso = new Date().toISOString().slice(0, 10);
  const { data: todayBookings = [] } = useQuery({
    queryKey: ["today-bookings", activeDojoId, todayIso],
    enabled: !!activeDojoId,
    refetchInterval: 30000,
    queryFn: async () => {
      const { data } = await supabase
        .from("class_bookings")
        .select(
          "id, class_id, member_id, status, classes(name, start_time), members(id, name, discipline, belt_color, belt_label, stripes)",
        )
        .eq("dojo_id", activeDojoId!)
        .eq("booked_for_date", todayIso)
        .order("created_at", { ascending: true });
      return (data ?? []) as unknown as TodayBooking[];
    },
  });

  // ---- The week ---------------------------------------------------------
  const [weekOffset, setWeekOffset] = useState(0);

  const { data: dojoTimezone } = useQuery({
    queryKey: ["dojo-timezone", activeDojoId],
    enabled: !!activeDojoId,
    queryFn: async () => {
      const { data } = await supabase
        .from("dojos")
        .select("timezone")
        .eq("id", activeDojoId!)
        .maybeSingle();
      return ((data as any)?.timezone as string) || "UTC";
    },
  });
  const timezone = dojoTimezone || "UTC";

  // Days are the GYM'S days. A 19:45 class in Limassol must not land on the
  // previous date for a coach reading this from another country.
  const dayKey = (iso: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));

  const fmtDay = (d: Date) =>
    d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

  // How far the gym's clock is from UTC at a given instant. Read from the
  // timezone rather than assumed, so it stays right across a DST change.
  const zoneOffsetMs = (at: Date) => {
    const s = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(at);
    const [datePart, timePart] = s.split(", ");
    const [mm, dd, yyyy] = datePart.split("/");
    return Date.parse(`${yyyy}-${mm}-${dd}T${timePart}Z`) - at.getTime();
  };

  // The real instant a gym-local day begins. Days are grouped in the gym's
  // timezone, so the window that fetches them has to start there too --
  // otherwise a late Sunday class, or a check-in typed up after midnight,
  // is grouped into a week it was never fetched for and simply disappears.
  const gymDayStart = (utcMidnight: Date) =>
    new Date(utcMidnight.getTime() - zoneOffsetMs(utcMidnight));

  // Monday-start week, offset by weekOffset.
  const todayInGym = new Date(`${dayKey(new Date().toISOString())}T00:00:00Z`);
  const mondayIndex = (todayInGym.getUTCDay() + 6) % 7;
  const weekStart = new Date(
    todayInGym.getTime() + (weekOffset * 7 - mondayIndex) * 86400000,
  );
  const weekEnd = new Date(weekStart.getTime() + 7 * 86400000);
  const weekDays = Array.from(
    { length: 7 },
    (_, i) => new Date(weekStart.getTime() + i * 86400000),
  );

  const { data: weekAttendance = [] } = useQuery({
    queryKey: ["week-attendance", activeDojoId, weekStart.toISOString()],
    enabled: !!activeDojoId,
    queryFn: async () => {
      const { data } = await supabase
        .from("attendances")
        .select("id, checked_in_at, member_id, members:member_id(name), classes:class_id(name)")
        .eq("dojo_id", activeDojoId!)
        .gte("checked_in_at", gymDayStart(weekStart).toISOString())
        .lt("checked_in_at", gymDayStart(weekEnd).toISOString())
        .order("checked_in_at", { ascending: true });
      return (data ?? []) as unknown as WeekAttendance[];
    },
  });

  // Everyone who could have trained, so the gap is visible as names rather
  // than as a number nobody can act on.
  const { data: rosterMembers = [] } = useQuery({
    queryKey: ["week-roster", activeDojoId],
    enabled: !!activeDojoId,
    queryFn: async () => {
      const { data } = await supabase
        .from("members")
        .select("id, name, status")
        .eq("dojo_id", activeDojoId!)
        .in("status", ["active", "trial"])
        .order("name");
      return (data ?? []) as unknown as RosterMember[];
    },
  });

  const [trialPrompt, setTrialPrompt] = useState<
    | {
        memberId: string;
        name: string;
        classId: string | null;
        bookingId: string | null;
        message: string;
      }
    | null
  >(null);

  const recordFn = useServerFn(recordAttendance);

  /** Records attendance server-side so the free trial allowance is enforced. */
  const doCheckin = async (args: {
    memberId: string;
    name: string;
    classId: string | null;
    bookingId?: string | null;
    override?: boolean;
  }): Promise<boolean> => {
    if (!activeDojoId) return false;
    let res: any;
    try {
      res = await recordFn({
        data: {
          dojoId: activeDojoId,
          memberId: args.memberId,
          classId: args.classId,
          override: !!args.override,
        },
      });
    } catch (e: any) {
      toast.error(e?.message ?? "Check-in failed");
      return false;
    }
    if (!res?.ok) {
      setTrialPrompt({
        memberId: args.memberId,
        name: args.name,
        classId: args.classId,
        bookingId: args.bookingId ?? null,
        message: res?.message ?? "This member's free trial is used up.",
      });
      return false;
    }
    if (args.bookingId) {
      const { error: updErr } = await supabase
        .from("class_bookings")
        .update({ status: "attended" })
        .eq("id", args.bookingId);
      if (updErr) console.error("Failed to update booking status", updErr);
    }
    toast.success(
      res.overridden ? `${args.name} checked in (trial override recorded)` : `${args.name} checked in`,
    );
    qc.invalidateQueries({ queryKey: ["recent-checkins", activeDojoId] });
    qc.invalidateQueries({ queryKey: ["today-bookings", activeDojoId, todayIso] });
    qc.invalidateQueries({ queryKey: ["trial-usage"] });
    void recomputeMemberRetention({
      data: { dojoId: activeDojoId, memberIds: [args.memberId] },
    }).catch(() => {});
    return true;
  };

  const checkIn = async (m: SearchMember) => {
    if (checkedIn.some((c) => c.id === m.id)) return;
    const ok = await doCheckin({
      memberId: m.id,
      name: m.name,
      classId: activeClass?.id ?? null,
    });
    if (!ok) return;
    setCheckedIn((prev) => [{ ...m, checked_in_at: new Date().toISOString() }, ...prev]);
    setSearch("");
  };

  const convertBooking = async (b: TodayBooking) => {
    if (!b.members) return;
    await doCheckin({
      memberId: b.member_id,
      name: b.members.name,
      classId: b.class_id,
      bookingId: b.id,
    });
  };

  if (!activeDojoId) {
    return (
      <main>
        <PageHeader title="Attendance" subtitle="Select a dojo to take attendance." />
      </main>
    );
  }

  const alreadyIn = new Set(checkedIn.map((c) => c.id));
  const matches = searchResults.filter((m) => !alreadyIn.has(m.id));

  // Everything above knows only about today, which answers "who is on the mats
  // now" but never "who actually trained this week".
  const byDay = new Map<string, WeekAttendance[]>();
  for (const a of weekAttendance) {
    const k = dayKey(a.checked_in_at);
    byDay.set(k, [...(byDay.get(k) ?? []), a]);
  }
  const perMember = new Map<string, number>();
  for (const a of weekAttendance) {
    perMember.set(a.member_id, (perMember.get(a.member_id) ?? 0) + 1);
  }
  const notTrained = rosterMembers.filter((m) => !perMember.has(m.id));
  const trainedRanked = rosterMembers
    .filter((m) => perMember.has(m.id))
    .sort(
      (a, b) =>
        (perMember.get(b.id) ?? 0) - (perMember.get(a.id) ?? 0) ||
        a.name.localeCompare(b.name),
    );
  const weekLabel =
    weekOffset === 0
      ? "This week"
      : `${fmtDay(weekStart)} – ${fmtDay(new Date(weekEnd.getTime() - 86400000))}`;

  return (
    <main>
      <PageHeader
        title="Attendance"
        subtitle={
          activeClass
            ? `Live class · ${activeClass.name} · ${activeClass.start_time.slice(0, 5)}`
            : "No classes scheduled today"
        }
        actions={<RefreshControl />}
      />

      <div className="mx-auto max-w-7xl space-y-8 p-8">
        {/* How this gym actually runs: book, train, and the coach marks who
            didn't come. The live check-in below stays for walk-ins. */}
        {activeDojoId && <ClassSessions dojoId={activeDojoId} timezone={timezone} />}

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
          <section className="lg:col-span-2 space-y-4">
            {!activeClass ? (
              <div className="rounded-xl bg-card p-10 text-center ring-1 ring-black/5">
                <h2 className="font-display text-xl font-medium">No classes scheduled today.</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  Add a class to your schedule to start taking attendance.
                </p>
              </div>
            ) : (
              <div className="rounded-xl bg-card p-6 ring-1 ring-black/5">
                <div className="mb-4 flex items-start justify-between">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-brand">
                      Now checking in
                    </div>
                    <h2 className="font-display text-2xl font-medium">{activeClass.name}</h2>
                    <p className="text-sm text-muted-foreground">
                      {activeClass.instructor} · {activeClass.start_time.slice(0, 5)}–
                      {activeClass.end_time.slice(0, 5)} · {checkedIn.length}/{activeClass.capacity}
                    </p>
                  </div>
                </div>
                <div className="relative">
                  <ScanLine className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    autoFocus
                    placeholder="Scan badge or search member by name…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-12 pl-9 text-base"
                  />
                  {matches.length > 0 && (
                    <div className="absolute top-full z-10 mt-2 w-full overflow-hidden rounded-xl bg-card shadow-xl ring-1 ring-black/10">
                      {matches.map((m) => (
                        <button
                          key={m.id}
                          onClick={() => checkIn(m)}
                          className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-zinc-50"
                        >
                          <MemberAvatar name={m.name} />
                          <div className="flex-1">
                            <div className="text-sm font-medium">{m.name}</div>
                            <div className="text-xs text-muted-foreground">{m.discipline}</div>
                          </div>
                          <BeltChip belt={toBelt(m)} discipline={m.discipline} />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="rounded-xl bg-card ring-1 ring-black/5">
              <div className="border-b border-zinc-950/5 px-6 py-4">
                <h3 className="font-display text-base font-medium">
                  In the room ({checkedIn.length})
                </h3>
              </div>
              <div className="divide-y divide-zinc-950/5">
                {checkedIn.length === 0 && (
                  <div className="px-6 py-10 text-center text-sm text-muted-foreground">
                    No check-ins yet for this session.
                  </div>
                )}
                {checkedIn.map((m) => (
                  <div key={m.id} className="flex items-center gap-3 px-6 py-3">
                    <div className="grid size-8 place-items-center rounded-full bg-emerald-50 ring-1 ring-inset ring-emerald-500/30">
                      <Check className="size-4 text-emerald-600" />
                    </div>
                    <MemberAvatar name={m.name} />
                    <div className="flex-1">
                      <div className="text-sm font-medium">{m.name}</div>
                      <div className="text-xs text-muted-foreground">{formatTime(m.checked_in_at)}</div>
                    </div>
                    <BeltChip belt={toBelt(m)} discipline={m.discipline} />
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl bg-card ring-1 ring-black/5">
              <div className="border-b border-zinc-950/5 px-6 py-4">
                <h3 className="font-display text-base font-medium">
                  Booked for today ({todayBookings.filter((b) => b.status === "booked").length})
                </h3>
                <p className="text-xs text-muted-foreground">
                  One-click check-in for members who reserved a spot.
                </p>
              </div>
              <div className="divide-y divide-zinc-950/5">
                {todayBookings.length === 0 && (
                  <div className="px-6 py-8 text-center text-sm text-muted-foreground">
                    No bookings for today.
                  </div>
                )}
                {todayBookings.map((b) => (
                  <div key={b.id} className="flex items-center gap-3 px-6 py-3">
                    <MemberAvatar name={b.members?.name ?? "?"} />
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-sm font-medium">
                        {b.members?.name ?? "Member"}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {b.classes?.name ?? "Class"}
                        {b.classes?.start_time
                          ? ` · ${b.classes.start_time.slice(0, 5)}`
                          : ""}
                      </div>
                    </div>
                    {b.status === "attended" ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-500/30">
                        <Check className="size-3" /> Checked in
                      </span>
                    ) : b.status === "no_show" ? (
                      <span className="rounded-full bg-zinc-100 px-2 py-1 text-[11px] font-medium text-zinc-600">
                        No show
                      </span>
                    ) : (
                      <button
                        onClick={() => convertBooking(b)}
                        className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-foreground hover:bg-brand/90"
                      >
                        Check in
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </section>


          <section className="space-y-4">
            <h3 className="font-display text-base font-medium">Recent Check-ins</h3>
            <div className="rounded-xl bg-card ring-1 ring-black/5">
              {recentCheckins.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No recent check-ins.
                </div>
              ) : (
                <div className="divide-y divide-zinc-950/5">
                  {recentCheckins.map((a) => (
                    <div key={a.id} className="flex items-center gap-3 px-4 py-3">
                      <MemberAvatar name={a.members?.name ?? "?"} className="size-7" />
                      <div className="flex-1 min-w-0">
                        <div className="truncate text-sm font-medium">
                          {a.members?.name ?? "Member"}
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {a.classes?.name ?? "Open mat"}
                        </div>
                      </div>
                      <span className="text-[11px] tabular-nums text-muted-foreground">
                        {formatTime(a.checked_in_at)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>

        {/* Who actually trained. The screens above only ever know today. */}
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-display text-base font-medium">{weekLabel}</h3>
              <p className="text-sm text-muted-foreground">
                {weekAttendance.length === 0
                  ? "Nobody has been checked in yet."
                  : `${weekAttendance.length} check-in${weekAttendance.length === 1 ? "" : "s"} by ${perMember.size} member${perMember.size === 1 ? "" : "s"}.`}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setWeekOffset((w) => w - 1)}
                className="rounded-md p-1.5 ring-1 ring-black/5 hover:bg-muted"
                aria-label="Previous week"
              >
                <ChevronLeft className="size-4" />
              </button>
              {weekOffset !== 0 && (
                <button
                  type="button"
                  onClick={() => setWeekOffset(0)}
                  className="rounded-md px-2 py-1 text-xs font-medium ring-1 ring-black/5 hover:bg-muted"
                >
                  This week
                </button>
              )}
              <button
                type="button"
                onClick={() => setWeekOffset((w) => Math.min(0, w + 1))}
                disabled={weekOffset >= 0}
                className="rounded-md p-1.5 ring-1 ring-black/5 hover:bg-muted disabled:opacity-40"
                aria-label="Next week"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-7">
            {weekDays.map((d) => {
              const k = d.toISOString().slice(0, 10);
              const rows = byDay.get(k) ?? [];
              const isToday = k === dayKey(new Date().toISOString());
              return (
                <div
                  key={k}
                  className={`rounded-xl bg-card p-3 ring-1 ${
                    isToday ? "ring-brand/40" : "ring-black/5"
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {d.toLocaleDateString(undefined, { weekday: "short" })}{" "}
                      {d.getUTCDate()}
                    </span>
                    <span className="text-sm font-semibold tabular-nums">{rows.length}</span>
                  </div>
                  <div className="mt-2 space-y-1">
                    {rows.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground">—</p>
                    ) : (
                      rows.map((a) => (
                        <p key={a.id} className="truncate text-[11px]">
                          {a.members?.name ?? "Member"}
                          {a.classes?.name ? (
                            <span className="text-muted-foreground"> · {a.classes.name}</span>
                          ) : null}
                        </p>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-xl bg-card p-4 ring-1 ring-black/5">
              <h4 className="text-sm font-semibold">Trained this week</h4>
              {trainedRanked.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">Nobody yet.</p>
              ) : (
                <ul className="mt-2 divide-y divide-zinc-950/5">
                  {trainedRanked.map((m) => (
                    <li key={m.id} className="flex items-center justify-between py-1.5 text-sm">
                      <span className="truncate">{m.name}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {perMember.get(m.id)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* The half that matters for retention: a name you can ring. */}
            <div className="rounded-xl bg-card p-4 ring-1 ring-black/5">
              <h4 className="text-sm font-semibold">
                Haven't trained{" "}
                <span className="font-normal text-muted-foreground">
                  ({notTrained.length})
                </span>
              </h4>
              {notTrained.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  Everyone on the roster trained this week.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-zinc-950/5">
                  {notTrained.map((m) => (
                    <li key={m.id} className="flex items-center justify-between py-1.5 text-sm">
                      <span className="truncate">{m.name}</span>
                      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                        {m.status}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      </div>
      <AlertDialog open={!!trialPrompt} onOpenChange={(o) => !o && setTrialPrompt(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Free trial used up</AlertDialogTitle>
            <AlertDialogDescription>
              {trialPrompt?.message} Set {trialPrompt?.name.split(" ")[0]} up on a plan to keep
              them training — or allow this one class as a coach's call. Overrides are recorded
              against your name.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                const p = trialPrompt;
                setTrialPrompt(null);
                if (!p) return;
                await doCheckin({
                  memberId: p.memberId,
                  name: p.name,
                  classId: p.classId,
                  bookingId: p.bookingId,
                  override: true,
                });
              }}
            >
              Allow this class
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
