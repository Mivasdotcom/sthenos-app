// Declarative report builder over fetched dojo data.
// Source = base entity. Filters narrow rows. Metric is the aggregated output.
// Group-by produces one row per bucket; otherwise a single total row.

export type Source = "members" | "attendances" | "invoices" | "promotions";

export type FieldType = "string" | "enum" | "number" | "date";

export type FieldDef = {
  key: string; // dotted path: e.g. "status" or "member.discipline"
  label: string;
  type: FieldType;
  options?: string[]; // for enum
};

export type Operator =
  | "eq"
  | "neq"
  | "in"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "is_null"
  | "is_not_null"
  | "last_n_days"
  | "this_year"
  | "last_year";

export type Filter = {
  field: string;
  op: Operator;
  value?: string | number;
  value2?: string | number;
};

export type Metric =
  | { kind: "count" }
  | { kind: "count_distinct"; field: string }
  | { kind: "sum"; field: string }
  | { kind: "avg"; field: string };

export type GroupBy =
  | { kind: "none" }
  | { kind: "field"; field: string }
  | { kind: "date"; field: string; unit: "day" | "week" | "month" };

export type ReportConfig = {
  name: string;
  source: Source;
  filters: Filter[];
  metric: Metric;
  groupBy: GroupBy;
};

// ───── field catalog (drives the UI) ─────

export const FIELDS: Record<Source, FieldDef[]> = {
  members: [
    { key: "name", label: "Name", type: "string" },
    { key: "status", label: "Status", type: "enum", options: ["active", "lapsed", "trial"] },
    { key: "discipline", label: "Discipline", type: "enum", options: ["BJJ", "Judo", "Karate", "Muay Thai"] },
    { key: "plan", label: "Plan", type: "enum", options: ["Monthly", "Annual", "Drop-in", "Family"] },
    { key: "belt_color", label: "Belt color", type: "string" },
    { key: "joined_at", label: "Joined at", type: "date" },
    { key: "last_seen_at", label: "Last seen", type: "date" },
  ],
  attendances: [
    { key: "checked_in_at", label: "Check-in time", type: "date" },
    { key: "member.name", label: "Member name", type: "string" },
    { key: "member.status", label: "Member status", type: "enum", options: ["active", "lapsed", "trial"] },
    { key: "member.discipline", label: "Member discipline", type: "enum", options: ["BJJ", "Judo", "Karate", "Muay Thai"] },
    { key: "member.plan", label: "Member plan", type: "enum", options: ["Monthly", "Annual", "Drop-in", "Family"] },
    { key: "member.joined_at", label: "Member joined at", type: "date" },
    { key: "class.name", label: "Class name", type: "string" },
  ],
  invoices: [
    { key: "amount_cents", label: "Amount (cents)", type: "number" },
    { key: "status", label: "Status", type: "enum", options: ["due", "paid", "overdue", "void"] },
    { key: "plan", label: "Plan", type: "enum", options: ["Monthly", "Annual", "Drop-in", "Family"] },
    { key: "due_date", label: "Due date", type: "date" },
    { key: "paid_at", label: "Paid at", type: "date" },
    { key: "member.name", label: "Member name", type: "string" },
    { key: "member.status", label: "Member status", type: "enum", options: ["active", "lapsed", "trial"] },
    { key: "member.discipline", label: "Member discipline", type: "enum", options: ["BJJ", "Judo", "Karate", "Muay Thai"] },
  ],
  promotions: [
    { key: "promoted_at", label: "Promoted at", type: "date" },
    { key: "discipline", label: "Discipline", type: "enum", options: ["BJJ", "Judo", "Karate", "Muay Thai"] },
    { key: "to_color", label: "To color", type: "string" },
    { key: "member.name", label: "Member name", type: "string" },
    { key: "member.status", label: "Member status", type: "enum", options: ["active", "lapsed", "trial"] },
  ],
};

export const OPS_BY_TYPE: Record<FieldType, Operator[]> = {
  string: ["eq", "neq", "in", "is_null", "is_not_null"],
  enum: ["eq", "neq", "in", "is_null", "is_not_null"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  date: ["gt", "gte", "lt", "lte", "between", "last_n_days", "this_year", "last_year", "is_null", "is_not_null"],
};

// ───── runner ─────

export type Dataset = {
  members: any[];
  attendances: any[];
  invoices: any[];
  classes: any[];
  promotions: any[];
};

function getField(row: any, path: string): any {
  return path.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), row);
}

function compare(value: any, f: Filter): boolean {
  const isNullish = value === null || value === undefined || value === "";
  switch (f.op) {
    case "is_null":
      return isNullish;
    case "is_not_null":
      return !isNullish;
  }
  if (isNullish) return false;
  switch (f.op) {
    case "eq":
      return String(value) === String(f.value);
    case "neq":
      return String(value) !== String(f.value);
    case "in":
      return String(f.value ?? "")
        .split(",")
        .map((s) => s.trim())
        .includes(String(value));
    case "gt":
      return Number(value) > Number(f.value);
    case "gte":
      return Number(value) >= Number(f.value);
    case "lt":
      return Number(value) < Number(f.value);
    case "lte":
      return Number(value) <= Number(f.value);
    case "between":
      return Number(value) >= Number(f.value) && Number(value) <= Number(f.value2);
    case "last_n_days": {
      const n = Number(f.value);
      if (!n) return false;
      const t = new Date(value).getTime();
      return t >= Date.now() - n * 86400000;
    }
    case "this_year": {
      const y = new Date().getUTCFullYear();
      return new Date(value).getUTCFullYear() === y;
    }
    case "last_year": {
      const y = new Date().getUTCFullYear() - 1;
      return new Date(value).getUTCFullYear() === y;
    }
  }
  return true;
}

function joinRows(source: Source, data: Dataset): any[] {
  const memberById = new Map(data.members.map((m) => [m.id, m]));
  const classById = new Map(data.classes.map((c) => [c.id, c]));
  switch (source) {
    case "members":
      return data.members;
    case "attendances":
      return data.attendances.map((a) => ({
        ...a,
        member: memberById.get(a.member_id),
        class: classById.get(a.class_id),
      }));
    case "invoices":
      return data.invoices.map((i) => ({ ...i, member: memberById.get(i.member_id) }));
    case "promotions":
      return data.promotions.map((p) => ({ ...p, member: memberById.get(p.member_id) }));
  }
}

function bucketDate(d: string | Date, unit: "day" | "week" | "month"): string {
  const date = new Date(d);
  if (unit === "month") {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  if (unit === "week") {
    const day = (date.getUTCDay() + 6) % 7; // Monday=0
    const monday = new Date(date);
    monday.setUTCDate(date.getUTCDate() - day);
    return monday.toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

export type ReportResult = {
  columns: [string, string]; // [groupColumn, metricColumn]
  rows: { group: string; value: number }[];
};

export function runReport(config: ReportConfig, data: Dataset): ReportResult {
  const joined = joinRows(config.source, data).filter((row) =>
    config.filters.every((f) => compare(getField(row, f.field), f)),
  );

  const groupKey = (row: any): string => {
    if (config.groupBy.kind === "none") return "Total";
    if (config.groupBy.kind === "field") return String(getField(row, config.groupBy.field) ?? "—");
    const v = getField(row, config.groupBy.field);
    return v ? bucketDate(v, config.groupBy.unit) : "—";
  };

  const groups = new Map<string, any[]>();
  for (const row of joined) {
    const k = groupKey(row);
    const arr = groups.get(k) ?? [];
    arr.push(row);
    groups.set(k, arr);
  }

  const rows: { group: string; value: number }[] = [];
  for (const [g, members] of groups) {
    let v = 0;
    const m = config.metric;
    if (m.kind === "count") {
      v = members.length;
    } else if (m.kind === "count_distinct") {
      v = new Set(members.map((r) => getField(r, m.field))).size;
    } else if (m.kind === "sum") {
      v = members.reduce((a, r) => a + (Number(getField(r, m.field)) || 0), 0);
    } else if (m.kind === "avg") {
      const nums = members.map((r) => Number(getField(r, m.field))).filter((n) => !Number.isNaN(n));
      v = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    }
    rows.push({ group: g, value: v });
  }

  rows.sort((a, b) =>
    config.groupBy.kind === "date" ? a.group.localeCompare(b.group) : b.value - a.value,
  );

  const metricLabel =
    config.metric.kind === "count"
      ? "Count"
      : config.metric.kind === "count_distinct"
      ? `Distinct ${config.metric.field}`
      : `${config.metric.kind.toUpperCase()}(${config.metric.field})`;
  const groupLabel =
    config.groupBy.kind === "none"
      ? "All"
      : config.groupBy.kind === "field"
      ? config.groupBy.field
      : `${config.groupBy.field} (${config.groupBy.unit})`;

  return { columns: [groupLabel, metricLabel], rows };
}
