export type BeltColor =
  | "beginner"
  | "white" | "yellow" | "orange" | "green" | "blue"
  | "purple" | "brown" | "red" | "black"
  | "novice" | "intermediate" | "advanced" | "competitor";

export interface Belt {
  color: BeltColor;
  label: string;
  stripes?: number;
  dan?: number;
}

export const beltClassMap: Record<BeltColor, { dot: string; ring: string; bg: string; text: string }> = {
  beginner: { dot: "bg-zinc-300 border border-zinc-400", ring: "ring-zinc-300", bg: "bg-zinc-100", text: "text-zinc-700" },
  white:  { dot: "bg-belt-white border border-zinc-300", ring: "ring-zinc-200", bg: "bg-zinc-50", text: "text-zinc-700" },
  yellow: { dot: "bg-belt-yellow", ring: "ring-yellow-200", bg: "bg-yellow-50", text: "text-yellow-800" },
  orange: { dot: "bg-belt-orange", ring: "ring-orange-200", bg: "bg-orange-50", text: "text-orange-800" },
  green:  { dot: "bg-belt-green", ring: "ring-emerald-200", bg: "bg-emerald-50", text: "text-emerald-800" },
  blue:   { dot: "bg-belt-blue", ring: "ring-blue-200", bg: "bg-blue-50", text: "text-blue-800" },
  purple: { dot: "bg-belt-purple", ring: "ring-purple-200", bg: "bg-purple-50", text: "text-purple-800" },
  brown:  { dot: "bg-belt-brown", ring: "ring-amber-200", bg: "bg-amber-50", text: "text-amber-900" },
  red:    { dot: "bg-belt-red", ring: "ring-red-200", bg: "bg-red-50", text: "text-red-800" },
  black:  { dot: "bg-belt-black", ring: "ring-zinc-300", bg: "bg-zinc-100", text: "text-zinc-950" },
  novice:       { dot: "bg-zinc-400 border border-zinc-500", ring: "ring-zinc-300", bg: "bg-zinc-100", text: "text-zinc-700" },
  intermediate: { dot: "bg-zinc-500 border border-zinc-600", ring: "ring-zinc-400", bg: "bg-zinc-100", text: "text-zinc-800" },
  advanced:     { dot: "bg-zinc-700 border border-zinc-800", ring: "ring-zinc-500", bg: "bg-zinc-200", text: "text-zinc-900" },
  competitor:   { dot: "bg-belt-red", ring: "ring-red-300", bg: "bg-red-50", text: "text-red-900" },
};

export const RANK_LABELS: Record<BeltColor, string> = {
  beginner: "Beginner",
  white: "White",
  yellow: "Yellow",
  orange: "Orange",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
  brown: "Brown",
  red: "Red",
  black: "Black",
  novice: "Novice",
  intermediate: "Intermediate",
  advanced: "Advanced",
  competitor: "Competitor",
};

export type Discipline = string;

// Traditional belt orderings — "beginner" is always the first option (never trained before).
const BJJ_ORDER: BeltColor[] = ["beginner", "white", "blue", "purple", "brown", "black"];
const TRADITIONAL_ORDER: BeltColor[] = ["beginner", "white", "yellow", "orange", "green", "blue", "brown", "black"];
const MUAY_THAI_ORDER: BeltColor[] = ["beginner", "white", "yellow", "green", "blue", "brown", "red", "black"];
const NO_BELT_ORDER: BeltColor[] = ["beginner", "novice", "intermediate", "advanced", "competitor"];

export const BELT_COLORS_BY_DISCIPLINE: Record<string, BeltColor[]> = {
  BJJ: BJJ_ORDER,
  "Brazilian Jiu-Jitsu": BJJ_ORDER,
  "No-Gi Jiu-Jitsu": BJJ_ORDER,
  Judo: TRADITIONAL_ORDER,
  Karate: TRADITIONAL_ORDER,
  Taekwondo: TRADITIONAL_ORDER,
  "Kung Fu": TRADITIONAL_ORDER,
  "Krav Maga": TRADITIONAL_ORDER,
  Capoeira: TRADITIONAL_ORDER,
  Aikido: TRADITIONAL_ORDER,
  "Muay Thai": MUAY_THAI_ORDER,
  Boxing: NO_BELT_ORDER,
  Kickboxing: NO_BELT_ORDER,
  MMA: NO_BELT_ORDER,
  Wrestling: NO_BELT_ORDER,
  Sambo: NO_BELT_ORDER,
  Fencing: NO_BELT_ORDER,
  Other: NO_BELT_ORDER,
  default: TRADITIONAL_ORDER,
};

export function getBeltColors(discipline?: string): BeltColor[] {
  if (!discipline) return BELT_COLORS_BY_DISCIPLINE.default;
  return (BELT_COLORS_BY_DISCIPLINE[discipline] ?? BELT_COLORS_BY_DISCIPLINE.default) as BeltColor[];
}

// Canonical, curated list of martial-arts disciplines shown in every discipline
// picker. Deliberately NOT merged with the gym's class types — a class type
// ("Adult BJJ No Gi") is a timetable session name, not a discipline.
export const STANDARD_DISCIPLINES: string[] = [
  "BJJ",
  "MMA",
  "Muay Thai",
  "Boxing",
  "Kickboxing",
  "Wrestling",
  "Judo",
  "Karate",
  "Taekwondo",
  "Kung Fu",
  "Krav Maga",
  "Capoeira",
  "Aikido",
  "Sambo",
  "Fencing",
  "Other",
];

/**
 * Canonicalise a discipline name so equivalent spellings collapse into one
 * option. Brazilian Jiu-Jitsu (in all its spellings, gi or no-gi) is always
 * labelled "BJJ".
 */
export function canonicalDiscipline(name: string): string {
  const n = name.trim();
  const k = n.toLowerCase().replace(/[\s._-]+/g, " ").trim();
  if (
    /\b(bjj|jiu ?jitsu)\b/.test(k) ||
    k === "gi bjj" ||
    k === "bjj gi" ||
    // No-gi is BJJ trained without the gi -- the same art, the same belts, the
    // same grading. Offering it as its own discipline asked a member joining a
    // BJJ gym to pick between two names for what they do.
    /\bno ?gi\b/.test(k)
  ) {
    return "BJJ";
  }
  return n;
}

/**
 * The options offered by a discipline selector.
 *
 * When the gym's own disciplines are supplied, only those are offered —
 * canonicalised and de-duplicated case-insensitively, so belt colours and
 * grading keep resolving. When nothing usable is supplied (e.g. a gym that has
 * not configured class types yet), fall back to the full curated list so no
 * dropdown is ever empty and nobody is blocked from signing up.
 */
export function buildDisciplineOptions(gymDisciplines: string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    if (!raw || !raw.trim()) return;
    const canon = canonicalDiscipline(raw);
    const key = canon.toLowerCase().replace(/[\s._-]+/g, " ").trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(canon);
  };
  for (const raw of gymDisciplines) add(raw);
  if (out.length > 0) return out;
  for (const raw of STANDARD_DISCIPLINES) add(raw);
  return out;
}


