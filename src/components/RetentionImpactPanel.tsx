import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { format } from "date-fns";
import { getRetentionImpact } from "@/lib/retention.functions";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { Button } from "@/components/ui/button";

const PERIODS = [
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "12 months", days: 365 },
];

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-display text-2xl font-medium tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function RetentionImpactPanel({ compact = false }: { compact?: boolean }) {
  const { activeDojoId, activeDojo } = useCurrentDojo();
  const isStaff =
    activeDojo?.role === "owner" || activeDojo?.role === "admin" || activeDojo?.role === "coach";
  const [days, setDays] = useState(90);
  const fn = useServerFn(getRetentionImpact);
  const { data, isLoading } = useQuery({
    queryKey: ["retention-impact", activeDojoId, days],
    queryFn: () => fn({ data: { dojoId: activeDojoId!, days } }),
    enabled: !!activeDojoId && isStaff,
  });

  if (!activeDojoId || !isStaff) return null;

  const empty = !isLoading && (!data || data.flagged === 0);

  return (
    <section className="rounded-xl bg-card p-5 ring-1 ring-border">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-medium">Retention impact</h2>
          <p className="text-xs text-muted-foreground">
            Does reaching out to at-risk members actually save them?
          </p>
        </div>
        {!compact && (
          <div className="flex gap-1">
            {PERIODS.map((p) => (
              <Button
                key={p.days}
                size="sm"
                variant={days === p.days ? "secondary" : "ghost"}
                onClick={() => setDays(p.days)}
              >
                {p.label}
              </Button>
            ))}
          </div>
        )}
      </div>

      {isLoading && <div className="mt-4 h-24 animate-pulse rounded-lg bg-muted" />}

      {empty && (
        <p className="mt-4 text-sm text-muted-foreground">
          No members have been flagged at risk in the last {days} days, so there is nothing to
          measure yet. Once nightly scoring flags someone and a playbook or coach reaches out,
          save rates will appear here.
        </p>
      )}

      {data && data.flagged > 0 && (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Flagged at risk" value={String(data.flagged)} hint={`Last ${days} days`} />
            <Stat
              label="Contacted"
              value={String(data.contacted)}
              hint={`${data.notContacted} never contacted`}
            />
            <Stat
              label="Returned to training"
              value={String(data.returned)}
              hint={`${data.churned} churned · ${data.pending} still open`}
            />
            <Stat
              label="Save rate"
              value={data.saveRatePct === null ? "—" : `${data.saveRatePct}%`}
              hint="Returned ÷ contacted"
            />
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Contacted — return rate
              </div>
              <div className="mt-1 font-display text-2xl font-medium tabular-nums text-emerald-600">
                {data.contactedReturnRatePct === null ? "—" : `${data.contactedReturnRatePct}%`}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {data.contactedResolved} resolved cases
              </div>
            </div>
            <div className="rounded-lg border border-border p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Not contacted — return rate
              </div>
              <div className="mt-1 font-display text-2xl font-medium tabular-nums text-muted-foreground">
                {data.notContactedReturnRatePct === null
                  ? "—"
                  : `${data.notContactedReturnRatePct}%`}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {data.notContactedResolved} resolved cases
              </div>
            </div>
          </div>

          {!data.hasEnoughHistory && (
            <p className="mt-3 text-[11px] text-muted-foreground">
              Only {data.flagged} flagged {data.flagged === 1 ? "case" : "cases"} so far — treat
              these rates as indicative until more history builds up.
            </p>
          )}

          {!compact && data.recentlySaved.length > 0 && (
            <div className="mt-5">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Recently saved
              </h3>
              <ul className="mt-2 divide-y divide-border">
                {data.recentlySaved.map((s) => (
                  <li key={s.memberId + String(s.returnedAt)} className="py-2">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm font-medium">{s.name}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {s.returnedAt ? format(new Date(s.returnedAt), "d MMM yyyy") : "—"}
                        {s.contacted ? " · after outreach" : " · no outreach"}
                      </span>
                    </div>
                    {s.factors.length > 0 && (
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {s.factors.join(" · ")}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
