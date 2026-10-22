import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type LastSeenOption =
  | "any"
  | "this_week"
  | "this_month"
  | "over_14d"
  | "over_30d"
  | "over_60d";

export type JoinedOption = "any" | "this_month" | "this_year" | "over_1y";

export type StripesOption = "any" | "0" | "1" | "2" | "3" | "4";

export type SessionsOption = "any" | "0" | "1_3" | "4_plus" | "8_plus";

export type MembersFilters = {
  belts: string[];
  statuses: string[];
  plans: string[];
  disciplines: string[];
  lastSeen: LastSeenOption;
  joined: JoinedOption;
  stripes: StripesOption;
  sessions: SessionsOption;
};

export const EMPTY_FILTERS: MembersFilters = {
  belts: [],
  statuses: [],
  plans: [],
  disciplines: [],
  lastSeen: "any",
  joined: "any",
  stripes: "any",
  sessions: "any",
};

export function countActiveFilters(f: MembersFilters): number {
  return (
    (f.belts.length ? 1 : 0) +
    (f.statuses.length ? 1 : 0) +
    (f.plans.length ? 1 : 0) +
    (f.disciplines.length ? 1 : 0) +
    (f.lastSeen !== "any" ? 1 : 0) +
    (f.joined !== "any" ? 1 : 0) +
    (f.stripes !== "any" ? 1 : 0) +
    (f.sessions !== "any" ? 1 : 0)
  );
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

type Props = {
  value: MembersFilters;
  onChange: (next: MembersFilters) => void;
  beltOptions: string[];
  planOptions: string[];
  disciplineOptions: string[];
};

export function MembersFilterPanel({
  value,
  onChange,
  beltOptions,
  planOptions,
  disciplineOptions,
}: Props) {
  const statusOptions = ["active", "lapsed", "trial"];

  return (
    <div className="rounded-xl border bg-card p-4 ring-1 ring-black/5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Filters</h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange(EMPTY_FILTERS)}
          className="text-xs"
        >
          Clear all
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MultiCheckGroup
          label="Belt"
          options={beltOptions}
          selected={value.belts}
          onToggle={(v) => onChange({ ...value, belts: toggle(value.belts, v) })}
          capitalize
        />

        <MultiCheckGroup
          label="Status"
          options={statusOptions}
          selected={value.statuses}
          onToggle={(v) => onChange({ ...value, statuses: toggle(value.statuses, v) })}
          capitalize
        />

        <MultiCheckGroup
          label="Plan"
          options={planOptions}
          selected={value.plans}
          onToggle={(v) => onChange({ ...value, plans: toggle(value.plans, v) })}
        />

        <MultiCheckGroup
          label="Discipline"
          options={disciplineOptions}
          selected={value.disciplines}
          onToggle={(v) =>
            onChange({ ...value, disciplines: toggle(value.disciplines, v) })
          }
        />

        <SelectRow
          label="Last seen"
          value={value.lastSeen}
          onChange={(v) => onChange({ ...value, lastSeen: v as LastSeenOption })}
          options={[
            ["any", "Any time"],
            ["this_week", "This week"],
            ["this_month", "This month"],
            ["over_14d", "Over 2 weeks ago"],
            ["over_30d", "Over 30 days ago"],
            ["over_60d", "Over 60 days ago"],
          ]}
        />

        <SelectRow
          label="Joined"
          value={value.joined}
          onChange={(v) => onChange({ ...value, joined: v as JoinedOption })}
          options={[
            ["any", "Any time"],
            ["this_month", "This month"],
            ["this_year", "This year"],
            ["over_1y", "Over 1 year ago"],
          ]}
        />

        <SelectRow
          label="Stripes"
          value={value.stripes}
          onChange={(v) => onChange({ ...value, stripes: v as StripesOption })}
          options={[
            ["any", "Any"],
            ["0", "0"],
            ["1", "1"],
            ["2", "2"],
            ["3", "3"],
            ["4", "4"],
          ]}
        />

        <SelectRow
          label="Sessions this month"
          value={value.sessions}
          onChange={(v) => onChange({ ...value, sessions: v as SessionsOption })}
          options={[
            ["any", "Any"],
            ["0", "0 sessions"],
            ["1_3", "1–3 sessions"],
            ["4_plus", "4+ sessions"],
            ["8_plus", "8+ sessions"],
          ]}
        />
      </div>
    </div>
  );
}

function MultiCheckGroup({
  label,
  options,
  selected,
  onToggle,
  capitalize,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (v: string) => void;
  capitalize?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      <div className="max-h-32 space-y-1.5 overflow-y-auto pr-1">
        {options.length === 0 ? (
          <p className="text-xs text-muted-foreground">No options</p>
        ) : (
          options.map((opt) => {
            const id = `${label}-${opt}`;
            return (
              <div key={opt} className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={selected.includes(opt)}
                  onCheckedChange={() => onToggle(opt)}
                />
                <label
                  htmlFor={id}
                  className={cn("text-sm cursor-pointer", capitalize && "capitalize")}
                >
                  {opt}
                </label>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function SelectRow({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <div className="space-y-2">
      <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([val, lbl]) => (
            <SelectItem key={val} value={val}>
              {lbl}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
