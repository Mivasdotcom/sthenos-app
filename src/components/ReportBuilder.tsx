import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Download, Plus, Save, Trash2 } from "lucide-react";
import {
  FIELDS,
  OPS_BY_TYPE,
  runReport,
  type Dataset,
  type Filter,
  type GroupBy,
  type Metric,
  type Operator,
  type ReportConfig,
  type Source,
} from "@/lib/report-builder";

const SOURCES: { value: Source; label: string }[] = [
  { value: "members", label: "Members" },
  { value: "attendances", label: "Check-ins" },
  { value: "invoices", label: "Invoices" },
  { value: "promotions", label: "Promotions" },
];

const OP_LABELS: Record<Operator, string> = {
  eq: "equals",
  neq: "not equals",
  in: "is one of (comma)",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  between: "between",
  is_null: "is empty",
  is_not_null: "is not empty",
  last_n_days: "in last N days",
  this_year: "this year",
  last_year: "last year",
};

const STORAGE_KEY = "kaizen.savedReports";

function loadSaved(): ReportConfig[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

const PRESETS: ReportConfig[] = [
  {
    name: "Attendance by month — members churned last year",
    source: "attendances",
    filters: [
      { field: "member.status", op: "eq", value: "lapsed" },
      { field: "member.joined_at", op: "last_year" },
    ],
    metric: { kind: "count" },
    groupBy: { kind: "date", field: "checked_in_at", unit: "month" },
  },
  {
    name: "Revenue by plan — paid invoices this year",
    source: "invoices",
    filters: [
      { field: "status", op: "eq", value: "paid" },
      { field: "paid_at", op: "this_year" },
    ],
    metric: { kind: "sum", field: "amount_cents" },
    groupBy: { kind: "field", field: "plan" },
  },
  {
    name: "Promotions per discipline — last 365 days",
    source: "promotions",
    filters: [{ field: "promoted_at", op: "last_n_days", value: 365 }],
    metric: { kind: "count" },
    groupBy: { kind: "field", field: "discipline" },
  },
];

export function ReportBuilder({ data }: { data: Dataset }) {
  const [config, setConfig] = useState<ReportConfig>(PRESETS[0]);
  const [saved, setSaved] = useState<ReportConfig[]>([]);

  useEffect(() => setSaved(loadSaved()), []);

  const fields = FIELDS[config.source];

  const result = useMemo(() => runReport(config, data), [config, data]);

  const updateFilter = (i: number, patch: Partial<Filter>) =>
    setConfig((c) => ({
      ...c,
      filters: c.filters.map((f, idx) => (idx === i ? { ...f, ...patch } : f)),
    }));

  const addFilter = () =>
    setConfig((c) => ({
      ...c,
      filters: [...c.filters, { field: fields[0].key, op: "eq", value: "" }],
    }));

  const removeFilter = (i: number) =>
    setConfig((c) => ({ ...c, filters: c.filters.filter((_, idx) => idx !== i) }));

  const save = () => {
    const next = [...saved.filter((r) => r.name !== config.name), config];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setSaved(next);
  };

  const exportCsv = () => {
    const rows = [result.columns, ...result.rows.map((r) => [r.group, String(r.value)])];
    const csv = rows
      .map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${config.name.toLowerCase().replace(/\s+/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
      {/* Left rail: presets & saved */}
      <aside className="space-y-6">
        <Section title="Presets">
          <ul className="space-y-1">
            {PRESETS.map((p) => (
              <li key={p.name}>
                <button
                  onClick={() => setConfig(p)}
                  className="w-full rounded-md px-3 py-2 text-left text-xs hover:bg-zinc-100"
                >
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
        </Section>
        {saved.length > 0 && (
          <Section title="Saved">
            <ul className="space-y-1">
              {saved.map((p) => (
                <li key={p.name} className="flex items-center gap-1">
                  <button
                    onClick={() => setConfig(p)}
                    className="flex-1 rounded-md px-3 py-2 text-left text-xs hover:bg-zinc-100"
                  >
                    {p.name}
                  </button>
                  <button
                    aria-label="Delete saved report"
                    className="rounded p-1 text-zinc-400 hover:text-rose-600"
                    onClick={() => {
                      const next = saved.filter((r) => r.name !== p.name);
                      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
                      setSaved(next);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </aside>

      {/* Right: editor + result */}
      <div className="space-y-6">
        <Section title="Definition">
          <div className="space-y-4">
            <Row label="Report name">
              <Input
                value={config.name}
                onChange={(e) => setConfig({ ...config, name: e.target.value })}
              />
            </Row>

            <Row label="Source">
              <Select
                value={config.source}
                onValueChange={(v) =>
                  setConfig({
                    ...config,
                    source: v as Source,
                    filters: [],
                    groupBy: { kind: "none" },
                    metric: { kind: "count" },
                  })
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SOURCES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>

            <Row label="Filters">
              <div className="space-y-2">
                {config.filters.map((f, i) => {
                  const def = fields.find((x) => x.key === f.field) ?? fields[0];
                  const ops = OPS_BY_TYPE[def.type];
                  const needsValue = !["is_null", "is_not_null", "this_year", "last_year"].includes(f.op);
                  return (
                    <div key={i} className="grid grid-cols-[1fr_140px_1fr_auto] gap-2">
                      <Select
                        value={f.field}
                        onValueChange={(v) => {
                          const nd = fields.find((x) => x.key === v)!;
                          updateFilter(i, {
                            field: v,
                            op: OPS_BY_TYPE[nd.type][0],
                            value: "",
                            value2: undefined,
                          });
                        }}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {fields.map((x) => (
                            <SelectItem key={x.key} value={x.key}>{x.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select value={f.op} onValueChange={(v) => updateFilter(i, { op: v as Operator })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {ops.map((op) => (
                            <SelectItem key={op} value={op}>{OP_LABELS[op]}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {needsValue ? (
                        def.type === "enum" && def.options ? (
                          <Select
                            value={String(f.value ?? "")}
                            onValueChange={(v) => updateFilter(i, { value: v })}
                          >
                            <SelectTrigger><SelectValue placeholder="value" /></SelectTrigger>
                            <SelectContent>
                              {def.options.map((o) => (
                                <SelectItem key={o} value={o}>{o}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : f.op === "between" ? (
                          <div className="flex gap-1">
                            <Input value={f.value ?? ""} placeholder="from" onChange={(e) => updateFilter(i, { value: e.target.value })} />
                            <Input value={f.value2 ?? ""} placeholder="to" onChange={(e) => updateFilter(i, { value2: e.target.value })} />
                          </div>
                        ) : (
                          <Input
                            value={f.value ?? ""}
                            placeholder={def.type === "date" ? "YYYY-MM-DD or N" : "value"}
                            onChange={(e) => updateFilter(i, { value: e.target.value })}
                          />
                        )
                      ) : (
                        <div />
                      )}
                      <Button variant="ghost" size="icon" onClick={() => removeFilter(i)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  );
                })}
                <Button variant="outline" size="sm" onClick={addFilter}>
                  <Plus className="size-4" /> Add filter
                </Button>
              </div>
            </Row>

            <Row label="Metric">
              <div className="grid grid-cols-[180px_1fr] gap-2">
                <Select
                  value={config.metric.kind}
                  onValueChange={(v) => {
                    if (v === "count") setConfig({ ...config, metric: { kind: "count" } });
                    else setConfig({ ...config, metric: { kind: v as Metric["kind"], field: fields[0].key } as Metric });
                  }}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="count">Count rows</SelectItem>
                    <SelectItem value="count_distinct">Count distinct</SelectItem>
                    <SelectItem value="sum">Sum</SelectItem>
                    <SelectItem value="avg">Average</SelectItem>
                  </SelectContent>
                </Select>
                {config.metric.kind !== "count" && (
                  <Select
                    value={(config.metric as any).field}
                    onValueChange={(v) =>
                      setConfig({ ...config, metric: { ...(config.metric as any), field: v } })
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {fields.map((x) => (
                        <SelectItem key={x.key} value={x.key}>{x.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </Row>

            <Row label="Group by">
              <div className="grid grid-cols-[180px_1fr_140px] gap-2">
                <Select
                  value={config.groupBy.kind}
                  onValueChange={(v) => {
                    if (v === "none") setConfig({ ...config, groupBy: { kind: "none" } });
                    else if (v === "field") setConfig({ ...config, groupBy: { kind: "field", field: fields[0].key } });
                    else setConfig({ ...config, groupBy: { kind: "date", field: fields.find((f) => f.type === "date")?.key ?? fields[0].key, unit: "month" } });
                  }}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No grouping (total)</SelectItem>
                    <SelectItem value="field">By field</SelectItem>
                    <SelectItem value="date">By date bucket</SelectItem>
                  </SelectContent>
                </Select>
                {config.groupBy.kind !== "none" && (
                  <Select
                    value={(config.groupBy as any).field}
                    onValueChange={(v) =>
                      setConfig({ ...config, groupBy: { ...(config.groupBy as any), field: v } as GroupBy })
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {fields
                        .filter((f) => (config.groupBy.kind === "date" ? f.type === "date" : true))
                        .map((x) => (
                          <SelectItem key={x.key} value={x.key}>{x.label}</SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                )}
                {config.groupBy.kind === "date" && (
                  <Select
                    value={config.groupBy.unit}
                    onValueChange={(v) =>
                      setConfig((c) =>
                        c.groupBy.kind === "date"
                          ? { ...c, groupBy: { ...c.groupBy, unit: v as "day" | "week" | "month" } }
                          : c,
                      )
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="day">Day</SelectItem>
                      <SelectItem value="week">Week</SelectItem>
                      <SelectItem value="month">Month</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </div>
            </Row>

            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={save}>
                <Save className="size-4" /> Save
              </Button>
              <Button variant="outline" size="sm" onClick={exportCsv}>
                <Download className="size-4" /> Export CSV
              </Button>
            </div>
          </div>
        </Section>

        <Section title={`Result — ${result.rows.length} row${result.rows.length === 1 ? "" : "s"}`}>
          {result.rows.length > 1 && config.groupBy.kind !== "none" && (
            <div className="mb-4">
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={result.rows} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="group" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="value" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-950/5 text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">{result.columns[0]}</th>
                  <th className="py-2 pr-4 font-medium">{result.columns[1]}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.group} className="border-b border-zinc-950/5">
                    <td className="py-2 pr-4">{r.group}</td>
                    <td className="py-2 pr-4 tabular-nums">{r.value.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-950/5 bg-card p-5">
      <div className="mb-4 text-sm font-semibold">{title}</div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-[140px_1fr]">
      <div className="pt-2 text-xs font-medium text-muted-foreground">{label}</div>
      <div>{children}</div>
    </div>
  );
}
