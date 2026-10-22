import { PUBLIC_SITE_URL } from "@/lib/site";
import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { formatDistanceToNow } from "date-fns";
import { PageHeader } from "@/components/PageHeader";
import { RefreshControl } from "@/components/RefreshControl";
import { BeltChip, MemberAvatar } from "@/components/BeltChip";
import { Button } from "@/components/ui/button";
import { RevenueVsOverheadCard } from "@/components/RevenueVsOverheadCard";
import { RetentionImpactPanel } from "@/components/RetentionImpactPanel";
import { QuickCheckinDialog } from "@/components/QuickCheckinDialog";
import { AddMemberDialog } from "@/components/AddMemberDialog";
import { DisputeAlerts } from "@/components/DisputeAlerts";
import { StaffTasksPanel } from "@/components/StaffTasksPanel";
import { PaymentFailureAlerts } from "@/components/PaymentFailureAlerts";

import { OnboardingChecklist } from "@/components/OnboardingChecklist";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { getRevenueSummary, formatMoney } from "@/lib/revenue.functions";
import { isCashPayer } from "@/lib/cash-payments";
import { ArrowRight, Plus, ScanLine } from "lucide-react";


async function fetchActiveMembersKpi(dojoId: string) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const [activeRes, newRes] = await Promise.all([
    supabase
      .from("members")
      .select("id", { count: "exact", head: true })
      .eq("dojo_id", dojoId)
      .eq("status", "active"),
    supabase
      .from("members")
      .select("id", { count: "exact", head: true })
      .eq("dojo_id", dojoId)
      .gte("joined_at", monthStart),
  ]);
  if (activeRes.error) throw activeRes.error;
  if (newRes.error) throw newRes.error;
  return { active: activeRes.count ?? 0, newThisMonth: newRes.count ?? 0 };
}

async function fetchPaymentSetup(dojoId: string) {
  const [activeRes, subsRes, paidRes] = await Promise.all([
    supabase
      .from("members")
      .select("id, payment_method")
      .eq("dojo_id", dojoId)
      .eq("status", "active"),
    supabase
      .from("member_subscriptions")
      .select("member_id")
      .eq("dojo_id", dojoId)
      .in("status", ["active", "trialing", "past_due"]),
    supabase
      .from("invoices")
      .select("member_id")
      .eq("dojo_id", dojoId)
      .eq("status", "paid"),
  ]);
  if (activeRes.error) throw activeRes.error;
  if (subsRes.error) throw subsRes.error;
  if (paidRes.error) throw paidRes.error;
  const paying = new Set<string>();
  for (const s of subsRes.data ?? []) paying.add(s.member_id);
  for (const i of paidRes.data ?? []) if (i.member_id) paying.add(i.member_id);
  // Only card members can "set up payment" — cash members are excluded from
  // both numerator and denominator so mixed gyms don't look broken.
  const activeMembers = activeRes.data ?? [];
  const cardMembers = activeMembers.filter((m) => !isCashPayer(m.payment_method));
  const cashCount = activeMembers.length - cardMembers.length;
  const setUp = cardMembers.filter((m) => paying.has(m.id)).length;
  return { active: cardMembers.length, withCard: setUp, cashCount };
}





async function fetchRoster(dojoId: string) {
  const { data, error } = await supabase
    .from("members")
    .select("id, name, discipline, belt_color, belt_label, stripes, dan, plan, status, last_seen_at")
    .eq("dojo_id", dojoId)
    .eq("status", "active")
    .order("last_seen_at", { ascending: false, nullsFirst: false })
    .limit(6);
  if (error) throw error;
  return data ?? [];
}

async function fetchTodaysClasses(dojoId: string) {
  const weekday = new Date().getDay();
  const { data, error } = await supabase
    .from("classes")
    .select("id, name, discipline, instructor, start_time, end_time, capacity")
    .eq("dojo_id", dojoId)
    .eq("weekday", weekday)
    .order("start_time");
  if (error) throw error;
  return data ?? [];
}

async function fetchRecentActivity(dojoId: string) {
  const { data, error } = await supabase
    .from("attendances")
    .select("id, class_id, checked_in_at, members(name), classes(name)")
    .eq("dojo_id", dojoId)
    .order("checked_in_at", { ascending: false })
    .limit(5);
  if (error) throw error;
  return data ?? [];
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dojo Overview \u2014 Sthenos" },
      { name: "description", content: "Operational dashboard for your dojo: members, attendance, classes, ranks, and billing at a glance." },
      { property: "og:title", content: "Dojo Overview \u2014 Sthenos" },
      { property: "og:description", content: "Operational dashboard for your dojo: members, attendance, classes, ranks, and billing at a glance." },
      { property: "og:url", content: `${PUBLIC_SITE_URL}/` },
      { name: "twitter:title", content: "Dojo Overview \u2014 Sthenos" },
      { name: "twitter:description", content: "Operational dashboard for your dojo: members, attendance, classes, ranks, and billing at a glance." },
    ],
    links: [
      { rel: "canonical", href: `${PUBLIC_SITE_URL}/` },
    ],
  }),
  component: Dashboard,
});

function StatCard({
  label,
  value,
  trend,
  trendKind = "neutral",
}: {
  label: string;
  value: string;
  trend?: string;
  trendKind?: "up" | "down" | "neutral" | "alert";
}) {
  const trendColor =
    trendKind === "up"
      ? "text-emerald-600"
      : trendKind === "alert"
      ? "text-amber-600"
      : trendKind === "down"
      ? "text-red-600"
      : "text-muted-foreground";
  return (
    <div className="rounded-xl bg-card p-5 ring-1 ring-border transition-shadow hover:shadow-sm">
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="mt-1 font-display text-3xl font-medium tabular-nums text-card-foreground">{value}</div>
      {trend && <div className={`mt-2 text-[11px] font-medium ${trendColor}`}>{trend}</div>}
    </div>
  );
}

function Skel({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

function Dashboard() {
  const { activeDojoId, activeDojo } = useCurrentDojo();
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [checklistDismissed, setChecklistDismissed] = useState(false);
  const canSeeChecklist =
    !!activeDojoId &&
    (activeDojo?.role === "owner" || activeDojo?.role === "admin") &&
    !checklistDismissed &&
    typeof window !== "undefined" &&
    localStorage.getItem(`checklist_dismissed_${activeDojoId}`) !== "true";
  const revFn = useServerFn(getRevenueSummary);
  const { data: rev } = useQuery({
    queryKey: ["dash-revenue-summary", activeDojoId],
    queryFn: () => revFn({ data: { dojoId: activeDojoId! } }),
    enabled: !!activeDojoId,
  });
  const { data: membersKpi } = useQuery({
    queryKey: ["dash-members-kpi", activeDojoId],
    queryFn: () => fetchActiveMembersKpi(activeDojoId!),
    enabled: !!activeDojoId,
  });
  const { data: roster, isLoading: rosterLoading } = useQuery({
    queryKey: ["dash-roster", activeDojoId],
    queryFn: () => fetchRoster(activeDojoId!),
    enabled: !!activeDojoId,
  });
  const { data: classes, isLoading: classesLoading } = useQuery({
    queryKey: ["dash-classes-today", activeDojoId],
    queryFn: () => fetchTodaysClasses(activeDojoId!),
    enabled: !!activeDojoId,
  });
  const { data: activity, isLoading: activityLoading } = useQuery({
    queryKey: ["dash-activity", activeDojoId],
    queryFn: () => fetchRecentActivity(activeDojoId!),
    enabled: !!activeDojoId,
  });
  const { data: paySetup } = useQuery({
    queryKey: ["dash-payment-setup", activeDojoId],
    queryFn: () => fetchPaymentSetup(activeDojoId!),
    enabled: !!activeDojoId,
  });

  const fmtTime = (t: string) => t.slice(0, 5);

  const atRiskCount = roster?.filter(
    (m) => m.status === "active" && (!m.last_seen_at || daysSince(m.last_seen_at) > 7),
  ).length;

  const primaryBucket = rev?.currencies[0] ?? null;
  const hasPayments = !!rev?.hasAnyPaymentData;

  return (
    <main>
      <PageHeader
        title="Dojo Overview"
        actions={
          <>
            <RefreshControl />
            <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" /> Add Member
            </Button>
            <Button size="sm" className="bg-brand hover:bg-brand/90 text-brand-foreground" onClick={() => setCheckinOpen(true)}>
              <ScanLine className="size-4" /> Quick Check-in
            </Button>
          </>
        }
      />
      <QuickCheckinDialog open={checkinOpen} onOpenChange={setCheckinOpen} />
      <AddMemberDialog open={addOpen} onOpenChange={setAddOpen} />


      <div className="mx-auto max-w-7xl space-y-8 p-8">
        <DisputeAlerts dojoId={activeDojoId ?? null} />
        <PaymentFailureAlerts dojoId={activeDojoId ?? null} />
        {/* Everything else the system has flagged for a person. Payment
            failures are excluded there -- the panel above says it better. */}
        <StaffTasksPanel dojoId={activeDojoId ?? null} />


        {canSeeChecklist && activeDojoId && (
          <OnboardingChecklist dojoId={activeDojoId} onDismiss={() => setChecklistDismissed(true)} />
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Active Members"
            value={membersKpi ? membersKpi.active.toString() : "—"}
            trend={membersKpi ? `+${membersKpi.newThisMonth} this month` : undefined}
            trendKind="up"
          />
          <StatCard
            label="Collected this month"
            value={
              !rev
                ? "—"
                : hasPayments && primaryBucket
                  ? formatMoney(primaryBucket.revenueThisMonthCents, primaryBucket.currency)
                  : "No payments yet"
            }
            trend={
              hasPayments && primaryBucket
                ? `vs ${formatMoney(primaryBucket.revenueLastMonthCents, primaryBucket.currency)} last month`
                : "Paid invoices"
            }
            trendKind={hasPayments ? "up" : "neutral"}
          />
          <StatCard
            label="Monthly membership revenue"
            value={
              !rev
                ? "—"
                : hasPayments && primaryBucket
                  ? formatMoney(primaryBucket.mrrCents, primaryBucket.currency)
                  : "No payments yet"
            }
            trend={
              hasPayments && primaryBucket
                ? `Yearly ${formatMoney(primaryBucket.arrCents, primaryBucket.currency)}`
                : "Active subscriptions"
            }
            trendKind={hasPayments ? "up" : "neutral"}
          />
          <Link
            to="/members"
            search={{ payment: "unpaid" } as any}
            className="block"
          >
            <StatCard
              label="Outstanding this month"
              value={
                !rev
                  ? "—"
                  : hasPayments && primaryBucket
                    ? formatMoney(primaryBucket.outstandingThisMonthCents, primaryBucket.currency)
                    : "—"
              }
              trend="Owed this month · chase overdue"
              trendKind="alert"
            />
          </Link>
        </div>

        {rev && rev.currencies.length > 1 && (
          <div className="rounded-xl bg-card p-4 ring-1 ring-border">
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Revenue by currency
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {rev.currencies.map((b) => (
                <div key={b.currency} className="rounded-lg border border-border p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {b.currency.toUpperCase()}
                  </div>
                  <div className="mt-1 font-display text-lg font-medium tabular-nums">
                    Monthly {formatMoney(b.mrrCents, b.currency)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatMoney(b.revenueThisMonthCents, b.currency)} this month ·{" "}
                    {b.activeSubscriptions + (b.cashMembers ?? 0)} active
                    {b.cashMembers ? ` (${b.cashMembers} cash)` : ""}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}


        <PaymentSetupCard data={paySetup} />


        <RevenueVsOverheadCard />

        <RetentionImpactPanel compact />

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          <section className="space-y-4 lg:col-span-8">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-xl font-medium">Active Roster</h2>
              <Button variant="link" size="sm" asChild className="text-muted-foreground">
                <Link to="/members">View all members <ArrowRight className="size-3" /></Link>
              </Button>
            </div>
            <div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    <th className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Student</th>
                    <th className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Discipline</th>
                    <th className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Current Rank</th>
                    <th className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Last Seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rosterLoading || !roster
                    ? Array.from({ length: 6 }).map((_, i) => (
                        <tr key={i}>
                          <td className="px-6 py-3"><Skel className="h-8 w-40" /></td>
                          <td className="px-6 py-3"><Skel className="h-4 w-20" /></td>
                          <td className="px-6 py-3"><Skel className="h-5 w-24" /></td>
                          <td className="px-6 py-3"><Skel className="h-4 w-16" /></td>
                        </tr>
                      ))
                    : roster.map((m) => (
                        <tr key={m.id} className="transition-colors hover:bg-muted/30">
                          <td className="px-6 py-3">
                            <div className="flex items-center gap-3">
                              <MemberAvatar name={m.name} />
                              <div className="min-w-0">
                                <div className="truncate max-w-[200px] text-sm font-medium text-card-foreground">{m.name}</div>
                                <div className="truncate max-w-[200px] text-[11px] text-muted-foreground">{m.plan}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-3 text-sm text-muted-foreground">{m.discipline}</td>
                          <td className="px-6 py-3">
                            <BeltChip
                              belt={{
                                color: m.belt_color,
                                label: m.belt_label,
                                stripes: m.stripes ?? 0,
                                dan: m.dan ?? undefined,
                              }}
                              discipline={m.discipline}
                            />
                          </td>
                          <td className="px-6 py-3 text-sm text-muted-foreground">
                            {m.last_seen_at
                              ? formatDistanceToNow(new Date(m.last_seen_at), { addSuffix: true })
                              : "—"}
                          </td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
          </section>

          <aside className="space-y-8 lg:col-span-4">
            <section className="space-y-4">
              <h2 className="font-display text-xl font-medium">Today's Schedule</h2>
              <div className="space-y-3">
                {classesLoading || !classes ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <Skel key={i} className="h-20 w-full" />
                  ))
                ) : classes.length === 0 ? (
                  <div className="rounded-xl bg-card p-4 text-sm text-muted-foreground ring-1 ring-border">
                    No classes scheduled today.
                  </div>
                ) : (
                  classes.map((c) => (
                    <div key={c.id} className="rounded-xl bg-card p-4 ring-1 ring-border">
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="text-sm font-semibold text-card-foreground">{c.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {fmtTime(c.start_time)}–{fmtTime(c.end_time)} · {c.instructor}
                          </div>
                        </div>
                        <span className="text-[11px] font-medium text-muted-foreground tabular-nums">
                          —/{c.capacity}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="space-y-4">
              <h2 className="font-display text-xl font-medium">Recent Activity</h2>
              <div className="relative space-y-5 before:absolute before:bottom-2 before:left-2.5 before:top-2 before:w-px before:bg-border">
                {activityLoading || !activity ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="relative pl-8">
                      <Skel className="h-4 w-full" />
                    </div>
                  ))
                ) : activity.length === 0 ? (
                  <div className="relative pl-8 text-sm text-muted-foreground">No recent activity.</div>
                ) : (
                  activity.map((a) => {
                    const row = a as unknown as {
                      members: { name: string } | null;
                      classes: { name: string } | null;
                    };
                    const memberName = row.members?.name ?? "Unknown";
                    const className = row.classes?.name ?? "open mat";
                    return (
                      <div key={a.id} className="relative pl-8">
                        <div className="absolute left-0 top-1.5 size-5 rounded-full border-4 border-background bg-muted ring-1 ring-border" />
                        <p className="text-sm leading-relaxed text-card-foreground">
                          <span className="font-semibold">Check-in:</span> {memberName} → {className}
                        </p>
                        <span className="text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(a.checked_in_at), { addSuffix: true })}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}

function PaymentSetupCard({
  data,
}: {
  data?: { active: number; withCard: number; cashCount: number };
}) {
  const active = data?.active ?? 0;
  const withCard = data?.withCard ?? 0;
  const cashCount = data?.cashCount ?? 0;
  // No card members at all (e.g. cash-only gym) reads as healthy, not broken.
  const pct = active > 0 ? Math.min(100, Math.round((withCard / active) * 100)) : 100;
  const complete = withCard >= active;
  const barColor = complete ? "bg-emerald-500" : "bg-amber-500";
  const labelColor = complete ? "text-emerald-700" : "text-amber-700";
  return (
    <div className="rounded-xl bg-card p-5 ring-1 ring-border">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Payment setup</span>
        <span className={`text-xs font-semibold ${labelColor}`}>{pct}%</span>
      </div>
      <div className="mt-2 font-display text-lg font-medium tabular-nums text-card-foreground">
        {data ? `${withCard} / ${active} card members have payment set up` : "—"}
      </div>
      {data && (
        <div className="mt-1 text-xs text-muted-foreground">
          {`${withCard} of ${active} card ${active === 1 ? "member" : "members"} set up`}
          {cashCount > 0 ? ` · ${cashCount} on cash` : ""}
        </div>
      )}
      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${barColor} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

