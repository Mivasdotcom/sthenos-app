import { PUBLIC_SITE_URL } from "@/lib/site";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { BeltChip, MemberAvatar } from "@/components/BeltChip";
import { Button } from "@/components/ui/button";
import { PromoteDialog } from "@/components/PromoteDialog";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { beltClassMap, getBeltColors, type Belt, type BeltColor } from "@/lib/belt-colors";
import { Award, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { assessReadiness, type ReadinessLevel } from "@/lib/belt-readiness";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { useMemo, useState } from "react";
import { format } from "date-fns";

export const Route = createFileRoute("/ranks")({
  head: () => ({
    meta: [
      { title: "Rank Progression \u2014 Sthenos" },
      { name: "description", content: "Track belt progression, stripes, and promotion history across every discipline." },
      { property: "og:title", content: "Rank Progression \u2014 Sthenos" },
      { property: "og:description", content: "Track belt progression, stripes, and promotion history across every discipline." },
      { property: "og:url", content: `${PUBLIC_SITE_URL}/ranks` },
      { name: "twitter:title", content: "Rank Progression \u2014 Sthenos" },
      { name: "twitter:description", content: "Track belt progression, stripes, and promotion history across every discipline." },
    ],
    links: [
      { rel: "canonical", href: `${PUBLIC_SITE_URL}/ranks` },
    ],
  }),
  component: RanksPage,
});

function orderFor(d: string): BeltColor[] {
  return getBeltColors(d);
}

type MemberRow = {
  id: string;
  dojo_id: string;
  name: string;
  discipline: string;
  belt_color: BeltColor;
  belt_label: string;
  stripes: number;
  dan: number | null;
  joined_at: string | null;
};

type PromotionRow = {
  id: string;
  member_id: string;
  discipline: string;
  to_color: BeltColor;
  to_label: string;
  to_stripes: number;
  to_dan: number | null;
  promoted_at: string;
  note: string | null;
  members: { name: string } | null;
};

async function fetchRanksData(dojoId: string) {
  const since90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const [membersRes, attRes, promAllRes, promRecentRes] = await Promise.all([
    supabase
      .from("members")
      .select("id,dojo_id,name,discipline,belt_color,belt_label,stripes,dan,joined_at")
      .eq("dojo_id", dojoId),
    supabase
      .from("attendances")
      .select("member_id")
      .eq("dojo_id", dojoId)
      .gte("checked_in_at", since90),
    supabase
      .from("promotions")
      .select("member_id,discipline,to_color,promoted_at")
      .eq("dojo_id", dojoId)
      .order("promoted_at", { ascending: false }),
    supabase
      .from("promotions")
      .select("id,member_id,discipline,to_color,to_label,to_stripes,to_dan,promoted_at,note, members:member_id(name)")
      .eq("dojo_id", dojoId)
      .order("promoted_at", { ascending: false })
      .limit(20),
  ]);
  if (membersRes.error) throw membersRes.error;
  if (attRes.error) throw attRes.error;
  if (promAllRes.error) throw promAllRes.error;
  if (promRecentRes.error) throw promRecentRes.error;

  const counts90 = new Map<string, number>();
  for (const a of attRes.data ?? []) counts90.set(a.member_id, (counts90.get(a.member_id) ?? 0) + 1);

  // Latest promotion per (member, discipline, belt_color) to derive time-at-belt.
  const latestByBelt = new Map<string, string>();
  for (const p of promAllRes.data ?? []) {
    const key = `${p.member_id}|${p.discipline}|${p.to_color}`;
    if (!latestByBelt.has(key)) latestByBelt.set(key, p.promoted_at);
  }

  const members = (membersRes.data as MemberRow[]).map((m) => {
    const key = `${m.id}|${m.discipline}|${m.belt_color}`;
    const beltSince = latestByBelt.get(key) ?? m.joined_at ?? new Date().toISOString();
    return {
      ...m,
      attendance90d: counts90.get(m.id) ?? 0,
      attendance30d: counts90.get(m.id) ?? 0, // legacy display; approximated
      beltSince,
    };
  });

  return { members, promotions: (promRecentRes.data ?? []) as unknown as PromotionRow[] };
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const READINESS_RANK: Record<ReadinessLevel, number> = { ready: 0, almost: 1, "not-yet": 2 };

function readinessBadge(level: ReadinessLevel) {
  if (level === "ready")
    return (
      <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Ready</Badge>
    );
  if (level === "almost")
    return (
      <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">Almost</Badge>
    );
  return <Badge variant="secondary">Not yet</Badge>;
}

function RanksPage() {
  const { activeDojoId } = useCurrentDojo();
  const [promoteTarget, setPromoteTarget] = useState<MemberRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["ranks", activeDojoId],
    queryFn: () => fetchRanksData(activeDojoId!),
    enabled: !!activeDojoId,
  });

  const members = data?.members ?? [];
  const promotions = data?.promotions ?? [];

  const eligible = useMemo(() => {
    return members
      .filter((m) => m.belt_color !== "black" && m.belt_color !== "beginner")
      .map((m) => ({
        ...m,
        readiness: assessReadiness({
          id: m.id,
          name: m.name,
          discipline: m.discipline ?? "BJJ",
          belt_color: m.belt_color,
          stripes: m.stripes,
          joined_at: m.beltSince,
          sessionsLast90: m.attendance90d,
        }),
      }))
      .filter((m) => m.readiness.level === "ready" || m.readiness.level === "almost")
      .sort((a, b) => {
        const r = READINESS_RANK[a.readiness.level] - READINESS_RANK[b.readiness.level];
        if (r !== 0) return r;
        return b.attendance90d - a.attendance90d;
      })
      .slice(0, 6);
  }, [members]);

  const disciplines = useMemo(
    () => Array.from(new Set(members.map((m) => m.discipline).filter(Boolean))),
    [members],
  );

  if (!activeDojoId) {
    return (
      <main>
        <PageHeader title="Rank Progression" subtitle="Select a dojo to view ranks." />
      </main>
    );
  }

  return (
    <main>
      <PageHeader
        title="Rank Progression"
        subtitle={
          isLoading
            ? "Loading…"
            : `${promotions.length} recent promotions · ${eligible.length} eligible students`
        }
      />

      <div className="mx-auto max-w-7xl space-y-8 p-8">
        <section className="space-y-4">
          <h2 className="font-display text-xl font-medium">Eligible for Promotion</h2>
          {eligible.length === 0 && !isLoading ? (
            <div className="rounded-xl bg-card p-8 text-center text-sm text-muted-foreground ring-1 ring-black/5">
              No students meet the readiness criteria yet (time at belt + attendance trend).
            </div>
          ) : (
            <TooltipProvider delayDuration={150}>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {eligible.map((m) => {
                  const order = orderFor(m.discipline);
                  const idx = order.indexOf(m.belt_color);
                  const next = order[Math.min(idx + 1, order.length - 1)];
                  const belt: Belt = {
                    color: m.belt_color,
                    label: m.belt_label,
                    stripes: m.stripes ?? 0,
                    dan: m.dan ?? undefined,
                  };
                  return (
                    <div key={m.id} className="rounded-xl bg-card p-5 ring-1 ring-black/5">
                      <div className="flex items-center gap-3">
                        <MemberAvatar name={m.name} className="size-10" />
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold">{m.name}</span>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-help">{readinessBadge(m.readiness.level)}</span>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="max-w-xs">
                                {m.readiness.notes}
                              </TooltipContent>
                            </Tooltip>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {m.discipline} · {m.readiness.monthsAtBelt}mo at belt · {m.attendance90d} sessions / 90d
                          </div>
                        </div>
                        <Button
                          size="sm"
                          className="bg-brand text-brand-foreground hover:bg-brand/90"
                          onClick={() => setPromoteTarget(m)}
                        >
                          <Award className="size-3.5" /> Promote
                        </Button>
                      </div>
                      <div className="mt-3 text-xs text-muted-foreground">{m.readiness.notes}</div>
                      <div className="mt-4 flex items-center gap-3">
                        <BeltChip belt={belt} discipline={m.discipline} />
                        <ChevronRight className="size-4 text-muted-foreground" />
                        <BeltChip
                          belt={{ color: next, label: capitalize(next) + " Belt" }}
                          discipline={m.discipline}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </TooltipProvider>
          )}
        </section>

        <section className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          <div className="space-y-4">
            <h2 className="font-display text-xl font-medium">Belt Distribution</h2>
            <div className="rounded-xl bg-card p-5 ring-1 ring-black/5">
              {disciplines.length === 0 && (
                <div className="py-6 text-center text-sm text-muted-foreground">No members yet.</div>
              )}
              {disciplines.map((d) => {
                const dMembers = members.filter((m) => m.discipline === d);
                const order = orderFor(d);
                return (
                  <div key={d} className="border-b border-zinc-950/5 py-3 last:border-b-0">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="text-sm font-semibold">{d}</div>
                      <div className="text-xs text-muted-foreground">{dMembers.length} students</div>
                    </div>
                    <div className="flex h-2 overflow-hidden rounded-full bg-zinc-100">
                      {order.map((color) => {
                        const count = dMembers.filter((m) => m.belt_color === color).length;
                        if (count === 0) return null;
                        const pct = (count / Math.max(dMembers.length, 1)) * 100;
                        return (
                          <div
                            key={color}
                            className={cn("h-full", beltClassMap[color].dot)}
                            style={{ width: `${pct}%` }}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="space-y-4">
            <h2 className="font-display text-xl font-medium">Promotion History</h2>
            <div className="rounded-xl bg-card ring-1 ring-black/5">
              {promotions.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-muted-foreground">
                  No promotions yet.
                </div>
              ) : (
                <div className="divide-y divide-zinc-950/5">
                  {promotions.map((p) => (
                    <div key={p.id} className="px-5 py-4">
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="text-sm font-semibold">{p.members?.name ?? "Member"}</div>
                          <div className="text-xs text-muted-foreground">
                            {p.discipline} · {format(new Date(p.promoted_at), "yyyy-MM-dd")}
                          </div>
                        </div>
                        <BeltChip
                          belt={{
                            color: p.to_color,
                            label: p.to_label,
                            stripes: p.to_stripes ?? 0,
                            dan: p.to_dan ?? undefined,
                          }}
                          discipline={p.discipline}
                        />
                      </div>
                      {p.note && (
                        <p className="mt-2 text-xs italic text-muted-foreground">"{p.note}"</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>

      <PromoteDialog
        member={promoteTarget}
        open={!!promoteTarget}
        onOpenChange={(open) => !open && setPromoteTarget(null)}
      />
    </main>
  );
}
