// CRM migration presets. Maps source CRM CSV column headers -> our schema.
// Each preset declares aliases (case-insensitive) for each target field.

export type Entity = "members" | "attendances";

export type FieldDef = {
  key: string;
  label: string;
  required?: boolean;
  hint?: string;
};

export const MEMBER_FIELDS: FieldDef[] = [
  { key: "name", label: "Name" },
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "discipline", label: "Discipline", required: true, hint: "BJJ, Judo, Karate, Muay Thai" },
  { key: "belt_color", label: "Belt color", hint: "white..black" },
  { key: "belt_label", label: "Belt label" },
  { key: "stripes", label: "Stripes" },
  { key: "status", label: "Status", hint: "active, lapsed, trial" },
  { key: "plan", label: "Plan", hint: "Monthly, Annual, Drop-in, Family" },
  { key: "joined_at", label: "Joined date" },
  { key: "last_seen_at", label: "Last seen" },
];

export const ATTENDANCE_FIELDS: FieldDef[] = [
  { key: "member_email", label: "Member email", required: true, hint: "used to match member" },
  { key: "checked_in_at", label: "Check-in timestamp", required: true },
];

type Aliases = Record<string, string[]>;

export type Preset = {
  id: string;
  name: string;
  description: string;
  members: Aliases;
  attendances: Aliases;
};

export const PRESETS: Preset[] = [
  {
    id: "gymdesk",
    name: "GymDesk",
    description: "Standard GymDesk member & attendance export.",
    members: {
      name: ["full name", "name", "member name"],
      email: ["email", "email address"],
      phone: ["phone", "mobile", "phone number"],
      discipline: ["program", "primary program", "discipline"],
      belt_color: ["belt", "rank color", "belt color"],
      belt_label: ["rank", "rank name", "belt rank"],
      stripes: ["stripes", "stripe count"],
      status: ["status", "membership status"],
      plan: ["membership", "plan", "membership plan"],
      joined_at: ["join date", "joined", "start date", "member since"],
      last_seen_at: ["last attendance", "last check-in", "last seen"],
    },
    attendances: {
      member_email: ["email", "member email"],
      checked_in_at: ["check-in time", "checked in", "date", "timestamp"],
    },
  },
  {
    id: "kicksite",
    name: "Kicksite",
    description: "Kicksite student & attendance export.",
    members: {
      name: ["student name", "name", "full name"],
      email: ["email", "primary email"],
      phone: ["phone", "primary phone"],
      discipline: ["program", "style", "discipline"],
      belt_color: ["belt color", "rank color"],
      belt_label: ["current rank", "rank", "belt"],
      stripes: ["stripes", "tips"],
      status: ["status", "active"],
      plan: ["billing plan", "plan"],
      joined_at: ["enrollment date", "start date", "join date"],
      last_seen_at: ["last attended", "last visit"],
    },
    attendances: {
      member_email: ["student email", "email"],
      checked_in_at: ["attendance date", "date", "check-in"],
    },
  },
  {
    id: "zenplanner",
    name: "Zen Planner",
    description: "Zen Planner person & attendance export.",
    members: {
      name: ["person name", "name", "first name + last name"],
      email: ["email address", "email"],
      phone: ["mobile phone", "phone"],
      discipline: ["program", "primary program"],
      belt_color: ["belt color"],
      belt_label: ["belt rank", "rank"],
      stripes: ["stripes"],
      status: ["status", "person status"],
      plan: ["membership type", "plan"],
      joined_at: ["first attendance", "joined on"],
      last_seen_at: ["last attendance"],
    },
    attendances: {
      member_email: ["email", "person email"],
      checked_in_at: ["attendance datetime", "date", "check-in time"],
    },
  },
  {
    id: "bjjlink",
    name: "BJJ Link",
    description: "BJJ Link member export (CSV).",
    members: {
      name: ["name", "full name", "student name"],
      email: ["email", "email address"],
      phone: ["phone", "mobile"],
      discipline: ["discipline", "program", "style"],
      belt_color: ["belt", "belt color", "rank color"],
      belt_label: ["rank", "belt rank"],
      stripes: ["stripes"],
      status: ["status", "membership status"],
      plan: ["plan", "membership"],
      joined_at: ["joined", "start date", "join date"],
      last_seen_at: ["last seen", "last attendance"],
    },
    attendances: {
      member_email: ["email", "member email"],
      checked_in_at: ["date", "check-in", "attended at"],
    },
  },
  {
    id: "maat",
    name: "Maat",
    description: "Maat gym management export.",
    members: {
      name: ["name", "member name", "full name"],
      email: ["email"],
      phone: ["phone", "telephone"],
      discipline: ["class type", "discipline", "program"],
      belt_color: ["belt colour", "belt color", "grade colour"],
      belt_label: ["grade", "belt", "rank"],
      stripes: ["stripes"],
      status: ["status"],
      plan: ["plan", "tariff", "membership"],
      joined_at: ["joined date", "start date", "registration date"],
      last_seen_at: ["last class", "last seen"],
    },
    attendances: {
      member_email: ["email", "member email"],
      checked_in_at: ["date", "class date", "attended"],
    },
  },
  {
    id: "wodify",
    name: "Wodify / Mindbody",
    description: "Covers Wodify and Mindbody CSV exports.",
    members: {
      first_name: ["first name", "firstname"],
      last_name: ["last name", "lastname"],
      name: ["name", "client name", "member name"],
      email: ["email", "email address", "client email"],
      phone: ["phone", "mobile phone", "cell phone"],
      discipline: ["program", "class type", "service"],
      belt_color: ["rank", "belt", "level"],
      status: ["status", "account status", "membership status"],
      plan: ["membership", "pricing option", "plan"],
      joined_at: ["join date", "first visit", "enrollment date"],
      last_seen_at: ["last visit", "last attendance"],
    },
    attendances: {
      member_email: ["client email", "email"],
      checked_in_at: ["class date", "date", "start time", "attendance date"],
    },
  },
  {
    id: "custom",
    name: "Custom CSV",
    description: "Map columns manually from any CSV export.",
    members: {},
    attendances: {},
  },
];

// ---- Normalizers ----

import { getBeltColors as getDisciplineBeltColors, type BeltColor, type Discipline } from "./belt-colors";

export { getDisciplineBeltColors as getBeltColors };
export type { BeltColor, Discipline };

const DISCIPLINES: Discipline[] = ["BJJ", "Judo", "Karate", "Muay Thai"];

const STATUSES = ["active","lapsed","trial"];
// Plans are fetched from dojo_plans at import time.
const PLAN_FALLBACKS = ["Monthly", "Annual", "Drop-in", "Family"];

export function normalizeDiscipline(v: string): string | null {
  if (!v) return null;
  const s = v.toLowerCase().trim();
  if (s.includes("bjj") || s.includes("jiu")) return "BJJ";
  if (s.includes("judo")) return "Judo";
  if (s.includes("karate")) return "Karate";
  if (s.includes("muay") || s.includes("thai") || s.includes("kickbox")) return "Muay Thai";
  const exact = DISCIPLINES.find((d) => d.toLowerCase() === s);
  return exact ?? null;
}

export function normalizeBeltColor(v: string, discipline?: string): string {
  if (!v) return "white";
  const colors = getDisciplineBeltColors(discipline);
  const s = v.toLowerCase().trim();
  const found = colors.find((c) => s.includes(c));
  return found ?? colors[0] ?? "white";
}

export function extractStripesFromBeltString(v: string, discipline?: string): number {
  if (!v) return 0;
  const s = v.toLowerCase();
  const colors = getDisciplineBeltColors(discipline);
  // Find a number that appears after the colour word, e.g. "blue belt - 2 stripes"
  const colorIdx = colors.map((c) => s.indexOf(c)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  const tail = colorIdx != null ? s.slice(colorIdx) : s;
  const m = tail.match(/(\d+)\s*(?:stripe|stripes|tips?)?/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(4, n)) : 0;
}

export function normalizeStatus(v: string): string {
  if (!v) return "active";
  const s = v.toLowerCase().trim();
  if (s.includes("trial")) return "trial";
  if (s.includes("laps") || s.includes("inactive") || s.includes("cancel") || s.includes("former")) return "lapsed";
  return STATUSES.includes(s) ? s : "active";
}

export function normalizePlan(v: string, planNames?: string[]): string {
  if (!v) return planNames?.[0] ?? "Monthly";
  const s = v.toLowerCase().trim();
  if (planNames && planNames.length) {
    const match = planNames.find((p) => p.toLowerCase() === s)
      ?? planNames.find((p) => s.includes(p.toLowerCase()) || p.toLowerCase().includes(s));
    if (match) return match;
  }
  if (s.includes("annual") || s.includes("year")) return "Annual";
  if (s.includes("drop")) return "Drop-in";
  if (s.includes("family")) return "Family";
  const fallback = PLAN_FALLBACKS.find((p) => p.toLowerCase() === s);
  if (fallback) return fallback;
  return planNames?.[0] ?? "Monthly";
}

export function normalizeStripes(v: string): number {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(4, n)) : 0;
}

export function normalizeDate(v: string): string | null {
  if (!v) return null;
  const s = v.trim();
  // Try DD/MM/YYYY first
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    const d = new Date(
      Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]))
    );
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  // Fall back to ISO / MM-DD-YYYY etc.
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function autoMap(preset: Preset, entity: Entity, headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  const aliases = preset[entity];
  const lowered = headers.map((h) => h.toLowerCase().trim());
  for (const [field, names] of Object.entries(aliases)) {
    for (const alias of names) {
      const idx = lowered.indexOf(alias.toLowerCase());
      if (idx !== -1) {
        map[field] = headers[idx];
        break;
      }
    }
  }
  return map;
}
