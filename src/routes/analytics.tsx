import { PUBLIC_SITE_URL } from "@/lib/site";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { PageHeader } from "@/components/PageHeader";
import { RefreshControl } from "@/components/RefreshControl";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { useServerFn } from "@tanstack/react-start";
import { getRevenueSummary, formatMoney, type RevenueSummary } from "@/lib/revenue.functions";
import { cn } from "@/lib/utils";
import { Download, TrendingDown, TrendingUp } from "lucide-react";
import { ReportBuilder } from "@/components/ReportBuilder";
import { RetentionImpactPanel } from "@/components/RetentionImpactPanel";


export const Route = createFileRoute("/analytics")({
  head: () => ({
    meta: [
      { title: "Analytics \u2014 Sthenos" },
      { name: "description", content: "Revenue, churn, retention cohorts, LTV, attendance trends, and class fill rate for your dojo." },
      { property: "og:title", content: "Analytics \u2014 Sthenos" },
      { property: "og:description", content: "Revenue, churn, retention cohorts, LTV, attendance trends, and class fill rate for your dojo." },
      { property: "og:url", content: `${PUBLIC_SITE_URL}/analytics` },
      { name: "twitter:title", content: "Analytics \u2014 Sthenos" },
      { name: "twitter:description", content: "Revenue, churn, retention cohorts, LTV, attendance trends, and class fill rate for your dojo." },
    ],
    links: [
      { rel: "canonical", href: `${PUBLIC_SITE_URL}/analytics` },
    ],
  }),
  component: AnalyticsPage,
});

// ───────────── data layer ─────────────

type InvoiceRow = {
  id: string;
  member_id: string;
  amount_cents: number;
  status: "due" | "paid" | "overdue" | "void";
  paid_at: string | null;
  due_date: string;
  plan: string;
};

type MemberRow = {
  id: string;
  name: string;
  status: "active" | "lapsed" | "trial";
  plan: string;
  joined_at: string;
  last_seen_at: string | null;
};

type AttendanceRow = { class_id: string | null; checked_in_at: string; member_id: string };
type ClassRow = { id: string; name: string; capacity: number; weekday: number };

async function fetchAnalytics(dojoId: string) {
  const [inv, mem, att, cls, pro] = await Promise.all([
    supabase.from("invoices").select("id,member_id,amount_cents,status,paid_at,due_date,plan").eq("dojo_id", dojoId),
    supabase.from("members").select("id,name,status,plan,discipline,belt_color,joined_at,last_seen_at").eq("dojo_id", dojoId),
    supabase.from("attendances").select("class_id,checked_in_at,member_id").eq("dojo_id", dojoId),
    supabase.from("classes").select("id,name,capacity,weekday").eq("dojo_id", dojoId),
    supabase.from("promotions").select("id,member_id,discipline,to_color,to_label,promoted_at").eq("dojo_id", dojoId),
  ]);
  if (inv.error) throw inv.error;
  if (mem.error) throw mem.error;
  if (att.error) throw att.error;
  if (cls.error) throw cls.error;
  if (pro.error) throw pro.error;
  return {
    invoices: (inv.data ?? []) as InvoiceRow[],
    members: (mem.data ?? []) as MemberRow[],
    attendances: (att.data ?? []) as AttendanceRow[],
    classes: (cls.data ?? []) as ClassRow[],
    promotions: (pro.data ?? []) as any[],
  };
}


// ───────────── helpers ─────────────

const monthKey = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const monthLabel = (k: string) => {
  const [y, m] = k.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleString(undefined, {
    month: "short",
    year: "2-digit",
  });
};
const lastNMonths = (n: number) => {
  const out: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(monthKey(d));
  }
  return out;
};
const fmtMoneyCur = (cents: number, currency: string) => formatMoney(cents, currency);

// ───────────── page ─────────────

function AnalyticsPage() {
  const { activeDojoId } = useCurrentDojo();
  const revFn = useServerFn(getRevenueSummary);
  const { data, isLoading } = useQuery({
    queryKey: ["analytics", activeDojoId],
    queryFn: () => fetchAnalytics(activeDojoId!),
    enabled: !!activeDojoId,
  });
  const { data: revenue } = useQuery({
    queryKey: ["analytics-revenue-summary", activeDojoId],
    queryFn: () => revFn({ data: { dojoId: activeDojoId! } }),
    enabled: !!activeDojoId,
  });

  const metrics = useMemo(
    () => (data && revenue ? computeMetrics(data, revenue) : null),
    [data, revenue],
  );

  return (
    <>
      <PageHeader
        title="Analytics"
        subtitle="Revenue, retention, and attendance signal for your dojo."
        actions={<RefreshControl />}
      />
      <div className="px-8 py-8 space-y-6">
        <Tabs defaultValue="dashboards">
          <TabsList>
            <TabsTrigger value="dashboards">Dashboards</TabsTrigger>
            <TabsTrigger value="reports">Reports</TabsTrigger>
            <TabsTrigger value="builder">Builder</TabsTrigger>
          </TabsList>

          <TabsContent value="dashboards" className="mt-8">
            {isLoading || !activeDojoId || !metrics ? (
              <div className="text-sm text-muted-foreground">Loading metrics…</div>
            ) : (
              <div className="space-y-6">
                <Dashboards m={metrics} />
                <RetentionImpactPanel />
                <LeadSourcesCard dojoId={activeDojoId} />
              </div>
            )}
          </TabsContent>


          <TabsContent value="reports" className="mt-8">
            {metrics ? <Reports m={metrics} /> : null}
          </TabsContent>

          <TabsContent value="builder" className="mt-8">
            {data ? (
              <ReportBuilder data={data} />
            ) : (
              <div className="text-sm text-muted-foreground">Loading data…</div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

// ───────────── computation ─────────────

type Metrics = ReturnType<typeof computeMetrics>;

function computeMetrics(
  d: Awaited<ReturnType<typeof fetchAnalytics>>,
  revenue: RevenueSummary,
) {
  const months = lastNMonths(12);
  const primary = revenue.currencies[0] ?? null;
  const currency = primary?.currency ?? revenue.defaultCurrency ?? "usd";

  // MRR trend: from getRevenueSummary (per-currency, primary bucket) — real Stripe-fed data
  const monthMap = new Map<string, number>(
    (primary?.revenueByMonth ?? []).map((r) => [r.month, r.cents]),
  );
  const mrrSeries = months.map((k) => ({
    month: monthLabel(k),
    mrr: (monthMap.get(k) ?? 0) / 100,
  }));
  const currentMRR = primary?.revenueThisMonthCents ?? 0;
  const prevMRR = primary?.revenueLastMonthCents ?? 0;
  const mrrDelta = prevMRR ? ((currentMRR - prevMRR) / prevMRR) * 100 : 0;
  const mrrRun = primary?.mrrCents ?? 0;
  const arr = primary?.arrCents ?? 0;
  const overdue = primary?.overdueCents ?? 0;

  // Active / lapsed
  const active = d.members.filter((m) => m.status === "active").length;
  const lapsed = d.members.filter((m) => m.status === "lapsed").length;
  const total = d.members.length;
  const churn = total ? (lapsed / total) * 100 : 0;

  // LTV: from getRevenueSummary (primary bucket)
  const ltv = primary?.ltvCents ?? 0;

  // Attendance trend: last 12 weeks
  const weeks: { key: string; label: string; start: Date }[] = [];
  const now = new Date();
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
  monday.setUTCHours(0, 0, 0, 0);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() - i * 7);
    weeks.push({
      key: d.toISOString(),
      label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      start: d,
    });
  }
  const attByWeek = weeks.map((w, idx) => {
    const next = weeks[idx + 1]?.start ?? new Date(w.start.getTime() + 7 * 86400000);
    const count = d.attendances.filter((a) => {
      const t = new Date(a.checked_in_at);
      return t >= w.start && t < next;
    }).length;
    return { week: w.label, checkins: count };
  });

  // Retention cohorts: rows = join month, cols = months since join, value = % of cohort active in that month
  const cohortMonths = lastNMonths(6);
  const cohorts = cohortMonths.map((cm) => {
    const members = d.members.filter((m) => monthKey(new Date(m.joined_at)) === cm);
    const size = members.length;
    const buckets = cohortMonths.map((tm, idx) => {
      if (tm < cm || !size) return null;
      const start = new Date(`${tm}-01T00:00:00Z`);
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      const activeIds = new Set(
        d.attendances
          .filter((a) => {
            const t = new Date(a.checked_in_at);
            return t >= start && t < end;
          })
          .map((a) => a.member_id),
      );
      const retained = members.filter((m) => activeIds.has(m.id)).length;
      return { offset: idx, pct: (retained / size) * 100 };
    });
    return { cohort: cm, size, buckets };
  });

  // Class fill rate: avg attendees per session vs capacity
  // Approximate sessions = unique (class_id, ISO-week) pairs in last 8 weeks
  const eightWeeksAgo = new Date(Date.now() - 8 * 7 * 86400000);
  const sessionMap = new Map<string, { count: number; capacity: number; name: string }>();
  const classById = new Map(d.classes.map((c) => [c.id, c]));
  d.attendances.forEach((a) => {
    if (!a.class_id) return;
    const t = new Date(a.checked_in_at);
    if (t < eightWeeksAgo) return;
    const c = classById.get(a.class_id);
    if (!c) return;
    const wk = Math.floor(t.getTime() / (7 * 86400000));
    const k = `${a.class_id}:${wk}`;
    const cur = sessionMap.get(k) ?? { count: 0, capacity: c.capacity, name: c.name };
    cur.count += 1;
    sessionMap.set(k, cur);
  });
  const fillByClass = new Map<string, { name: string; total: number; cap: number; sessions: number }>();
  sessionMap.forEach((v) => {
    const cur = fillByClass.get(v.name) ?? { name: v.name, total: 0, cap: v.capacity, sessions: 0 };
    cur.total += v.count;
    cur.sessions += 1;
    fillByClass.set(v.name, cur);
  });
  const fillRate = [...fillByClass.values()]
    .map((c) => ({
      name: c.name,
      fill: c.sessions ? Math.round((c.total / c.sessions / c.cap) * 100) : 0,
    }))
    .sort((a, b) => b.fill - a.fill);

  return {
    mrrSeries,
    currentMRR,
    mrrDelta,
    mrrRun,
    arr,
    overdue,
    currency,
    hasPayments: revenue.hasAnyPaymentData,
    currencies: revenue.currencies,
    active,
    lapsed,
    total,
    churn,
    ltv,
    attByWeek,
    cohorts,
    cohortMonths,
    fillRate,
  };
}

// ───────────── KPI cards ─────────────

function KpiCard({
  label,
  value,
  delta,
  hint,
}: {
  label: string;
  value: string;
  delta?: number;
  hint?: string;
}) {
  const up = (delta ?? 0) >= 0;
  return (
    <div className="rounded-lg border border-zinc-950/5 bg-card p-5">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 font-display text-3xl font-medium tracking-tight">{value}</div>
      <div className="mt-1 flex items-center gap-1.5 text-xs">
        {delta !== undefined ? (
          <span
            className={cn(
              "inline-flex items-center gap-1 font-medium",
              up ? "text-emerald-600" : "text-rose-600",
            )}
          >
            {up ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
            {Math.abs(delta).toFixed(1)}%
          </span>
        ) : null}
        {hint ? <span className="text-muted-foreground">{hint}</span> : null}
      </div>
    </div>
  );
}

// ───────────── dashboards tab ─────────────

function Dashboards({ m }: { m: Metrics }) {
  const cur = m.currency;
  return (
    <div className="space-y-8">
      {!m.hasPayments && (
        <div className="rounded-lg border border-dashed border-zinc-950/10 bg-card/40 p-6 text-center text-sm text-muted-foreground">
          No payments yet. Revenue metrics will appear here once your gym receives its first payment through Stripe.
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Collected this month"
          value={m.hasPayments ? fmtMoneyCur(m.currentMRR, cur) : "—"}
          delta={m.hasPayments ? m.mrrDelta : undefined}
          hint="vs last month"
        />
        <KpiCard
          label="Monthly membership revenue"
          value={m.hasPayments ? fmtMoneyCur(m.mrrRun, cur) : "—"}
          hint={m.hasPayments ? `Yearly ${fmtMoneyCur(m.arr, cur)}` : "Active subscriptions"}
        />
        <KpiCard
          label="Overdue"
          value={m.hasPayments ? fmtMoneyCur(m.overdue, cur) : "—"}
          hint="Unpaid or past due"
        />
        <KpiCard
          label="Avg LTV"
          value={m.hasPayments ? fmtMoneyCur(m.ltv, cur) : "—"}
          hint="paid revenue per member"
        />
      </div>

      {m.currencies.length > 1 && (
        <div className="rounded-lg border border-zinc-950/5 bg-card p-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Revenue by currency
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {m.currencies.map((b) => (
              <div key={b.currency} className="rounded border border-border p-3 text-xs">
                <div className="font-semibold uppercase tracking-wider text-muted-foreground">
                  {b.currency.toUpperCase()}
                </div>
                <div className="mt-1">Monthly {fmtMoneyCur(b.mrrCents, b.currency)}</div>
                <div className="text-muted-foreground">
                  {fmtMoneyCur(b.revenueThisMonthCents, b.currency)} this month
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartCard title="Revenue — last 12 months">
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={m.mrrSeries} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: number) => fmtMoneyCur(Math.round(v * 100), cur)} />
              <Line type="monotone" dataKey="mrr" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>


        <ChartCard title="Attendance — last 12 weeks">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={m.attByWeek} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="week" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="checkins" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard title="Retention cohorts">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground">
                <th className="py-2 pr-4 text-left font-medium">Cohort</th>
                <th className="py-2 pr-4 text-left font-medium">Size</th>
                {m.cohortMonths.map((cm) => (
                  <th key={cm} className="py-2 pr-2 text-left font-medium">
                    {monthLabel(cm)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {m.cohorts.map((c) => (
                <tr key={c.cohort} className="border-t border-zinc-950/5">
                  <td className="py-2 pr-4 font-medium">{monthLabel(c.cohort)}</td>
                  <td className="py-2 pr-4 text-muted-foreground">{c.size}</td>
                  {c.buckets.map((b, i) => (
                    <td key={i} className="py-1 pr-2">
                      {b ? (
                        <div
                          className="rounded px-2 py-1 text-center font-medium"
                          style={{
                            background: `color-mix(in oklab, hsl(var(--primary)) ${Math.round(b.pct)}%, transparent)`,
                            color: b.pct > 50 ? "white" : "inherit",
                          }}
                        >
                          {Math.round(b.pct)}%
                        </div>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>

      <ChartCard title="Class fill rate (last 8 weeks)">
        {m.fillRate.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">No class attendance recorded yet.</div>
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(180, m.fillRate.length * 32)}>
            <BarChart data={m.fillRate} layout="vertical" margin={{ top: 4, right: 24, left: 80, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11 }} unit="%" />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={120} />
              <Tooltip formatter={(v: number) => `${v}%`} />
              <Bar dataKey="fill" fill="hsl(var(--primary))" radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </div>
  );
}

function LeadSourcesCard({ dojoId }: { dojoId: string | null }) {
  const { data, isLoading } = useQuery({
    queryKey: ["analytics-lead-sources", dojoId],
    enabled: !!dojoId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("members")
        .select("lead_source, referred_by")
        .eq("dojo_id", dojoId!);
      if (error) throw error;
      return (data ?? []) as { lead_source: string | null; referred_by: string | null }[];
    },
  });

  const { sources, referrers, total } = useMemo(() => {
    const rows = data ?? [];
    const srcMap = new Map<string, number>();
    const refMap = new Map<string, number>();
    let known = 0;
    for (const r of rows) {
      const src = (r.lead_source ?? "").trim();
      if (src) {
        known += 1;
        srcMap.set(src, (srcMap.get(src) ?? 0) + 1);
      }
      const ref = (r.referred_by ?? "").trim();
      if (ref) refMap.set(ref, (refMap.get(ref) ?? 0) + 1);
    }
    return {
      total: known,
      sources: [...srcMap.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      referrers: [...refMap.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
    };
  }, [data]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartCard title="Lead sources">
        {isLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : sources.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No lead sources recorded yet — ask new members how they heard about you at signup.
          </div>
        ) : (
          <div className="space-y-3">
            {sources.map((s) => {
              const pct = total ? Math.round((s.count / total) * 100) : 0;
              return (
                <div key={s.name}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span>{s.name}</span>
                    <span className="text-muted-foreground">
                      {s.count} · {pct}%
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 w-full rounded-full bg-muted">
                    <div
                      className="h-1.5 rounded-full bg-primary"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </ChartCard>

      <ChartCard title="Top referrers">
        {isLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : referrers.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No referrals recorded yet.
          </div>
        ) : (
          <ul className="divide-y divide-zinc-950/5 text-sm">
            {referrers.map((r) => (
              <li key={r.name} className="flex items-center justify-between py-2">
                <span>{r.name}</span>
                <span className="text-muted-foreground">
                  {r.count} referral{r.count === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </ChartCard>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-950/5 bg-card p-5">
      <div className="mb-4 text-sm font-semibold">{title}</div>
      {children}
    </div>
  );
}

// ───────────── reports tab ─────────────

function Reports({ m }: { m: Metrics }) {
  const reports = [
    {
      name: "Revenue by month",
      desc: "Paid invoice totals for the last 12 months.",
      rows: () => [["month", "revenue_usd"], ...m.mrrSeries.map((r) => [r.month, r.mrr.toString()])],
    },
    {
      name: "Weekly attendance",
      desc: "Total check-ins per week for the last 12 weeks.",
      rows: () => [["week_start", "checkins"], ...m.attByWeek.map((r) => [r.week, String(r.checkins)])],
    },
    {
      name: "Retention cohorts",
      desc: "Percent of each join-month cohort that checked in during subsequent months.",
      rows: () => {
        const header = ["cohort", "size", ...m.cohortMonths.map(monthLabel)];
        const body = m.cohorts.map((c) => [
          monthLabel(c.cohort),
          String(c.size),
          ...c.buckets.map((b) => (b ? `${Math.round(b.pct)}%` : "")),
        ]);
        return [header, ...body];
      },
    },
    {
      name: "Class fill rate",
      desc: "Average attendees per session vs capacity, last 8 weeks.",
      rows: () => [["class", "fill_rate_pct"], ...m.fillRate.map((r) => [r.name, String(r.fill)])],
    },
  ];

  return (
    <div className="space-y-3">
      <p className="max-w-2xl text-sm text-muted-foreground">
        Export the dashboards as CSV snapshots. Schedule and dashboard-builder support coming next — let us know which
        report you want pinned to a dashboard.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {reports.map((r) => (
          <div
            key={r.name}
            className="flex items-start justify-between gap-4 rounded-lg border border-zinc-950/5 bg-card p-5"
          >
            <div className="min-w-0">
              <div className="text-sm font-semibold">{r.name}</div>
              <div className="mt-1 text-xs text-muted-foreground">{r.desc}</div>
            </div>
            <Button size="sm" variant="outline" onClick={() => downloadCsv(r.name, r.rows())}>
              <Download className="size-4" />
              CSV
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function downloadCsv(name: string, rows: string[][]) {
  const csv = rows
    .map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.toLowerCase().replace(/\s+/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
