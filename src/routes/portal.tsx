import { PUBLIC_SITE_URL } from "@/lib/site";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { BeltChip } from "@/components/BeltChip";
import { Calendar, CreditCard, User, Loader2, Pencil, Receipt, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { supabase } from "@/integrations/supabase/client";
import { ChangeMemberEmailDialog } from "@/components/ChangeMemberEmailDialog";
import { MemberPaymentAction, useMemberBilling } from "@/components/MemberPaymentAction";
import { isCashPayer } from "@/lib/cash-payments";
import {
  DIRECT_DEBIT_PENDING_LABEL,
  directDebitPendingMessage,
  expectedFirstCollectionDate,
  isAwaitingFirstDirectDebit,
} from "@/lib/payment-methods";
import { toast } from "sonner";

import { MemberAgreementsSection } from "@/components/MemberAgreementsSection";
import { StartMembershipCard } from "@/components/StartMembershipCard";

import { useServerFn } from "@tanstack/react-start";
import { createCheckoutSession } from "@/lib/payments.functions";
import { getMyFamilyPricing } from "@/lib/family-pricing.functions";
import { PLATFORM_FEE_PERCENT } from "@/lib/platform-fee";
import { FamilyPricingBreakdown } from "@/components/FamilyPricingBreakdown";
import { AddChildDialog } from "@/components/AddChildDialog";
import { MyChildren } from "@/components/MyChildren";
import {
  bookClassForMe,
  cancelMyBooking,
  CANCEL_CUTOFF_HOURS,
  getWeekClassesForMe,
  type WeekClass,
} from "@/lib/bookings.functions";
import {
  getPortalPayments,
  getPortalSnapshot,
  listMyMembers,
} from "@/lib/my-members.functions";
import { getMyTrialUsage } from "@/lib/trial.functions";
import { trialCountdownText, trialProgressText } from "@/lib/trial-policy";


export const Route = createFileRoute("/portal")({
  head: () => ({
    meta: [
      { title: "Member Portal \u2014 Sthenos" },
      { name: "description", content: "View your profile, attendance, and membership plan." },
      { property: "og:title", content: "Member Portal \u2014 Sthenos" },
      { property: "og:description", content: "View your profile, attendance, and membership plan." },
      { property: "og:url", content: `${PUBLIC_SITE_URL}/portal` },
      { name: "twitter:title", content: "Member Portal \u2014 Sthenos" },
      { name: "twitter:description", content: "View your profile, attendance, and membership plan." },
    ],
    links: [
      { rel: "canonical", href: `${PUBLIC_SITE_URL}/portal` },
    ],
  }),
  component: PortalPage,
});

function PortalPage() {
  const { user } = useAuth();
  const { activeDojoId } = useCurrentDojo();
  const queryClient = useQueryClient();
  // A failed signup checkout must stay visible — a toast disappears and the
  // member is left believing they've paid when nothing was taken.
  const [checkoutFailure, setCheckoutFailure] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const status = params.get("payment");
    if (status === "success") {
      toast.success("Payment complete", { description: "Thanks — your plan is active." });
      const url = new URL(window.location.href);
      url.searchParams.delete("payment");
      window.history.replaceState({}, "", url.toString());
    } else if (status === "cancelled") {
      toast.info("Payment cancelled");
      const url = new URL(window.location.href);
      url.searchParams.delete("payment");
      window.history.replaceState({}, "", url.toString());
    } else if (status === "setup_failed") {
      const error = params.get("error");
      setCheckoutFailure(error || "We couldn't open the payment page.");
      const url = new URL(window.location.href);
      url.searchParams.delete("payment");
      url.searchParams.delete("error");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);


  // WHOSE portal this is. A parent's login stands for their children as well
  // as themselves, so every read below is scoped to the selected person rather
  // than to the login. Stored per gym so a parent who was last looking at one
  // child comes back to them.
  const membersFn = useServerFn(listMyMembers);
  const { data: myMembers } = useQuery({
    queryKey: ["my-members", user?.id, activeDojoId],
    enabled: !!user?.id && !!activeDojoId,
    queryFn: () => membersFn({ data: { dojoId: activeDojoId! } }),
  });
  const people = myMembers?.members ?? [];

  const selectionKey = activeDojoId ? `sthenos:portal-member:${activeDojoId}` : null;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (people.length === 0) return;
    const stored =
      selectionKey && typeof window !== "undefined"
        ? window.localStorage.getItem(selectionKey)
        : null;
    const valid = people.find((p) => p.id === stored) ?? people[0];
    setSelectedId((current) =>
      current && people.some((p) => p.id === current) ? current : valid.id,
    );
  }, [people, selectionKey]);

  function selectPerson(id: string) {
    setSelectedId(id);
    if (selectionKey && typeof window !== "undefined") {
      try {
        window.localStorage.setItem(selectionKey, id);
      } catch {
        // A blocked storage write is not worth failing over.
      }
    }
  }

  const portalKey = ["portal", user?.id, activeDojoId, selectedId] as const;

  const snapshotFn = useServerFn(getPortalSnapshot);
  const { data, isLoading } = useQuery({
    queryKey: portalKey,
    enabled: !!user?.id && !!activeDojoId && (people.length === 0 || !!selectedId),
    queryFn: () =>
      snapshotFn({ data: { dojoId: activeDojoId!, memberId: selectedId ?? null } }),
  });

  if (isLoading) {
    return (
      <main>
        <PageHeader title="Member Portal" subtitle="Loading your profile…" />
        <div className="mx-auto flex max-w-2xl items-center justify-center p-16">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        </div>
      </main>
    );
  }

  const member = data?.member;

  if (!member) {
    return (
      <main>
        <PageHeader title="Member Portal" subtitle="No member profile linked" />
        <div className="mx-auto max-w-2xl p-8">
          <div className="rounded-xl border border-dashed border-zinc-950/10 bg-card/50 p-6 text-center text-sm text-muted-foreground">
            Your profile isn't set up yet in this dojo. Contact your gym manager.
          </div>
        </div>
      </main>
    );
  }

  const belt = {
    color: (member.belt_color ?? "white") as any,
    label: member.belt_label ?? "White Belt",
    stripes: member.stripes ?? 0,
    dan: (member as any).dan ?? undefined,
  };
  const discipline = (member.discipline ?? "BJJ") as any;

  return (
    <main>
      <PageHeader
        title="Member Portal"
        subtitle={
          people.find((p) => p.id === member.id)?.isSelf === false
            ? `${member.name}'s profile, attendance and plan.`
            : "Your profile, attendance, and plan."
        }
      />
      <div className="mx-auto max-w-4xl space-y-6 p-8">
        {checkoutFailure && (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4">
            <h2 className="text-sm font-semibold text-foreground">
              Your payment wasn't taken
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              You're registered with your gym, but no payment has been collected yet, so your
              membership isn't active. Use <span className="font-medium">My plan</span> below to
              pay now.
            </p>
            <p className="mt-2 text-xs text-destructive/90">{checkoutFailure}</p>
            <div className="mt-3 flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  document
                    .getElementById("my-plan")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                Pay now
              </Button>
              <Button size="sm" variant="outline" onClick={() => setCheckoutFailure(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        )}

        {people.length > 1 && (
          <PersonSwitcher people={people} selectedId={member.id} onSelect={selectPerson} />
        )}

        <StartMembershipCard dojoId={activeDojoId!} returnPath="/portal" />

        <ProfileSection

          member={member}
          belt={belt}
          discipline={discipline}
          onSaved={() => queryClient.invalidateQueries({ queryKey: portalKey })}
          activeDojoId={activeDojoId!}
          userId={user!.id}
        />
        <MemberAgreementsSection
          member={member}
          onSaved={() => queryClient.invalidateQueries({ queryKey: portalKey })}
        />
        <BookClassSection
          dojoId={activeDojoId!}
          overdue={member.payment_status === "overdue"}
          coveredByName={(member as any).covered_by_member?.name ?? null}
          memberId={member.id}
        />
        <AttendanceSection attendances={data!.attendances} monthCount={data!.monthCount} />
        <PlanSection
          subscription={data!.subscription}
          plan={data!.plan}
          member={member}
          dojoId={activeDojoId!}
        />
        <PaymentHistorySection memberId={member.id} dojoId={activeDojoId!} />

      </div>
    </main>
  );
}

/**
 * Payment history with a link to the real Stripe invoice, so members can get a
 * proper receipt for expenses, insurance or tax without asking the gym. Cash
 * payments have no Stripe invoice, so those rows simply carry no link.
 */
/**
 * A parent's login stands for their children as well as themselves, so the
 * portal has to say plainly whose it is showing. Pills rather than a dropdown:
 * a parent has two or three children, not twenty, and this is read on a phone.
 */
function PersonSwitcher({
  people,
  selectedId,
  onSelect,
}: {
  people: { id: string; name: string; isSelf: boolean }[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-card p-3 ring-1 ring-black/5">
      <span className="pr-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Viewing
      </span>
      {people.map((p) => {
        const active = p.id === selectedId;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelect(p.id)}
            className={
              active
                ? "rounded-full bg-brand px-3 py-1.5 text-sm font-semibold text-brand-foreground"
                : "rounded-full px-3 py-1.5 text-sm font-medium text-muted-foreground ring-1 ring-black/5 hover:bg-muted hover:text-foreground"
            }
          >
            {p.isSelf ? "You" : p.name}
          </button>
        );
      })}
    </div>
  );
}

function PaymentHistorySection({ memberId, dojoId }: { memberId: string; dojoId: string }) {
  // A parent sees what their child was charged, which their own client cannot
  // read, so this goes through the server function that checks the link.
  const paymentsFn = useServerFn(getPortalPayments);
  const { data: paymentsData, isLoading } = useQuery({
    queryKey: ["portal-payments", memberId],
    enabled: !!memberId && !!dojoId,
    queryFn: () => paymentsFn({ data: { dojoId, memberId } }),
  });
  const data = paymentsData?.payments;

  const fmt = (cents: number, currency: string) => {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: (currency || "gbp").toUpperCase(),
      }).format(cents / 100);
    } catch {
      return `${(cents / 100).toFixed(2)}`;
    }
  };

  return (
    <section className="rounded-xl bg-card p-6 ring-1 ring-black/5">
      <div className="mb-4 flex items-center gap-2">
        <Receipt className="size-4 text-brand" />
        <h2 className="font-display text-base font-medium">Payments &amp; receipts</h2>
      </div>
      {isLoading ? (
        <div className="h-16 animate-pulse rounded-lg bg-muted" />
      ) : (data ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">No payments yet.</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {(data ?? []).map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <div>
                <div className="font-medium tabular-nums">
                  {fmt(row.amount_cents, row.currency)}{" "}
                  <span className="text-xs font-normal uppercase tracking-wider text-muted-foreground">
                    {String(row.status).replace(/_/g, " ")}
                    {row.cash ? " · cash" : ""}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {row.when
                    ? `${row.paid ? "Paid" : "Due"} ${new Date(row.when).toLocaleDateString()}`
                    : "—"}
                  {(row.refunded_amount_cents ?? 0) > 0
                    ? ` · ${fmt(row.refunded_amount_cents!, row.currency)} refunded`
                    : ""}
                </div>
              </div>
              {row.hosted_invoice_url ? (
                <Button size="sm" variant="outline" asChild>
                  <a href={row.hosted_invoice_url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="mr-1.5 size-3.5" />
                    Download receipt
                  </a>
                </Button>
              ) : row.cash ? (
                <span className="text-xs text-muted-foreground">Paid at the gym</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const WEEKDAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function BookClassSection({
  dojoId,
  overdue,
  coveredByName,
  memberId,
}: {
  dojoId: string;
  overdue: boolean;
  coveredByName?: string | null;
  /** Whose classes these are: the member themselves, or a child. */
  memberId: string;
}) {
  const qc = useQueryClient();
  const fetchWeek = useServerFn(getWeekClassesForMe);
  const bookFn = useServerFn(bookClassForMe);
  const key = ["portal-week-classes", dojoId, memberId] as const;

  const { data: classes = [], isLoading } = useQuery({
    queryKey: key,
    queryFn: () => fetchWeek({ data: { dojoId, memberId } }),
    enabled: !!dojoId && !!memberId,
  });

  const trialFn = useServerFn(getMyTrialUsage);
  const { data: trial } = useQuery({
    queryKey: ["my-trial-usage", dojoId, memberId],
    queryFn: () => trialFn({ data: { dojoId, memberId } }),
    enabled: !!dojoId && !!memberId,
  });
  const trialActive = !!trial?.isTrial;
  const trialBlocked = trialActive && !trial!.allowed;
  const trialEnded = trialActive && trial!.ended;

  const book = useMutation({
    mutationFn: async (c: WeekClass) =>
      bookFn({ data: { dojoId, classId: c.id, bookedForDate: c.booked_for_date, memberId } }),
    onSuccess: (res: any) => {
      toast.success(res?.alreadyBooked ? "You're already booked." : "Class booked");
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ["my-trial-usage", dojoId] });
    },
    onError: (err: any) => toast.error(err?.message ?? "Booking failed"),
  });

  const cancelFn = useServerFn(cancelMyBooking);
  const cancel = useMutation({
    mutationFn: async (c: WeekClass) =>
      cancelFn({ data: { dojoId, bookingId: String(c.my_booking_id), memberId } }),
    onSuccess: () => {
      toast.success("Booking cancelled — your place is back in the class");
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ["my-trial-usage", dojoId] });
    },
    // The cutoff is enforced on the server, so this is where a member who
    // pressed Cancel a minute too late finds out why it didn't work.
    onError: (err: any) => toast.error(err?.message ?? "Could not cancel that booking"),
  });

  // Classes the member already holds per day — the trial per-day limit is
  // date-specific, so today's class being used must not block tomorrow.
  const trialDayCount = new Map<string, number>();
  for (const c of classes) {
    if (c.my_status === "booked" || c.my_status === "attended") {
      trialDayCount.set(c.booked_for_date, (trialDayCount.get(c.booked_for_date) ?? 0) + 1);
    }
  }

  const grouped = new Map<string, WeekClass[]>();
  for (const c of classes) {
    const arr = grouped.get(c.booked_for_date) ?? [];
    arr.push(c);
    grouped.set(c.booked_for_date, arr);
  }

  return (
    <section className="rounded-xl bg-card p-6 ring-1 ring-black/5">
      <div className="mb-4 flex items-center gap-2">
        <Calendar className="size-4 text-brand" />
        <h2 className="font-display text-base font-medium">Book a class</h2>
      </div>
      {overdue && (
        <div className="mb-4 rounded-lg bg-amber-100 p-3 text-xs text-amber-900 ring-1 ring-inset ring-amber-500/30">
          {coveredByName
            ? `Booking is paused because the family plan covering you (paid by ${coveredByName}) is overdue. Contact your gym to sort it out and booking reopens straight away.`
            : "Booking is paused because your membership payment is overdue. Settle up in the My plan section below (or pay your gym in person if you pay by cash) and booking reopens straight away."}
        </div>
      )}
      {trialActive && (
        <div
          className={
            trialBlocked
              ? "mb-4 rounded-lg bg-amber-100 p-3 text-xs text-amber-900 ring-1 ring-inset ring-amber-500/30"
              : "mb-4 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground"
          }
        >
          {trial!.reason === "no_trial" ? (
            <>
              <span className="font-medium">This gym doesn't include free trial classes.</span>{" "}
              Choose a plan to start training.
            </>
          ) : trial!.notStarted ? (
            // The clock only starts at their first attended class, so say when
            // that is rather than pretending they are on day 1.
            <span className="font-medium">{trialCountdownText(trial!)}</span>
          ) : (
            <>
              <span className="font-medium">{trialProgressText(trial!)}</span>
              {trial!.reason === "day_limit" && !trialEnded
                ? " — that's your class for today. Come back tomorrow, or choose a plan for unlimited access."
                : trialCountdownText(trial!)
                  ? ` — ${trialCountdownText(trial!)}`
                  : ""}
            </>
          )}

          {trialBlocked && (
            <div className="mt-2">
              <Button
                size="sm"
                onClick={() =>
                  document
                    .getElementById("start-membership")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
              >
                Choose a plan
              </Button>
            </div>
          )}
        </div>
      )}
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading this week's classes…</p>
      ) : classes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No classes scheduled this week.</p>
      ) : (
        <div className="space-y-4">
          {Array.from(grouped.entries()).map(([date, list]) => {
            const d = new Date(date + "T00:00:00");
            return (
              <div key={date}>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {WEEKDAY_LABEL[d.getDay()]} · {d.toLocaleDateString([], { month: "short", day: "numeric" })}
                </div>
                <ul className="divide-y divide-zinc-950/5 rounded-lg ring-1 ring-black/5">
                  {list.map((c) => {
                    const full = c.spots_left != null && c.spots_left <= 0;
                    const mine = c.my_status === "booked" || c.my_status === "attended";
                    // Trial limits are date-specific: today's class being used
                    // must not block tomorrow's booking.
                    const dayFull =
                      trialActive &&
                      (trialDayCount.get(c.booked_for_date) ?? 0) >= trial!.policy.perDay;
                    // The trial window is the same one the server enforces:
                    // bookableUntil covers members who haven't attended yet.
                    const outOfWindow =
                      trialActive &&
                      (trialEnded ||
                        (trial!.bookableUntil != null &&
                          c.booked_for_date > trial!.bookableUntil));
                    const trialBlocks = dayFull || outOfWindow;

                    // Cancelling closes CANCEL_CUTOFF_HOURS before the class.
                    // Read in the browser's own time, the same way this list
                    // already decides which of today's classes have passed.
                    const startsAtMs = new Date(
                      `${c.booked_for_date}T${c.start_time.slice(0, 5)}:00`,
                    ).getTime();
                    const canCancel =
                      c.my_status === "booked" &&
                      !!c.my_booking_id &&
                      Date.now() < startsAtMs - CANCEL_CUTOFF_HOURS * 3600_000;
                    const tooLateToCancel = c.my_status === "booked" && !canCancel;

                    return (
                      <li key={`${c.id}-${c.booked_for_date}`} className="flex items-center gap-3 px-4 py-3">
                        <div className="flex-1 min-w-0">
                          <div className="truncate text-sm font-medium">{c.name}</div>
                          <div className="truncate text-xs text-muted-foreground">
                            {c.start_time.slice(0, 5)}–{c.end_time.slice(0, 5)}
                            {c.instructor ? ` · ${c.instructor}` : ""}
                            {c.capacity != null ? ` · ${c.booked_count}/${c.capacity}` : ""}
                          </div>
                        </div>
                        {mine ? (
                          <div className="flex items-center gap-2">
                            <span className="rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-500/30">
                              {c.my_status === "attended" ? "Attended" : "Booked"}
                            </span>
                            {canCancel ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={cancel.isPending}
                                onClick={() => cancel.mutate(c)}
                              >
                                Cancel
                              </Button>
                            ) : tooLateToCancel ? (
                              <span
                                className="text-[11px] text-muted-foreground"
                                title={`Cancelling closes ${CANCEL_CUTOFF_HOURS} hours before a class starts. Let your gym know if you can't make it.`}
                              >
                                Too late to cancel
                              </span>
                            ) : null}
                          </div>
                        ) : full ? (
                          <span className="rounded-full bg-zinc-100 px-2 py-1 text-[11px] font-medium text-zinc-600">
                            Full
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            disabled={book.isPending || overdue || trialBlocks}
                            title={
                              overdue
                                ? "Payment overdue — settle up to book classes"
                                : outOfWindow
                                  ? trialEnded
                                    ? "Your free trial has finished — choose a plan to book more classes"
                                    : "That day is beyond your free trial — choose a plan to book it"
                                  : dayFull
                                    ? trial!.policy.perDay === 1
                                      ? "Your free trial allows one class a day — that day is already booked"
                                      : `Your free trial allows ${trial!.policy.perDay} classes a day — that day is full`
                                    : undefined
                            }
                            onClick={() => book.mutate(c)}
                          >

                            Book
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ProfileSection({
  member,
  belt,
  discipline,
  onSaved,
  activeDojoId,
  userId,
}: {
  member: any;
  belt: any;
  discipline: any;
  onSaved: () => void;
  activeDojoId: string;
  userId: string;
}) {
  const [editing, setEditing] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [form, setForm] = useState({
    name: member.name ?? "",
    email: member.email ?? "",
    phone: member.phone ?? "",
  });

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("update_my_contact", {
        p_member_id: member.id,
        p_name: form.name,
        p_email: member.email || null,
        p_phone: form.phone || null,
        p_marketing_opt_out: member.marketing_opt_out ?? false,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Profile updated");
      setEditing(false);
      onSaved();
    },
    onError: (e: any) => toast.error(e.message ?? "Failed to update"),
  });

  return (
    <section className="rounded-xl bg-card p-6 ring-1 ring-black/5">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <User className="size-4 text-brand" />
          <h2 className="font-display text-base font-medium">My profile</h2>
        </div>
        {!editing && (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            <Pencil className="mr-1 size-3" /> Edit
          </Button>
        )}
      </div>

      {editing ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div>
            <Label>Name</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <Label>Email</Label>
            <Input type="email" value={form.email} disabled readOnly />
            <button
              type="button"
              className="mt-1 text-xs text-brand underline"
              onClick={() => setEmailOpen(true)}
            >
              Change email
            </button>
          </div>
          <div>
            <Label>Phone</Label>
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div className="md:col-span-3 flex gap-2">
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm md:grid-cols-2">
          <Field label="Name" value={member.name} />
          <Field label="Email" value={member.email ?? "—"} />
          <Field label="Phone" value={member.phone ?? "—"} />
          <Field label="Discipline" value={discipline} />
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Belt</dt>
            <dd className="mt-1"><BeltChip belt={belt} discipline={discipline} /></dd>
          </div>
          <Field
            label="Joined"
            value={member.joined_at ? new Date(member.joined_at).toLocaleDateString() : "—"}
          />
        </dl>
      )}

      <ChangeMemberEmailDialog
        memberId={member.id}
        currentEmail={member.email}
        open={emailOpen}
        onOpenChange={(o) => {
          setEmailOpen(o);
          if (!o) onSaved();
        }}
      />
    </section>
  );
}




function AttendanceSection({ attendances, monthCount }: { attendances: any[]; monthCount: number }) {
  return (
    <section className="rounded-xl bg-card p-6 ring-1 ring-black/5">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calendar className="size-4 text-brand" />
          <h2 className="font-display text-base font-medium">My attendance</h2>
        </div>
        <div className="rounded-lg bg-muted px-3 py-1.5 text-right">
          <div className="font-display text-xl font-medium tabular-nums leading-none">{monthCount}</div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">This month</div>
        </div>
      </div>
      {attendances.length === 0 ? (
        <p className="text-sm text-muted-foreground">No check-ins yet.</p>
      ) : (
        <ul className="divide-y divide-zinc-950/5">
          {attendances.map((a) => (
            <li key={a.id} className="flex items-center justify-between py-2 text-sm">
              <span className="font-medium">{a.classes?.name ?? "Open mat"}</span>
              <span className="text-muted-foreground">
                {new Date(a.checked_in_at).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PaymentStatusBadge({ status }: { status: string | null | undefined }) {
  const s = (status ?? "none") as "current" | "due" | "overdue" | "none";
  const map: Record<string, string> = {
    current: "bg-emerald-100 text-emerald-700 ring-emerald-600/20",
    due: "bg-amber-100 text-amber-700 ring-amber-600/20",
    overdue: "bg-red-100 text-red-700 ring-red-600/20",
    none: "bg-zinc-200 text-zinc-700 ring-zinc-600/20",
  };
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${map[s]}`}>
      {s}
    </span>
  );
}

function PlanSection({
  subscription,
  plan,
  member,
  dojoId,
}: {
  subscription: any;
  plan: any;
  member: any;
  dojoId: string;
}) {
  const checkout = useServerFn(createCheckoutSession);
  const [loading, setLoading] = useState(false);
  const billing = useMemberBilling(member?.id, dojoId);
  const familyPricingFn = useServerFn(getMyFamilyPricing);
  const { data: familyPricing } = useQuery({
    queryKey: ["my-family-pricing", member?.id],
    enabled: !!member?.id && !!member?.family_group_id,
    queryFn: () => familyPricingFn({ data: { memberId: member.id } }),
  });

  const isCovered = !!member?.plan_covered_by;
  // Cash members pay at the dojo — never prompt them for card details.
  const isCash = isCashPayer(member?.payment_method);
  // A mandate is authorised but the first collection hasn't cleared yet:
  // the member has already done everything — never ask them to pay again.
  const awaitingDirectDebit = isAwaitingFirstDirectDebit({
    paymentMethod: member?.payment_method,
    paymentStatus: member?.payment_status,
    subscriptionStatus: subscription?.status,
  });
  const ddExpected = expectedFirstCollectionDate(
    subscription?.current_period_start ?? member?.joined_at ?? member?.created_at,
    member?.payment_method,
  );
  const canPay =
    !isCovered &&
    !isCash &&
    !awaitingDirectDebit &&
    !!member?.selected_plan_id &&
    (member?.payment_status ?? "none") !== "current";


  const startCheckout = async () => {
    if (!member?.selected_plan_id) return;
    setLoading(true);
    try {
      const res = await checkout({
        data: {
          memberId: member.id,
          dojoId: member.dojo_id,
          planId: member.selected_plan_id,
        },
      });
      if (res.error || !res.url) {
        toast.error(res.error ?? "Could not start checkout");
        return;
      }
      window.location.href = res.url;
    } catch (e: any) {
      toast.error(e?.message ?? "Could not start checkout");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section id="my-plan" className="rounded-xl bg-card p-6 ring-1 ring-black/5">

      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CreditCard className="size-4 text-brand" />
          <h2 className="font-display text-base font-medium">My plan</h2>
        </div>
        {awaitingDirectDebit ? (
          <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-medium text-sky-800 ring-1 ring-sky-600/20">
            {DIRECT_DEBIT_PENDING_LABEL}
          </span>
        ) : (
          <PaymentStatusBadge status={member?.payment_status} />
        )}
      </div>

      {isCovered && (
        <div className="mb-4 rounded-lg bg-violet-50 px-3 py-3 ring-1 ring-violet-500/20">
          <p className="text-sm font-semibold text-violet-900">
            Covered by{" "}
            {familyPricing?.payerName ?? member?.covered_by_member?.name
              ? `${familyPricing?.payerName ?? member?.covered_by_member?.name}'s family plan`
              : "a family plan"}
            .
          </p>
          {(familyPricing?.payerName ?? member?.covered_by_member?.name) && (
            <p className="mt-1 text-xs font-medium text-violet-900">
              Payer: {familyPricing?.payerName ?? member?.covered_by_member?.name} — you are never
              charged separately.
            </p>
          )}
          <p className="mt-1 text-xs text-violet-900/80">
            {member?.covered_by_member?.dojo_plans?.name
              ? `${member.covered_by_member.dojo_plans.name}`
              : "Family plan"}
            {member?.family_groups?.name ? ` · ${member.family_groups.name}` : ""} — nothing to
            pay here. Contact your gym to make changes to the plan.
          </p>
          {familyPricing?.mode === "tiered" && familyPricing.quote && (
            <div className="mt-3">
              <FamilyPricingBreakdown
                quote={familyPricing.quote}
                title="How your family plan is priced"
                passPlatformFeeToMembers={!!familyPricing.passPlatformFee}
                platformFeePercent={PLATFORM_FEE_PERCENT}
              />
            </div>
          )}
        </div>
      )}

      {!isCovered && familyPricing?.isPayer && familyPricing.mode === "tiered" && familyPricing.quote && (
        <div className="mb-4 rounded-lg bg-violet-50 px-3 py-3 ring-1 ring-violet-500/20">
          <p className="text-sm font-semibold text-violet-900">
            Payer: you — you pay for {familyPricing.groupName ?? "your family"} (
            {familyPricing.quote.size} member{familyPricing.quote.size === 1 ? "" : "s"}).
          </p>
          <div className="mt-3">
            <FamilyPricingBreakdown
              quote={familyPricing.quote}
              title="Your family total"
              passPlatformFeeToMembers={!!familyPricing.passPlatformFee}
              platformFeePercent={PLATFORM_FEE_PERCENT}
            />
          </div>
        </div>
      )}




      {awaitingDirectDebit && !isCovered && (
        <div className="mb-4 rounded-lg bg-sky-50 px-3 py-3 ring-1 ring-sky-500/20">
          <p className="text-sm font-semibold text-sky-900">
            Your direct debit is being set up
          </p>
          <p className="mt-1 text-sm text-sky-900/80">
            {directDebitPendingMessage({
              method: member?.payment_method,
              expected: ddExpected,
            })}
          </p>
        </div>
      )}

      {canPay && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-amber-100 px-3 py-2 ring-1 ring-amber-500/20">
          <p className="text-sm text-amber-900">
            {member?.payment_status === "overdue"
              ? "Your payment is overdue. Please update your subscription."
              : "Complete your payment to activate your membership."}
          </p>
          <Button size="sm" onClick={startCheckout} disabled={loading}>
            {loading ? "Redirecting…" : "Pay now"}
          </Button>
        </div>
      )}


      {isCovered ? null : isCash && !subscription ? (
        <p className="text-sm text-muted-foreground">
          You're set up to pay in cash at the dojo
          {plan?.name ? ` for ${plan.name}` : ""}. No card needed — your gym records each
          payment for you.
        </p>
      ) : !subscription ? (

        <p className="text-sm text-muted-foreground">
          {member?.selected_plan_id
            ? "No active subscription yet."
            : "No plan yet \u2014 choose one in \u201cStart your membership\u201d above."}
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-display text-lg font-medium">{plan?.name ?? "Plan"}</div>
              <div className="text-xs text-muted-foreground">
                Billed {plan?.interval ?? "—"}
              </div>
            </div>
            {awaitingDirectDebit ? (
              <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-medium text-sky-800 ring-1 ring-sky-600/20">
                Awaiting first collection
              </span>
            ) : (
              <StatusChip status={subscription.status} />
            )}
          </div>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm md:grid-cols-2">
            <Field
              label="Next payment"
              value={
                subscription.current_period_end
                  ? new Date(subscription.current_period_end).toLocaleDateString()
                  : "—"
              }
            />
            <Field
              label="Started"
              value={
                subscription.current_period_start
                  ? new Date(subscription.current_period_start).toLocaleDateString()
                  : "—"
              }
            />
          </dl>
        </div>
      )}

      {/* Below the member's OWN plan, never above it: a parent's first
          question here is what they themselves are on. Any adult member sees
          this, not only a family payer -- naming your own child has nothing to
          do with who holds a subscription. */}
      {member?.dojo_id && <AddChildDialog dojoId={member.dojo_id} />}
      {/* The children already added, so one whose payment didn't complete is
          visible and reachable rather than only in the database. */}
      {member?.dojo_id && <MyChildren dojoId={member.dojo_id} />}

      {!isCash && !isCovered && (
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-zinc-950/5 pt-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Payment</div>
          <MemberPaymentAction
            memberId={member?.id}
            dojoId={dojoId}
            billing={billing.data}
            returnPath="/portal"
          />
        </div>
      )}

    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-medium">{value}</dd>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: "bg-emerald-100 text-emerald-700 ring-emerald-600/20",
    trialing: "bg-blue-100 text-blue-700 ring-blue-600/20",
    past_due: "bg-amber-100 text-amber-700 ring-amber-600/20",
    canceled: "bg-zinc-200 text-zinc-700 ring-zinc-600/20",
    incomplete: "bg-zinc-200 text-zinc-700 ring-zinc-600/20",
  };
  const cls = map[status] ?? "bg-zinc-200 text-zinc-700 ring-zinc-600/20";
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${cls}`}>
      {status.replace("_", " ")}
    </span>
  );
}
