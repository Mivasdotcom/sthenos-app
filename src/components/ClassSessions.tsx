import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import {
  cancelBookingAsStaff,
  getClassSessions,
  setBookingAttendance,
  type ClassSession,
  type SessionBooking,
} from "@/lib/bookings.functions";

/**
 * The GYM'S calendar date. UTC would be three hours behind Limassol, so
 * between midnight and 3am "today" would quietly show yesterday's classes --
 * which is exactly when a coach catches up on the day.
 */
function gymDay(d: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// Members can book up to six days ahead, so that is as far as a coach needs to
// look to see who's coming.
const DAYS_AHEAD = 6;

/**
 * The coach's view of a day: every class, who booked it, and a tick beside
 * each name. Everyone who booked counts as there. The coach unticks the people
 * who didn't come -- absence is the exception they mark, not a default the
 * system assumes.
 *
 * Before a class starts there is nothing to tick, so it shows who's booked and
 * lets staff take someone off it. This replaced a second roster on the Classes
 * page that did the same job for the next run of each class.
 */
export function ClassSessions({ dojoId, timezone }: { dojoId: string; timezone: string }) {
  const [offset, setOffset] = useState(0);
  const day = new Date(Date.now() + offset * 86400000);
  const date = gymDay(day, timezone);
  const qc = useQueryClient();

  const sessionsFn = useServerFn(getClassSessions);
  const markFn = useServerFn(setBookingAttendance);
  const cancelFn = useServerFn(cancelBookingAsStaff);

  const { data: sessions = [], isLoading } = useQuery({
    queryKey: ["class-sessions", dojoId, date],
    enabled: !!dojoId,
    queryFn: () => sessionsFn({ data: { dojoId, date } }),
  });

  const mark = useMutation({
    mutationFn: (v: { bookingId: string; attended: boolean }) =>
      markFn({ data: { dojoId, ...v } }),
    // Show the tick change immediately; a coach ticking down a list of twenty
    // shouldn't wait on the network for each one.
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["class-sessions", dojoId, date] });
      const prev = qc.getQueryData<ClassSession[]>(["class-sessions", dojoId, date]);
      qc.setQueryData<ClassSession[]>(["class-sessions", dojoId, date], (old) =>
        (old ?? []).map((s) => ({
          ...s,
          bookings: s.bookings.map((b) =>
            b.bookingId === v.bookingId
              ? { ...b, status: v.attended ? "attended" : "no_show" }
              : b,
          ),
        })),
      );
      return { prev };
    },
    onError: (e: any, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["class-sessions", dojoId, date], ctx.prev);
      toast.error(e?.message ?? "Couldn't save that. Please try again.");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["class-sessions", dojoId, date] });
      qc.invalidateQueries({ queryKey: ["week-attendance", dojoId] });
    },
  });

  // Staff have no notice period -- the cutoff members are held to doesn't
  // apply here.
  const cancel = useMutation({
    mutationFn: (bookingId: string) => cancelFn({ data: { dojoId, bookingId } }),
    onSuccess: () => toast.success("Booking cancelled"),
    onError: (e: any) => toast.error(e?.message ?? "Couldn't cancel that booking."),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["class-sessions", dojoId, date] });
      qc.invalidateQueries({ queryKey: ["week-attendance", dojoId] });
    },
  });

  // Present unless the coach has marked them absent. A booking still "booked"
  // on a class that hasn't finished is shown as expected, not as attended.
  const present = (b: SessionBooking) => b.status !== "no_show";

  const label =
    offset === 0
      ? "Today"
      : offset === -1
        ? "Yesterday"
        : offset === 1
          ? "Tomorrow"
          : day.toLocaleDateString(undefined, {
            weekday: "long",
            day: "numeric",
            month: "short",
            timeZone: timezone,
          });

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-display text-base font-medium">Classes · {label}</h3>
          <p className="text-sm text-muted-foreground">
            {offset > 0
              ? "Who's booked. Cancel a place if someone can't make it."
              : "Everyone who booked counts as attended. Untick anyone who didn't come."}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setOffset((o) => o - 1)}
            className="rounded-md p-1.5 ring-1 ring-black/5 hover:bg-muted"
            aria-label="Previous day"
          >
            <ChevronLeft className="size-4" />
          </button>
          {offset !== 0 && (
            <button
              type="button"
              onClick={() => setOffset(0)}
              className="rounded-md px-2 py-1 text-xs font-medium ring-1 ring-black/5 hover:bg-muted"
            >
              Today
            </button>
          )}
          <button
            type="button"
            onClick={() => setOffset((o) => Math.min(DAYS_AHEAD, o + 1))}
            disabled={offset >= DAYS_AHEAD}
            className="rounded-md p-1.5 ring-1 ring-black/5 hover:bg-muted disabled:opacity-40"
            aria-label="Next day"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="rounded-xl bg-card p-6 text-sm text-muted-foreground ring-1 ring-black/5">
          Loading…
        </div>
      ) : sessions.length === 0 ? (
        <div className="rounded-xl bg-card p-6 text-sm text-muted-foreground ring-1 ring-black/5">
          No classes scheduled.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {sessions.map((s) => {
            const live = s.bookings.filter((b) => b.status !== "cancelled");
            const attending = live.filter(present).length;
            return (
              <div key={s.classId} className="rounded-xl bg-card p-4 ring-1 ring-black/5">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{s.name}</div>
                    <div className="text-xs tabular-nums text-muted-foreground">
                      {s.startTime.slice(0, 5)}–{s.endTime.slice(0, 5)}
                    </div>
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">
                    {attending}
                    {s.capacity != null ? <span className="text-muted-foreground">/{s.capacity}</span> : null}
                  </span>
                </div>

                {!s.started ? (
                  <UpcomingList
                    bookings={s.bookings}
                    cancelling={cancel.isPending ? cancel.variables : undefined}
                    onCancel={(bookingId) => cancel.mutate(bookingId)}
                  />
                ) : live.length === 0 ? (
                  <p className="mt-3 text-xs text-muted-foreground">Nobody booked.</p>
                ) : (
                  <ul className="mt-3 divide-y divide-zinc-950/5">
                    {live.map((b) => {
                      const on = present(b);
                      return (
                        <li key={b.bookingId} className="flex items-center gap-3 py-1.5">
                          <input
                            type="checkbox"
                            className="size-4 accent-emerald-600"
                            checked={on}
                            aria-label={`${b.name} attended`}
                            onChange={(e) =>
                              mark.mutate({ bookingId: b.bookingId, attended: e.target.checked })
                            }
                          />
                          <span
                            className={`flex-1 truncate text-sm ${on ? "" : "text-muted-foreground line-through"}`}
                          >
                            {b.name}
                          </span>
                          {!on && (
                            <span className="text-[11px] font-medium text-amber-700">Didn't come</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}

                {s.started && !s.finished && live.length > 0 && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Hasn't finished yet — these count once the class ends.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * Who's booked into a class that hasn't started. Cancelled places stay on the
 * list, struck through at the bottom: a gym wants to see that three people
 * dropped out of tonight's class, not have them silently disappear.
 */
function UpcomingList({
  bookings,
  cancelling,
  onCancel,
}: {
  bookings: SessionBooking[];
  cancelling: string | undefined;
  onCancel: (bookingId: string) => void;
}) {
  if (bookings.length === 0) {
    return <p className="mt-3 text-xs text-muted-foreground">Nobody booked yet.</p>;
  }
  const rank = (b: SessionBooking) => (b.status === "cancelled" ? 1 : 0);
  const sorted = [...bookings].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return (
    <ul className="mt-3 divide-y divide-zinc-950/5">
      {sorted.map((b) => {
        const dropped = b.status === "cancelled";
        return (
          <li key={b.bookingId} className="flex items-center gap-3 py-1.5">
            <span
              className={`flex-1 truncate text-sm ${dropped ? "text-muted-foreground line-through" : ""}`}
            >
              {b.name}
            </span>
            {dropped ? (
              <span className="text-[11px] text-muted-foreground">Cancelled</span>
            ) : b.status !== "attended" ? (
              <button
                type="button"
                onClick={() => onCancel(b.bookingId)}
                disabled={cancelling !== undefined}
                className="rounded-md px-2 py-0.5 text-xs font-medium text-muted-foreground ring-1 ring-black/5 hover:bg-muted hover:text-foreground disabled:opacity-40"
              >
                {cancelling === b.bookingId ? "Cancelling…" : "Cancel"}
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
