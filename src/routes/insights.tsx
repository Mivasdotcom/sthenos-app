import { PUBLIC_SITE_URL } from "@/lib/site";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { WEEK_DISPLAY } from "@/lib/weekdays";

import { RefreshControl } from "@/components/RefreshControl";
import { BeltChip, MemberAvatar } from "@/components/BeltChip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Sparkles,
  AlertTriangle,
  ShieldCheck,
  Award,
  RefreshCcw,
  ChevronRight,
  Flame,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Mail,
  Phone,
  Target,
  Plus,
  Trash2,
  CalendarClock,
  Users,
  BookOpen,
  Loader2,
} from "lucide-react";
import {
  getClassRecommendations,
  getPeerMatches,
  setPartnerMatching,

} from "@/lib/member-ai.functions";
import { toast } from "sonner";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { cn } from "@/lib/utils";
import {
  getLeadConversion,
  getRevenueForecast,
} from "@/lib/ai-insights.functions";
import { type Belt, type BeltColor, type Discipline } from "@/lib/belt-colors";
import { useAuth } from "@/hooks/use-auth";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { supabase } from "@/integrations/supabase/client";
import { scoreRetentionRisk, type MemberRiskScore } from "@/lib/retention";
import { listPlaybookActionsByMember } from "@/lib/workflows.functions";
import { assessReadiness, type ReadinessResult } from "@/lib/belt-readiness";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Check, X, Printer, Download } from "lucide-react";
import { RetentionMessageDialog } from "@/components/RetentionMessageDialog";


export const Route = createFileRoute("/insights")({
  head: () => ({
    meta: [
      { title: "AI Insights \u2014 Sthenos" },
      { name: "description", content: "Retention risk, belt readiness, trial lead scoring, and revenue forecasting from your dojo data." },
      { property: "og:title", content: "AI Insights \u2014 Sthenos" },
      { property: "og:description", content: "Retention risk, belt readiness, trial lead scoring, and revenue forecasting from your dojo data." },
      { property: "og:url", content: `${PUBLIC_SITE_URL}/insights` },
      { name: "twitter:title", content: "AI Insights \u2014 Sthenos" },
      { name: "twitter:description", content: "Retention risk, belt readiness, trial lead scoring, and revenue forecasting from your dojo data." },
    ],
    links: [
      { rel: "canonical", href: `${PUBLIC_SITE_URL}/insights` },
    ],
  }),
  component: InsightsPage,
});

function fmtMoney(cents: number, currency?: string | null, fallback: string = "usd") {
  const cur = (currency || fallback || "usd").toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: cur,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  } catch {
    return `${cur} ${Math.round(cents / 100).toLocaleString()}`;
  }
}

function InsightsPage() {
  const { isStaff } = useAuth();
  return isStaff ? <StaffInsights /> : <MemberInsights />;
}

function StaffInsights() {
  return (
    <main>
      <PageHeader
        title="AI Insights"
        subtitle="Data-driven recommendations on who needs attention, who's earning their next belt, and where revenue is heading."
        actions={<RefreshControl />}
      />
      <div className="mx-auto max-w-7xl px-8 py-8">
        <Tabs defaultValue="retention">
          <TabsList>
            <TabsTrigger value="retention" className="gap-2">
              <AlertTriangle className="size-3.5" /> Retention Risk
            </TabsTrigger>
            <TabsTrigger value="belt" className="gap-2">
              <Award className="size-3.5" /> Belt Readiness
            </TabsTrigger>
            <TabsTrigger value="leads" className="gap-2">
              <Flame className="size-3.5" /> Lead Scoring
            </TabsTrigger>
            <TabsTrigger value="forecast" className="gap-2">
              <TrendingUp className="size-3.5" /> Revenue Forecast
            </TabsTrigger>
          </TabsList>

          <TabsContent value="retention" className="mt-8">
            <RetentionPanel />
          </TabsContent>
          <TabsContent value="belt" className="mt-8">
            <BeltPanel />
          </TabsContent>
          <TabsContent value="leads" className="mt-8">
            <LeadsPanel />
          </TabsContent>
          <TabsContent value="forecast" className="mt-8">
            <ForecastPanel />
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}

interface PersonalGoal {
  id: string;
  text: string;
  done: boolean;
}

const GOALS_KEY = "sthenos:member-goals";

function loadGoals(): PersonalGoal[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(GOALS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function MemberInsights() {
  const { user } = useAuth();
  const { activeDojoId } = useCurrentDojo();

  const memberQuery = useQuery({
    queryKey: ["my-member", user?.id, activeDojoId],
    enabled: !!user && !!activeDojoId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("members")
        .select(
          "id, name, discipline, belt_color, belt_label, stripes, dan, status, plan, joined_at, last_seen_at",
        )
        .eq("user_id", user!.id)
        .eq("dojo_id", activeDojoId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const member = memberQuery.data;

  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const attendance30dQuery = useQuery({
    queryKey: ["my-attendance-30d", member?.id],
    enabled: !!member?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("attendances")
        .select("id")
        .eq("member_id", member!.id)
        .gte("checked_in_at", since30);
      if (error) throw error;
      return data?.length ?? 0;
    },
  });
  const attendance30d = attendance30dQuery.data ?? 0;

  const since12w = new Date(Date.now() - 12 * 7 * 24 * 60 * 60 * 1000);
  const weeklyQuery = useQuery({
    queryKey: ["my-weekly-attendance", member?.id],
    enabled: !!member?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("attendances")
        .select("checked_in_at")
        .eq("member_id", member!.id)
        .gte("checked_in_at", since12w.toISOString());
      if (error) throw error;
      // Build 12 buckets by ISO week (oldest -> newest)
      const buckets: { week: string; sessions: number; weekStart: number }[] = [];
      // Anchor: start of week containing since12w (Mon-based)
      const startMs = since12w.getTime();
      for (let i = 0; i < 12; i++) {
        const wStart = startMs + i * 7 * 24 * 60 * 60 * 1000;
        buckets.push({ week: `W${i + 1}`, sessions: 0, weekStart: wStart });
      }
      for (const row of data ?? []) {
        const t = new Date(row.checked_in_at as string).getTime();
        const idx = Math.min(11, Math.max(0, Math.floor((t - startMs) / (7 * 24 * 60 * 60 * 1000))));
        buckets[idx].sessions += 1;
      }
      return buckets.map(({ week, sessions }) => ({ week, sessions }));
    },
  });

  // Goals (kept as-is)
  const [goals, setGoals] = useState<PersonalGoal[]>([]);
  const [draft, setDraft] = useState("");
  useEffect(() => setGoals(loadGoals()), []);
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(GOALS_KEY, JSON.stringify(goals));
    }
  }, [goals]);

  const addGoal = () => {
    const text = draft.trim();
    if (!text) return;
    setGoals((g) => [...g, { id: crypto.randomUUID(), text, done: false }]);
    setDraft("");
  };
  const toggle = (id: string) =>
    setGoals((g) => g.map((x) => (x.id === id ? { ...x, done: !x.done } : x)));
  const remove = (id: string) => setGoals((g) => g.filter((x) => x.id !== id));

  const completed = goals.filter((g) => g.done).length;

  if (memberQuery.isLoading || !activeDojoId || !user) {
    return (
      <main>
        <PageHeader
          title="My Progress"
          subtitle="Your training analytics, AI coaching, and personal goals — all in one place."
        />
        <div className="mx-auto max-w-4xl space-y-6 px-8 py-8">
          <div className="h-32 animate-pulse rounded-xl border border-zinc-950/5 bg-card" />
        </div>
      </main>
    );
  }

  if (!member) {
    return (
      <main>
        <PageHeader
          title="My Progress"
          subtitle="Your training analytics, AI coaching, and personal goals — all in one place."
        />
        <div className="mx-auto max-w-4xl space-y-6 px-8 py-8">
          <div className="rounded-xl border border-zinc-950/5 bg-card p-6 text-sm text-muted-foreground">
            Your account isn't linked to a member profile yet. Ask your gym owner to link your account.
          </div>
        </div>
      </main>
    );
  }

  const belt: Belt = {
    color: (member.belt_color ?? "white") as BeltColor,
    label: member.belt_label ?? "White Belt",
    stripes: member.stripes ?? undefined,
    dan: member.dan ?? undefined,
  };

  const consistency = Math.min(100, Math.round((attendance30d / 20) * 100));
  const streak = "—";

  const focus =
    consistency >= 80
      ? "You're training like a future belt-holder. Keep this pace and your next stripe is well within reach."
      : consistency >= 50
        ? "Solid month. Adding one more session per week would put you squarely in the readiness zone."
        : "A couple of missed weeks. Book your next class now — momentum beats motivation.";

  const weekly = weeklyQuery.data ?? Array.from({ length: 12 }, (_, i) => ({ week: `W${i + 1}`, sessions: 0 }));

  const totalSessions = weekly.reduce((s, w) => s + w.sessions, 0);
  const trend =
    weekly.slice(-6).reduce((s, w) => s + w.sessions, 0) -
    weekly.slice(0, 6).reduce((s, w) => s + w.sessions, 0);

  const minutes = weekly.map((w) => ({ week: w.week, minutes: w.sessions * 60 }));

  // Monday-first (UK/European) weekday order.
  const weekdays = WEEK_DISPLAY.map((d) => ({ day: d.label, sessions: 0 }));

  const bestDay = weekdays.reduce((a, b) => (b.sessions > a.sessions ? b : a), weekdays[0]);


  return (
    <main>
      <PageHeader
        title="My Progress"
        subtitle="Your training analytics, AI coaching, and personal goals — all in one place."
      />
      <div className="mx-auto max-w-4xl space-y-6 px-8 py-8">
        <div className="rounded-xl border border-zinc-950/5 bg-card p-6">
          <div className="flex flex-wrap items-center gap-3">
            <div className="text-sm font-semibold">{member.name}</div>
            <BeltChip belt={belt} discipline={member.discipline} />
            <span className="text-xs text-muted-foreground">{member.discipline}</span>
          </div>
          <div className="mt-4 flex items-start gap-2 text-sm">
            <Sparkles className="mt-0.5 size-4 shrink-0 text-brand" />
            <span className="text-zinc-700">{focus}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <PersonalCard label="30-day consistency" value={`${consistency}%`} hint={`${attendance30d} visits`} />
          <PersonalCard label="Current streak" value={streak} hint="Don't break the chain" />
          <PersonalCard
            label="Quarterly trend"
            value={`${trend >= 0 ? "+" : ""}${trend}`}
            hint={trend >= 0 ? "vs prior quarter" : "fewer sessions than prior quarter"}
          />
        </div>

        <div className="rounded-xl border border-zinc-950/5 bg-card p-6">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-medium">Weekly sessions</h2>
            <span className="text-xs text-muted-foreground">{totalSessions} sessions · last 12 weeks</span>
          </div>
          <div className="mt-4 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={weekly} margin={{ left: -20, right: 8, top: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="week" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" allowDecimals={false} />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }}
                />
                <Bar dataKey="sessions" fill="hsl(var(--brand))" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-950/5 bg-card p-6">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-medium">Mat time (minutes)</h2>
            <span className="text-xs text-muted-foreground">last 12 weeks</span>
          </div>
          <div className="mt-4 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={minutes} margin={{ left: -20, right: 8, top: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="week" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Line
                  type="monotone"
                  dataKey="minutes"
                  stroke="hsl(var(--brand))"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-950/5 bg-card p-6">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-medium">Training by weekday</h2>
            <span className="text-xs text-muted-foreground">
              Best day: <strong className="text-zinc-900">{bestDay.day}</strong>
            </span>
          </div>
          <div className="mt-4 h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={weekdays} margin={{ left: -20, right: 8, top: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }} />
                <Bar dataKey="sessions" fill="hsl(var(--brand))" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <ClassRecommendationsCard />
        <PeerMatchesCard />






        <div className="rounded-xl border border-zinc-950/5 bg-card p-6">
          <div className="flex items-center gap-2">
            <Target className="size-4 text-brand" />
            <h2 className="font-display text-base font-medium">My goals</h2>
            {goals.length > 0 ? (
              <span className="ml-auto text-xs text-muted-foreground">
                {completed} / {goals.length} done
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Write down what you're chasing this month — a competition, a technique, a streak. Saved on this device.
          </p>

          <div className="mt-4 flex gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addGoal();
                }
              }}
              placeholder="e.g. Attend 4 classes per week"
            />
            <Button onClick={addGoal} disabled={!draft.trim()}>
              <Plus className="size-4" /> Add
            </Button>
          </div>

          {goals.length > 0 ? (
            <>
              <Progress value={goals.length ? (completed / goals.length) * 100 : 0} className="mt-4 h-2" />
              <ul className="mt-4 space-y-2">
                {goals.map((g) => (
                  <li
                    key={g.id}
                    className="flex items-center gap-3 rounded-lg border border-zinc-950/5 bg-background p-3"
                  >
                    <Checkbox checked={g.done} onCheckedChange={() => toggle(g.id)} />
                    <span className={cn("flex-1 text-sm", g.done && "text-muted-foreground line-through")}>
                      {g.text}
                    </span>
                    <Button variant="ghost" size="icon" onClick={() => remove(g.id)} aria-label="Delete goal">
                      <Trash2 className="size-4 text-muted-foreground" />
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="mt-4 rounded-lg border border-dashed border-zinc-950/10 p-6 text-center text-xs text-muted-foreground">
              No goals yet. Add your first above.
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function PersonalCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border border-zinc-950/5 bg-card p-5">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-2 font-display text-3xl font-medium tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}


// ───────────── Retention ─────────────

function RetentionPanel() {
  const { activeDojoId, activeDojo } = useCurrentDojo();
  const [showHealthy, setShowHealthy] = useState(false);
  const playbookActionsFn = useServerFn(listPlaybookActionsByMember);


  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["retention-risk", activeDojoId],
    enabled: !!activeDojoId,
    staleTime: 30 * 60 * 1000,
    queryFn: async () => {
      const now = Date.now();
      const thirtyDaysAgo = new Date(now - 30 * 86400000).toISOString();
      const sixtyDaysAgo = new Date(now - 60 * 86400000).toISOString();

      const { data: members, error: err } = await supabase
        .from("members")
        .select(
          "id, name, email, belt_color, stripes, joined_at, last_seen_at, attendances(checked_in_at)",
        )
        .eq("dojo_id", activeDojoId!)
        .eq("status", "active")
        .gte("attendances.checked_in_at", sixtyDaysAgo);
      if (err) throw err;

      const { data: bookings, error: bkErr } = await supabase
        .from("class_bookings")
        .select("member_id, booked_for_date, status")
        .eq("dojo_id", activeDojoId!)
        .gte("booked_for_date", thirtyDaysAgo.slice(0, 10));
      if (bkErr) throw bkErr;

      const bookingsByMember = new Map<
        string,
        { booked_for_date: string; status: "booked" | "attended" | "no_show" }[]
      >();
      for (const b of bookings ?? []) {
        const arr = bookingsByMember.get(b.member_id) ?? [];
        arr.push({ booked_for_date: b.booked_for_date, status: b.status as any });
        bookingsByMember.set(b.member_id, arr);
      }

      return (members ?? [])
        .map((m: any) => {
          const atts = (m.attendances ?? []) as { checked_in_at: string }[];
          const recentSessions = atts.filter((a) => a.checked_in_at >= thirtyDaysAgo).length;
          const previousSessions = atts.filter((a) => a.checked_in_at < thirtyDaysAgo).length;
          const score = scoreRetentionRisk({
            id: m.id,
            name: m.name,
            belt_color: m.belt_color ?? "white",
            stripes: m.stripes ?? 0,
            joined_at: m.joined_at,
            last_seen_at: m.last_seen_at,
            recentSessions,
            previousSessions,
            recentBookings: bookingsByMember.get(m.id) ?? [],
          });
          return { ...score, email: m.email as string | null };
        })
        .sort((a, b) => b.score - a.score);

    },
  });

  const { data: playbookActions } = useQuery({
    queryKey: ["playbook-actions", activeDojoId],
    enabled: !!activeDojoId,
    queryFn: () => playbookActionsFn({ data: { dojoId: activeDojoId! } }),
  });

  if (isLoading) return <PanelSkeleton label="Scoring active members against attendance and tenure rules…" />;
  if (error) return <ErrorBox onRetry={() => refetch()} />;
  if (!data) return null;

  const highs = data.filter((m) => m.level === "high");
  const watches = data.filter((m) => m.level === "watch");
  const healthies = data.filter((m) => m.level === "healthy");
  const atRisk = [...highs, ...watches];
  const dojoName = activeDojo?.name ?? "the gym";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 rounded-lg border border-zinc-950/5 bg-card p-4">
          <Sparkles className="mt-0.5 size-4 text-brand" />
          <p className="max-w-2xl text-sm text-muted-foreground">
            Deterministic risk score (0–100) from days since last seen, attendance trend vs the prior month, time at belt, and recent no-shows. Reach out to the high-risk students first.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => exportRetentionCsv(atRisk.concat(healthies))}>
            <Download className="size-3.5" /> Export CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => printRetention(atRisk, dojoName)}>
            <Printer className="size-3.5" /> Print
          </Button>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCcw className={cn("size-3.5", isFetching && "animate-spin")} /> Recompute
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <SummaryCard label="High risk" count={highs.length} color="text-rose-600" />
        <SummaryCard label="Watch" count={watches.length} color="text-amber-600" />
        <SummaryCard label="Healthy" count={healthies.length} color="text-emerald-600" />
      </div>

      <div className="space-y-3">
        {atRisk.length === 0 ? (
          <div className="rounded-lg border border-zinc-950/5 bg-card p-10 text-center text-sm text-muted-foreground">
            No at-risk members. Everyone's training.
          </div>
        ) : (
          atRisk.map((r) => (
            <RiskRow
              key={r.memberId}
              r={r}
              dojoId={activeDojoId!}
              playbooks={playbookActions?.byMember?.[r.memberId] ?? []}
            />
          ))
        )}
      </div>

      {healthies.length > 0 ? (
        <div>
          <Button variant="ghost" size="sm" onClick={() => setShowHealthy((s) => !s)}>
            {showHealthy ? "Hide" : `Show ${healthies.length} healthy member${healthies.length === 1 ? "" : "s"}`} ▾
          </Button>
          {showHealthy ? (
            <div className="mt-3 space-y-3">
              {healthies.map((r) => (
                <RiskRow key={r.memberId} r={r} dojoId={activeDojoId!} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SummaryCard({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div className="rounded-lg border border-zinc-950/5 bg-card p-5">
      <div className={cn("text-[11px] font-semibold uppercase tracking-wider", color)}>{label}</div>
      <div className="mt-2 font-display text-3xl font-medium tracking-tight">{count}</div>
    </div>
  );
}

function csvCell(v: string | number) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportRetentionCsv(rows: MemberRiskScore[]) {
  const header = ["Name", "Belt", "Stripes", "Days since last seen", "Sessions (30d)", "Sessions (prev 30d)", "Risk score", "Risk level", "Top reason"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      csvCell(r.name),
      csvCell(r.beltColor),
      csvCell(r.stripes),
      csvCell(r.daysSinceLastSeen >= 999 ? "never" : r.daysSinceLastSeen),
      csvCell(r.sessionsLast30),
      csvCell(r.sessionsPrev30),
      csvCell(r.score),
      csvCell(r.level),
      csvCell(r.reasons[0] ?? ""),
    ].join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `retention-risk-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function printRetention(rows: MemberRiskScore[], dojoName: string) {
  const win = window.open("", "_blank");
  if (!win) return;
  const tierClass = (l: string) =>
    l === "high" ? "background:#fee2e2;color:#991b1b" : l === "watch" ? "background:#fef3c7;color:#92400e" : "background:#d1fae5;color:#065f46";
  const body = rows
    .map((r) => `<tr>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.beltColor)}${r.stripes ? ` (${r.stripes})` : ""}</td>
      <td>${r.daysSinceLastSeen >= 999 ? "never" : r.daysSinceLastSeen + "d"}</td>
      <td>${r.sessionsLast30}</td>
      <td>${r.sessionsPrev30}</td>
      <td><span style="${tierClass(r.level)};padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600;text-transform:uppercase">${r.level}</span> ${r.score}</td>
      <td>${escapeHtml(r.reasons.join("; "))}</td>
    </tr>`)
    .join("");
  win.document.write(`<!doctype html><html><head><title>Retention risk — ${escapeHtml(dojoName)}</title>
    <style>
      body{font-family:system-ui,sans-serif;padding:32px;color:#111}
      h1{font-size:20px;margin:0 0 4px}
      .sub{color:#71717a;font-size:12px;margin-bottom:16px}
      table{width:100%;border-collapse:collapse;font-size:13px}
      th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e5e7eb;vertical-align:top}
      th{background:#f4f4f5;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
      @media print{button{display:none}}
    </style></head><body>
    <h1>Retention risk — ${escapeHtml(dojoName)}</h1>
    <div class="sub">${rows.length} at-risk members · generated ${new Date().toLocaleString()}</div>
    <button onclick="window.print()">Print</button>
    <table><thead><tr><th>Name</th><th>Belt</th><th>Last seen</th><th>Sessions (30d)</th><th>Prev (30d)</th><th>Risk</th><th>Reasons</th></tr></thead><tbody>${body || '<tr><td colspan="7">No at-risk members.</td></tr>'}</tbody></table>
    </body></html>`);
  win.document.close();
}

function RiskRow({
  r,
  dojoId,
  playbooks = [],
}: {
  r: MemberRiskScore & { email: string | null };
  dojoId: string;
  playbooks?: { workflow_name: string; actioned_at: string }[];
}) {
  const [composeOpen, setComposeOpen] = useState(false);
  const tone =
    r.level === "high"
      ? "border-rose-200 bg-rose-50/40"
      : r.level === "watch"
        ? "border-amber-300 bg-amber-100/40"
        : "border-emerald-200 bg-emerald-50/30";
  const chip =
    r.level === "high"
      ? "bg-rose-600 text-white"
      : r.level === "watch"
        ? "bg-amber-500 text-white"
        : "bg-emerald-600 text-white";
  const chipLabel = r.level === "high" ? "High risk" : r.level === "watch" ? "Watch" : "Healthy";

  return (
    <>
      <div className={cn("rounded-lg border bg-card p-5", tone)}>
      <div className="flex flex-wrap items-start gap-4">
        <MemberAvatar name={r.name} className="size-10" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold">{r.name}</div>
            <BeltChip belt={{ color: r.beltColor as BeltColor, label: r.beltColor, stripes: r.stripes } as Belt} />
            <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider", chip)}>
              {chipLabel}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Last seen: <strong className="text-zinc-900">{r.daysSinceLastSeen >= 999 ? "never" : `${r.daysSinceLastSeen}d ago`}</strong></span>
            {playbooks.length > 0 && (
              <span>
                Playbooks:{" "}
                <strong className="text-zinc-900">
                  {Array.from(new Set(playbooks.map((p) => p.workflow_name))).join(", ")}
                </strong>
              </span>
            )}
            <span>Sessions this month: <strong className="text-zinc-900">{r.sessionsLast30}</strong></span>
            <span>Prior month: <strong className="text-zinc-900">{r.sessionsPrev30}</strong></span>
          </div>
          {r.reasons.length > 0 ? (
            <ul className="mt-2 space-y-0.5 text-xs text-zinc-700">
              {r.reasons.map((reason) => (
                <li key={reason} className="flex items-start gap-1.5">
                  <span className="mt-1.5 inline-block size-1 shrink-0 rounded-full bg-zinc-500" />
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="text-right">
            <div className="font-display text-2xl font-medium tracking-tight">{r.score}</div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">risk score</div>
          </div>
          {r.level !== "healthy" ? (
            <Button size="sm" variant="outline" onClick={() => setComposeOpen(true)}>
              <Mail className="size-3.5" /> Message
            </Button>
          ) : null}
        </div>
      </div>
      </div>
      <RetentionMessageDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        dojoId={dojoId}
        memberId={r.memberId}
        memberName={r.name}
        daysSinceLastSeen={r.daysSinceLastSeen}
      />
    </>
  );
}

// ───────────── Belt Readiness ─────────────

function BeltPanel() {
  const { activeDojoId } = useCurrentDojo();
  const [showNotYet, setShowNotYet] = useState(false);
  const [discipline, setDiscipline] = useState<string>("all");

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["belt-readiness", activeDojoId],
    enabled: !!activeDojoId,
    staleTime: 60 * 60 * 1000,
    queryFn: async () => {
      const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString();
      const { data: members, error: err } = await supabase
        .from("members")
        .select("id, name, discipline, belt_color, stripes, joined_at, attendances(checked_in_at)")
        .eq("dojo_id", activeDojoId!)
        .eq("status", "active")
        .gte("attendances.checked_in_at", ninetyDaysAgo);
      if (err) throw err;

      return (members ?? [])
        .filter((m: any) => m.belt_color !== "black")
        .map((m: any) =>
          assessReadiness({
            id: m.id,
            name: m.name,
            discipline: m.discipline ?? "BJJ",
            belt_color: m.belt_color ?? "white",
            stripes: m.stripes ?? 0,
            joined_at: m.joined_at,
            sessionsLast90: (m.attendances ?? []).length,
          }),
        )
        .sort((a, b) => {
          const order = { ready: 0, almost: 1, "not-yet": 2 } as const;
          return order[a.level] - order[b.level];
        });
    },
  });

  if (isLoading) return <PanelSkeleton label="Checking time at belt and 90-day attendance…" />;
  if (error) return <ErrorBox onRetry={() => refetch()} />;
  if (!data) return null;

  const disciplines = Array.from(new Set(data.map((m) => m.discipline))).filter(Boolean);
  const filtered = discipline === "all" ? data : data.filter((m) => m.discipline === discipline);

  const ready = filtered.filter((m) => m.level === "ready");
  const almost = filtered.filter((m) => m.level === "almost");
  const notYet = filtered.filter((m) => m.level === "not-yet");

  const printList = () => {
    const win = window.open("", "_blank");
    if (!win) return;
    const rows = ready
      .map(
        (m) =>
          `<tr><td>${escapeHtml(m.name)}</td><td>${escapeHtml(m.beltColor)}${m.stripes ? ` (${m.stripes} stripe${m.stripes === 1 ? "" : "s"})` : ""}</td><td>${m.monthsAtBelt}</td><td>${m.sessionsLast90}</td></tr>`,
      )
      .join("");
    win.document.write(`<!doctype html><html><head><title>Grading list</title>
      <style>
        body{font-family:system-ui,sans-serif;padding:32px;color:#111}
        h1{font-size:20px;margin:0 0 16px}
        table{width:100%;border-collapse:collapse;font-size:14px}
        th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #e5e7eb}
        th{background:#f4f4f5;font-weight:600}
        @media print{button{display:none}}
      </style></head><body>
      <h1>Ready to grade${discipline !== "all" ? ` — ${escapeHtml(discipline)}` : ""}</h1>
      <button onclick="window.print()">Print</button>
      <table><thead><tr><th>Name</th><th>Belt</th><th>Months at belt</th><th>Sessions (90d)</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No members ready.</td></tr>'}</tbody></table>
      </body></html>`);
    win.document.close();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 rounded-lg border border-zinc-950/5 bg-card p-4">
          <Sparkles className="mt-0.5 size-4 text-brand" />
          <p className="max-w-2xl text-sm text-muted-foreground">
            Deterministic rules: minimum months at belt (per discipline) plus 20+ sessions in the last 90 days. When to test is always your call.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {disciplines.length > 1 ? (
            <Select value={discipline} onValueChange={setDiscipline}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All disciplines</SelectItem>
                {disciplines.map((d) => (
                  <SelectItem key={d} value={d}>{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Button variant="outline" size="sm" onClick={printList}>
            <Printer className="size-3.5" /> Print grading list
          </Button>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCcw className={cn("size-3.5", isFetching && "animate-spin")} /> Recompute
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <ReadinessColumn header="Ready to grade" headerColor="bg-emerald-600" members={ready} />
        <ReadinessColumn header="Almost ready" headerColor="bg-amber-500" members={almost} />
        <div className="rounded-lg border border-zinc-950/5 bg-card">
          <div className="rounded-t-lg bg-zinc-500 px-4 py-2 text-sm font-semibold text-white">
            Keep training ({notYet.length})
          </div>
          <div className="p-3">
            <Button variant="ghost" size="sm" onClick={() => setShowNotYet((s) => !s)}>
              {showNotYet ? "Hide" : `Show ${notYet.length} member${notYet.length === 1 ? "" : "s"}`} ▾
            </Button>
            {showNotYet ? (
              <div className="mt-3 space-y-3">
                {notYet.map((m) => <ReadinessCard key={m.memberId} m={m} />)}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function ReadinessColumn({ header, headerColor, members }: { header: string; headerColor: string; members: ReadinessResult[] }) {
  return (
    <div className="rounded-lg border border-zinc-950/5 bg-card">
      <div className={cn("rounded-t-lg px-4 py-2 text-sm font-semibold text-white", headerColor)}>
        {header} ({members.length})
      </div>
      <div className="space-y-3 p-3">
        {members.length === 0 ? (
          <div className="rounded border border-dashed border-zinc-200 p-6 text-center text-xs text-muted-foreground">
            None
          </div>
        ) : (
          members.map((m) => <ReadinessCard key={m.memberId} m={m} />)
        )}
      </div>
    </div>
  );
}

const BELT_DOT: Record<string, string> = {
  white: "bg-white ring-1 ring-zinc-300",
  blue: "bg-blue-600",
  purple: "bg-purple-600",
  brown: "bg-amber-800",
  black: "bg-zinc-900",
  yellow: "bg-yellow-400",
  orange: "bg-orange-500",
  green: "bg-emerald-600",
};

function ReadinessCard({ m }: { m: ReadinessResult }) {
  return (
    <div className="rounded-lg border border-zinc-950/5 bg-background p-3">
      <div className="flex items-center gap-2">
        <span className={cn("inline-block size-3 rounded-full", BELT_DOT[m.beltColor] ?? "bg-zinc-300")} />
        <span className="text-sm font-semibold">{m.name}</span>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">{m.discipline}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-1 text-xs text-zinc-700">
        {Array.from({ length: 4 }).map((_, i) => (
          <span key={i}>{i < m.stripes ? "●" : "○"}</span>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-muted-foreground">At belt:</span>{" "}
          <strong>{m.monthsAtBelt} / {m.minMonthsRequired} mo</strong>
          {m.meetsTime ? <Check className="ml-1 inline size-3 text-emerald-600" /> : <X className="ml-1 inline size-3 text-rose-500" />}
        </div>
        <div>
          <span className="text-muted-foreground">90d:</span>{" "}
          <strong>{m.sessionsLast90} sessions</strong>
          {m.meetsAttendance ? <Check className="ml-1 inline size-3 text-emerald-600" /> : <X className="ml-1 inline size-3 text-rose-500" />}
        </div>
      </div>
      <div className="mt-1.5 text-[11px] text-muted-foreground">{m.notes}</div>
    </div>
  );
}

function MiniMeter({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-medium text-zinc-700">{label}</span>
        <span className="text-muted-foreground">{hint}</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200">
        <div className="h-full rounded-full bg-zinc-900" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

// ───────────── Shared ─────────────

function PanelSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Sparkles className="size-4 animate-pulse text-brand" /> {label}
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg border border-zinc-950/5 bg-zinc-100/60" />
        ))}
      </div>
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-lg border border-zinc-950/5 bg-zinc-100/60" />
        ))}
      </div>
    </div>
  );
}

function ErrorBox({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-lg border border-rose-200 bg-rose-50 p-6 text-sm">
      <div className="font-semibold text-rose-800">Couldn't load insights.</div>
      <div className="mt-1 text-rose-700">Try again in a moment.</div>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        <RefreshCcw className="size-3.5" /> Retry
      </Button>
    </div>
  );
}

// ───────────── Lead Scoring (trial members) ─────────────

function LeadsPanel() {
  const { activeDojoId } = useCurrentDojo();
  const fn = useServerFn(getLeadConversion);
  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["lead-conversion", activeDojoId],
    enabled: !!activeDojoId,
    queryFn: () => fn({ data: { dojoId: activeDojoId! } }),
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) return <PanelSkeleton label="Scoring trial members by activity, recency, and engagement…" />;
  if (error) return <ErrorBox onRetry={() => refetch()} />;
  if (!data) return null;

  const tiers: { key: "hot" | "warm" | "cold"; label: string; color: string }[] = [
    { key: "hot", label: "Hot leads", color: "text-rose-600" },
    { key: "warm", label: "Warm", color: "text-amber-600" },
    { key: "cold", label: "Cold", color: "text-zinc-500" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 rounded-lg border border-zinc-950/5 bg-card p-4">
          <Sparkles className="mt-0.5 size-4 text-brand" />
          <p className="max-w-2xl text-sm text-muted-foreground">
            Each trial member is scored against your own conversion baseline of{" "}
            <strong className="text-zinc-900">{data.avgConvertedVisits} visits</strong> in the first two weeks.
            Call the hot leads first — they're showing every signal of a paying member.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCcw className={cn("size-3.5", isFetching && "animate-spin")} /> Recompute
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {tiers.map(({ key, label, color }) => (
          <div key={key} className="rounded-lg border border-zinc-950/5 bg-card p-5">
            <div className={cn("flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground")}>
              <Flame className={cn("size-3.5", color)} /> {label}
            </div>
            <div className="mt-2 font-display text-3xl font-medium tracking-tight">{data.counts[key]}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {Math.round(((data.counts[key] || 0) / Math.max(1, data.total)) * 100)}% of trials
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-3">
        {data.leads.length === 0 ? (
          <div className="rounded-lg border border-zinc-950/5 bg-card p-10 text-center text-sm text-muted-foreground">
            No trial members right now. Add a new member with status "trial" to start scoring leads.
          </div>
        ) : (
          data.leads.map((l: any) => <LeadRow key={l.id} l={l} />)
        )}
      </div>
    </div>
  );
}

function LeadRow({ l }: { l: any }) {
  const tone =
    l.tier === "hot"
      ? "border-rose-200 bg-rose-50/40"
      : l.tier === "warm"
        ? "border-amber-300 bg-amber-100/40"
        : "border-zinc-200 bg-white";
  const barColor = l.tier === "hot" ? "bg-rose-500" : l.tier === "warm" ? "bg-amber-500" : "bg-zinc-400";

  return (
    <div className={cn("rounded-lg border bg-card p-5", tone)}>
      <div className="flex flex-wrap items-start gap-4">
        <MemberAvatar name={l.name} className="size-10" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold">{l.name}</div>
            <BeltChip
              belt={{ color: l.belt.color as BeltColor, label: l.belt.label } as Belt}
              discipline={l.discipline as Discipline}
            />
            <span className="text-xs text-muted-foreground">{l.discipline} · trial</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {l.email ? (
              <span className="inline-flex items-center gap-1"><Mail className="size-3" />{l.email}</span>
            ) : null}
            {l.phone ? (
              <span className="inline-flex items-center gap-1"><Phone className="size-3" />{l.phone}</span>
            ) : null}
          </div>
          {l.reasons.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {l.reasons.map((reason: string) => (
                <span key={reason} className="rounded-full bg-white px-2 py-0.5 text-[11px] text-zinc-700 ring-1 ring-inset ring-black/5">
                  {reason}
                </span>
              ))}
            </div>
          ) : null}
          <div className="mt-3 flex items-start gap-2 text-xs">
            <Sparkles className="mt-0.5 size-3.5 shrink-0 text-brand" />
            <span className="text-zinc-700">{l.recommendation}</span>
          </div>
        </div>
        <div className="w-40 shrink-0 text-right">
          <div className="font-display text-2xl font-medium tracking-tight">{l.score}</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">conversion score</div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200">
            <div className={cn("h-full rounded-full", barColor)} style={{ width: `${l.score}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────────── Revenue Forecast ─────────────

function ForecastPanel() {
  const { activeDojoId, activeDojo } = useCurrentDojo();
  const currency = activeDojo?.defaultCurrency ?? null;
  const fn = useServerFn(getRevenueForecast);
  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["revenue-forecast", activeDojoId],
    enabled: !!activeDojoId,
    queryFn: () => fn({ data: { dojoId: activeDojoId! } }),
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) return <PanelSkeleton label="Forecasting revenue, expected churn loss, and trial conversions…" />;
  if (error) return <ErrorBox onRetry={() => refetch()} />;
  if (!data) return null;

  const netForecast = data.months[data.months.length - 1]?.forecastCents ?? data.currentMRRCents;
  const delta = netForecast - data.currentMRRCents;
  const deltaPct = data.currentMRRCents > 0 ? Math.round((delta / data.currentMRRCents) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 rounded-lg border border-zinc-950/5 bg-card p-4">
          <Sparkles className="mt-0.5 size-4 text-brand" />
          <p className="max-w-2xl text-sm text-muted-foreground">
            Forecast uses your paid invoice history, current churn signals, and trial conversion rate
            ({Math.round(data.conversionRate * 100)}% historically) to project the next 90 days.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCcw className={cn("size-3.5", isFetching && "animate-spin")} /> Recompute
        </Button>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard
          label="Monthly revenue"
          value={fmtMoney(data.currentMRRCents, currency)}
          hint={`${data.activeMembers} active ${data.activeMembers === 1 ? "member" : "members"}`}
          icon={<DollarSign className="size-3.5 text-emerald-600" />}
        />
        <KpiCard
          label="At-risk revenue"
          value={fmtMoney(data.atRiskMRRCents, currency)}
          hint={`${data.atRiskCount} members ≥ 20% churn risk`}
          icon={<AlertTriangle className="size-3.5 text-amber-600" />}
        />
        <KpiCard
          label="Expected churn loss"
          value={fmtMoney(data.expectedChurnLossCents, currency)}
          hint="next 30 days, weighted by probability"
          icon={<TrendingDown className="size-3.5 text-rose-600" />}
        />
        <KpiCard
          label="Trial pipeline"
          value={fmtMoney(data.expectedNewFromTrialsCents, currency)}
          hint={`${data.trialMembers} trials @ ${Math.round(data.conversionRate * 100)}% conv.`}
          icon={<TrendingUp className="size-3.5 text-brand" />}
        />
      </div>

      {/* 90-day forecast chart */}
      <div className="rounded-lg border border-zinc-950/5 bg-card p-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              90-day revenue forecast
            </div>
            <div className="mt-1 font-display text-3xl font-medium tracking-tight">
              {fmtMoney(netForecast, currency)}
              <span
                className={cn(
                  "ml-2 text-sm font-medium",
                  delta >= 0 ? "text-emerald-600" : "text-rose-600",
                )}
              >
                {delta >= 0 ? "▲" : "▼"} {fmtMoney(Math.abs(delta), currency)} ({deltaPct >= 0 ? "+" : ""}{deltaPct}%) vs today
              </span>
            </div>
          </div>
        </div>
        <ForecastChart months={data.months} baseline={data.currentMRRCents} currency={currency} />
      </div>

      {/* Retention scenarios */}
      <div className="rounded-lg border border-zinc-950/5 bg-card p-6">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          What if we save more at-risk members?
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Model the financial impact of different retention efforts.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          {data.scenarios.map((s: any) => (
            <div key={s.retentionPct} className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4">
              <div className="text-xs font-semibold text-emerald-800">
                Save {s.retentionPct}% of at-risk
              </div>
              <div className="mt-2 font-display text-2xl font-medium tracking-tight">
                +{fmtMoney(s.quarterlySavedCents, currency)}
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                over 90 days · {fmtMoney(s.monthlySavedCents, currency)}/mo
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* At-risk roster ranked by $ */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold">At-risk members, ranked by expected loss</div>
            <div className="text-xs text-muted-foreground">Save these first — biggest dollar impact.</div>
          </div>
        </div>
        <div className="space-y-2">
          {data.atRisk.length === 0 ? (
            <div className="rounded-lg border border-zinc-950/5 bg-card p-10 text-center text-sm text-muted-foreground">
              No active members above 20% churn probability. Pipeline is healthy.
            </div>
          ) : (
            data.atRisk.map((m: any) => <AtRiskRow key={m.id} m={m} currency={currency} />)
          )}
        </div>
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: string;
  hint: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-zinc-950/5 bg-card p-5">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {icon} {label}
      </div>
      <div className="mt-2 font-display text-2xl font-medium tracking-tight">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}

function ForecastChart({
  months,
  baseline,
  currency,
}: {
  months: { label: string; baselineCents: number; forecastCents: number }[];
  baseline: number;
  currency?: string | null;
}) {
  const maxVal = Math.max(baseline, ...months.map((m) => m.forecastCents));
  const minVal = Math.min(baseline, ...months.map((m) => m.forecastCents));
  const range = Math.max(1, maxVal - minVal);
  const pad = range * 0.15;
  const top = maxVal + pad;
  const bottom = Math.max(0, minVal - pad);
  const span = Math.max(1, top - bottom);

  const points = [
    { label: "Today", value: baseline },
    ...months.map((m) => ({ label: m.label, value: m.forecastCents })),
  ];

  const w = 100;
  const h = 40;
  const stepX = w / Math.max(1, points.length - 1);
  const coords = points.map((p, i) => ({
    x: i * stepX,
    y: h - ((p.value - bottom) / span) * h,
    ...p,
  }));
  const pathD = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(2)} ${c.y.toFixed(2)}`).join(" ");
  const areaD = `${pathD} L ${w} ${h} L 0 ${h} Z`;

  return (
    <div className="mt-6">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-32 w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id="forecastFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="oklch(0.65 0.18 30)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="oklch(0.65 0.18 30)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaD} fill="url(#forecastFill)" />
        <path d={pathD} stroke="oklch(0.55 0.2 30)" strokeWidth="0.6" fill="none" vectorEffect="non-scaling-stroke" />
        {coords.map((c) => (
          <circle key={c.label} cx={c.x} cy={c.y} r="0.8" fill="oklch(0.55 0.2 30)" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div className="mt-2 grid grid-cols-4 text-center text-[11px] text-muted-foreground">
        {coords.map((c) => (
          <div key={c.label}>
            <div className="font-medium text-zinc-700">{fmtMoney(c.value, currency)}</div>
            <div>{c.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AtRiskRow({ m, currency }: { m: any; currency?: string | null }) {
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border border-zinc-950/5 bg-card p-4">
      <MemberAvatar name={m.name} className="size-9" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-semibold">{m.name}</div>
          <BeltChip
            belt={{ color: m.belt.color as BeltColor, label: m.belt.label } as Belt}
            discipline={m.discipline as Discipline}
          />
          <span className="text-xs text-muted-foreground">{m.discipline} · {m.plan}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>Last seen: <strong className="text-zinc-900">{m.daysSinceLast >= 999 ? "never" : `${m.daysSinceLast}d ago`}</strong></span>
          <span>30d visits: <strong className="text-zinc-900">{m.visits30d}</strong></span>
          {m.overdueInvoices > 0 ? <span className="text-rose-700">Overdue: <strong>{m.overdueInvoices}</strong></span> : null}
        </div>
      </div>
      <div className="text-right">
        <div className="font-display text-xl font-medium tracking-tight text-rose-700">
          −{fmtMoney(m.expectedLossCents, currency)}
        </div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {m.churnProbability}% churn · {fmtMoney(m.monthlyValueCents, currency)}/mo
        </div>
      </div>
    </div>
  );
}

// ───────────── Member: Smart Class Recommendations ─────────────

function ClassRecommendationsCard() {
  const { activeDojoId } = useCurrentDojo();
  const fn = useServerFn(getClassRecommendations);
  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["member-class-recs", activeDojoId],
    enabled: !!activeDojoId,
    queryFn: () => fn({ data: { dojoId: activeDojoId! } }),
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div className="rounded-xl border border-zinc-950/5 bg-card p-6">
      <div className="flex items-center gap-2">
        <CalendarClock className="size-4 text-brand" />
        <h2 className="font-display text-base font-medium">Smart class recommendations</h2>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCcw className={cn("size-3.5", isFetching && "animate-spin")} />
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        AI-picked classes that match your discipline, fill gaps in your week, and keep your training fresh.
      </p>

      {isLoading ? (
        <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Reading your attendance…
        </div>
      ) : error ? (
        <div className="mt-4 text-xs text-rose-700">Couldn't load recommendations.</div>
      ) : !data?.recommendations.length ? (
        <div className="mt-4 rounded-lg border border-dashed border-zinc-950/10 p-6 text-center text-xs text-muted-foreground">
          {data?.reason ?? "No classes match your discipline yet."}
        </div>
      ) : (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {data.recommendations.map((c: any) => (
            <li key={c.id} className="rounded-lg border border-zinc-950/5 bg-background p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold">{c.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {c.weekday} · {c.startTime}–{c.endTime} · {c.instructor}
                  </div>
                </div>
                <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand">
                  {c.score}
                </span>
              </div>
              {c.reasons.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {c.reasons.map((r: string) => (
                    <span key={r} className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-700">
                      {r}
                    </span>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ───────────── Member: Peer Training Matcher ─────────────

function PeerMatchesCard() {
  const { activeDojoId } = useCurrentDojo();
  const fn = useServerFn(getPeerMatches);
  const setOptIn = useServerFn(setPartnerMatching);
  const qc = useQueryClient();
  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["member-peer-matches", activeDojoId],
    enabled: !!activeDojoId,
    queryFn: () => fn({ data: { dojoId: activeDojoId! } }),
    staleTime: 5 * 60 * 1000,
  });

  const toggle = useMutation({
    mutationFn: (optIn: boolean) => setOptIn({ data: { dojoId: activeDojoId!, optIn } }),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ["member-peer-matches", activeDojoId] });
      toast.success(
        res.optedIn
          ? "You're now visible to other opted-in members"
          : "You're hidden from partner matching",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (data && !data.featureEnabled) return null;

  const optedIn = !!data?.optedIn;

  return (
    <div className="rounded-xl border border-zinc-950/5 bg-card p-6">
      <div className="flex items-center gap-2">
        <Users className="size-4 text-brand" />
        <h2 className="font-display text-base font-medium">Training partners for you</h2>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCcw className={cn("size-3.5", isFetching && "animate-spin")} />
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Teammates in your discipline at a similar belt level — great drill partners.
      </p>

      <div className="mt-4 flex items-start gap-3 rounded-lg border border-zinc-950/5 bg-background p-4">
        <Switch
          id="partner-opt-in"
          checked={optedIn}
          disabled={!data || toggle.isPending}
          onCheckedChange={(v: boolean) => toggle.mutate(v)}
        />
        <label htmlFor="partner-opt-in" className="text-xs text-muted-foreground">
          <span className="block text-sm font-medium text-foreground">
            Show me as a training partner
          </span>
          Off by default. While it's on, other members who also opted in can see your name, belt
          and discipline — nothing else, and never when you train.
        </label>
      </div>

      {!optedIn ? null : isLoading ? (
        <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Finding peers…
        </div>
      ) : error ? (
        <div className="mt-4 text-xs text-rose-700">Couldn't load peers.</div>
      ) : !data?.peers.length ? (
        <div className="mt-4 rounded-lg border border-dashed border-zinc-950/10 p-6 text-center text-xs text-muted-foreground">
          No opted-in peers at your level just yet.
        </div>
      ) : (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {data.peers.map((p: any) => (
            <li key={p.id} className="flex items-start gap-3 rounded-lg border border-zinc-950/5 bg-background p-4">
              <MemberAvatar name={p.name} className="size-10" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{p.name}</div>
                <div className="mt-1">
                  <BeltChip
                    belt={{ color: p.belt.color as BeltColor, label: p.belt.label, stripes: p.belt.stripes } as Belt}
                    discipline={p.discipline as Discipline}
                  />
                </div>
                <div className="mt-2 text-[11px] text-muted-foreground">
                  {p.beltDelta === 0 ? "same belt" : `${p.beltDelta} belt${p.beltDelta === 1 ? "" : "s"} apart`}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}



