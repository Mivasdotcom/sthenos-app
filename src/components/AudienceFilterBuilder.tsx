import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import type {
  AudienceFilter,
  MemberStatus,
  RiskTier,
  ReadinessStatus,
  RetentionRiskLevel,
} from "@/lib/audience";
import { RETENTION_RISK_LEVELS } from "@/lib/audience";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const STATUS: MemberStatus[] = ["active", "trial", "lapsed"];
const PLANS = ["Monthly", "Annual", "Drop-in", "Family"];
const BELTS = ["white", "yellow", "orange", "green", "blue", "purple", "brown", "red", "black"];
const RISK: RiskTier[] = ["high", "medium", "low"];
const READY: ReadinessStatus[] = ["ready", "almost", "developing", "early"];
const PAYMENT: string[] = ["current", "due", "overdue", "none"];
const RETENTION: RetentionRiskLevel[] = RETENTION_RISK_LEVELS;

/**
 * Disciplines actually present on this dojo's members. Never derived from
 * dojo_class_types — class types are for scheduling only.
 */
function useMemberDisciplines() {
  const { activeDojoId } = useCurrentDojo();
  const { data = [] } = useQuery({
    queryKey: ["member-disciplines", activeDojoId],
    enabled: !!activeDojoId,
    queryFn: async () => {
      const { data } = await supabase
        .from("members")
        .select("discipline")
        .eq("dojo_id", activeDojoId!);
      return data ?? [];
    },
  });
  return useMemo(
    () =>
      Array.from(new Set((data as { discipline: string | null }[]).map((m) => m.discipline).filter(Boolean) as string[])).sort(
        (a, b) => a.localeCompare(b),
      ),
    [data],
  );
}



function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "border-brand bg-brand text-brand-foreground"
          : "border-zinc-300 bg-white text-zinc-700 hover:border-zinc-400",
      )}
    >
      {children}
    </button>
  );
}

function toggle<T>(arr: T[] | undefined, val: T): T[] | undefined {
  const set = new Set(arr ?? []);
  if (set.has(val)) set.delete(val);
  else set.add(val);
  const next = Array.from(set);
  return next.length ? next : undefined;
}

export function AudienceFilterBuilder({
  value,
  onChange,
}: {
  value: AudienceFilter;
  onChange: (next: AudienceFilter) => void;
}) {
  const f = value;
  const disciplines = useMemberDisciplines();
  const set = (patch: Partial<AudienceFilter>) => onChange({ ...f, ...patch });

  return (
    <div className="space-y-5">
      <Row label="Status">
        {STATUS.map((s) => (
          <Chip key={s} active={!!f.status?.includes(s)} onClick={() => set({ status: toggle(f.status, s) })}>
            {s}
          </Chip>
        ))}
      </Row>
      <Row label="Plan">
        {PLANS.map((p) => (
          <Chip key={p} active={!!f.plan?.includes(p)} onClick={() => set({ plan: toggle(f.plan, p) })}>
            {p}
          </Chip>
        ))}
      </Row>
      <Row label="Discipline">
        {disciplines.map((d) => (
          <Chip key={d} active={!!f.discipline?.includes(d)} onClick={() => set({ discipline: toggle(f.discipline, d) })}>
            {d}
          </Chip>
        ))}
      </Row>
      <Row label="Belt color">
        {BELTS.map((b) => (
          <Chip key={b} active={!!f.belt_color?.includes(b)} onClick={() => set({ belt_color: toggle(f.belt_color, b) })}>
            {b}
          </Chip>
        ))}
      </Row>
      <Row label="Retention risk">
        {RISK.map((r) => (
          <Chip key={r} active={!!f.risk_tier?.includes(r)} onClick={() => set({ risk_tier: toggle(f.risk_tier, r) })}>
            {r}
          </Chip>
        ))}
      </Row>
      <Row label="Belt readiness">
        {READY.map((r) => (
          <Chip key={r} active={!!f.readiness_status?.includes(r)} onClick={() => set({ readiness_status: toggle(f.readiness_status, r) })}>
            {r}
          </Chip>
        ))}
      </Row>
      <Row label="Retention risk (persisted, nightly score)">
        {RETENTION.map((r) => (
          <Chip
            key={r}
            active={!!f.retention_risk_level?.includes(r)}
            onClick={() => set({ retention_risk_level: toggle(f.retention_risk_level, r) })}
          >
            {r}
          </Chip>
        ))}
      </Row>
      <Row label="Payment status">
        {PAYMENT.map((p) => (
          <Chip key={p} active={!!f.payment_status?.includes(p)} onClick={() => set({ payment_status: toggle(f.payment_status, p) })}>
            {p}
          </Chip>
        ))}
      </Row>
      <div className="grid grid-cols-2 gap-4">
        <NumberField
          label="Retention score greater than"
          value={f.retention_risk_score_gt ?? ""}
          onChange={(n) => set({ retention_risk_score_gt: n })}
        />
        <NumberField
          label="Days since last seen greater than"
          value={f.days_since_last_seen_gt ?? ""}
          onChange={(n) => set({ days_since_last_seen_gt: n })}
        />
        <NumberField
          label="No-shows in last 30d (at least)"
          value={f.no_shows_last_30d_gte ?? ""}
          onChange={(n) => set({ no_shows_last_30d_gte: n })}
        />
        <div className="space-y-2">
          <Label className="text-xs">Belt plateau factor</Label>
          <div className="flex gap-2">
            <Chip
              active={f.has_belt_plateau_factor === true}
              onClick={() => set({ has_belt_plateau_factor: f.has_belt_plateau_factor === true ? null : true })}
            >
              Only plateaued
            </Chip>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <NumberField
          label="Joined within (days)"
          value={f.joined_within_days ?? ""}
          onChange={(n) => set({ joined_within_days: n })}
        />
        <NumberField
          label="Last seen older than (days)"
          value={f.last_seen_min_days ?? ""}
          onChange={(n) => set({ last_seen_min_days: n })}
        />
        <NumberField
          label="Min visits / 30d"
          value={f.min_visits_30d ?? ""}
          onChange={(n) => set({ min_visits_30d: n })}
        />
        <div className="space-y-2">
          <Label className="text-xs">Has overdue invoice</Label>
          <div className="flex gap-2">
            <Chip active={f.has_overdue_invoice === true} onClick={() => set({ has_overdue_invoice: f.has_overdue_invoice === true ? null : true })}>
              Yes
            </Chip>
            <Chip active={f.has_overdue_invoice === false} onClick={() => set({ has_overdue_invoice: f.has_overdue_invoice === false ? null : false })}>
              No
            </Chip>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label className="text-xs uppercase tracking-wider text-muted-foreground">{label}</Label>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number | ""; onChange: (n: number | null) => void }) {
  return (
    <div className="space-y-2">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        min={0}
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? null : Number(v));
        }}
      />
    </div>
  );
}
