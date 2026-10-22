// Pure family pricing maths. Safe to import anywhere (client or server).
//
// Two coexisting models:
//  - "flat"   — the gym sets a single family plan price (original behaviour).
//  - "tiered" — a percentage discount is applied to the SUM of each family
//               member's own individual plan price. Recommended default.

export type FamilyPricingMode = "flat" | "tiered";

export type FamilyDiscountTier = {
  /** Family size at which this percentage starts applying. */
  min_members: number;
  /** 0–100. */
  discount_percent: number;
};

export const DEFAULT_FAMILY_TIERS: FamilyDiscountTier[] = [
  { min_members: 2, discount_percent: 10 },
  { min_members: 3, discount_percent: 30 },
  { min_members: 4, discount_percent: 40 },
];


export type FamilyPriceMember = {
  id?: string;
  name: string;
  planName?: string | null;
  /** The amount this member contributes, in the family's billing interval. */
  priceCents: number;
  /** The member's own plan interval, when it differs from the family's. */
  interval?: string | null;
  /** Set when the price above was converted from another interval. */
  nativePriceCents?: number | null;
  nativeInterval?: string | null;
  /** The member's membership status, which decides whether they are billed. */
  status?: string | null;
  /**
   * False for a parent or guardian who pays for the family without training
   * themselves. They hold the login and the card but buy nothing, so they must
   * not add a price to the total or a head to the discount tier.
   */
  trains?: boolean | null;
};

/**
 * THE single source of truth for who a family payer is billed for.
 *
 * A member stays in the family group — profile, attendance, belt tracking all
 * continue — but only these statuses are actually paying, so only they add to
 * the family total and to the member count used for the discount tier.
 *
 * Never re-implement this check in a calling path: they drift.
 */
export const FAMILY_UNCOUNTED_STATUSES = [
  "trial",
  "paused",
  "lapsed",
  "cancelled",
  "canceled",
  "pending",
  "inactive",
] as const;

export function countsTowardFamilyTotal(
  status?: string | null,
  trains?: boolean | null,
): boolean {
  // A payer who doesn't train buys nothing, whatever their status says.
  if (trains === false) return false;
  const s = (status ?? "active").toLowerCase();
  return !(FAMILY_UNCOUNTED_STATUSES as readonly string[]).includes(s);
}

/** Short plain-English reason a member is not billed, for the breakdown UI. */
export function familyExclusionLabel(
  status?: string | null,
  trains?: boolean | null,
): string | null {
  if (trains === false) return "pays for the family, doesn't train";
  const s = (status ?? "active").toLowerCase();
  if (countsTowardFamilyTotal(s)) return null;
  if (s === "trial") return "on trial, not counted";
  if (s === "paused") return "paused, not counted";
  if (s === "pending") return "signup not finished, not counted";
  if (s === "lapsed") return "lapsed, not counted";
  if (s === "cancelled" || s === "canceled") return "cancelled, not counted";
  return "not counted";
}

export function splitFamilyByCounted<
  T extends { status?: string | null; trains?: boolean | null },
>(rows: T[]): { counted: T[]; uncounted: T[] } {
  return {
    counted: rows.filter((r) => countsTowardFamilyTotal(r.status, r.trains)),
    uncounted: rows.filter((r) => !countsTowardFamilyTotal(r.status, r.trains)),
  };
}

export type FamilyQuote = {
  /** Number of members actually counted (billed) — drives the discount tier. */
  size: number;
  /** Sum of every COUNTED member's own plan price. */
  subtotalCents: number;
  discountPercent: number;
  discountCents: number;
  totalCents: number;
  currency: string;
  interval: string;
  /** Counted (billed) members only. */
  members: FamilyPriceMember[];
  /** In the family, but not billed yet (trial, paused, lapsed, pending…). */
  uncounted: FamilyPriceMember[];
  /** Members with no plan of their own — they contribute nothing to the sum. */
  missingPlanNames: string[];
  /** Members whose price was converted from a different billing interval. */
  normalisedNames: string[];
};

export function sortTiers(tiers: FamilyDiscountTier[]): FamilyDiscountTier[] {
  return [...tiers].sort((a, b) => a.min_members - b.min_members);
}

/** The highest tier whose min_members is <= the family size. 0 when none. */
export function tierPercentFor(
  tiers: FamilyDiscountTier[],
  size: number,
): number {
  let pct = 0;
  for (const t of sortTiers(tiers)) {
    if (size >= t.min_members) pct = t.discount_percent;
  }
  return clampPercent(pct);
}

export function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

function normInterval(i?: string | null): string {
  const v = (i ?? "month").toLowerCase();
  return v === "year" || v === "annual" || v === "yearly" ? "year" : v === "one_time" ? "one_time" : "month";
}

/**
 * Convert an amount from one billing interval to another. A family is billed on
 * ONE interval (the payer's), so a member on a different plan interval must be
 * converted before their price can be summed: annual/12 for a monthly family,
 * monthly*12 for an annual family.
 */
export function convertPriceCents(
  cents: number,
  from?: string | null,
  to?: string | null,
): number {
  const f = normInterval(from);
  const t = normInterval(to);
  if (f === t) return Math.round(cents);
  if (f === "one_time" || t === "one_time") return Math.round(cents);
  if (f === "year" && t === "month") return Math.round(cents / 12);
  if (f === "month" && t === "year") return Math.round(cents * 12);
  return Math.round(cents);
}

export function intervalWord(interval?: string | null): string {
  const i = normInterval(interval);
  return i === "year" ? "yearly" : i === "one_time" ? "one-off" : "monthly";
}

export function computeFamilyQuote(opts: {
  members: FamilyPriceMember[];
  tiers: FamilyDiscountTier[];
  currency?: string | null;
  interval?: string | null;
}): FamilyQuote {
  const familyInterval = normInterval(opts.interval);
  // Normalise every member's price into the family's billing interval before
  // summing — otherwise an annual plan is billed in full every month.
  const normalise = (m: FamilyPriceMember): FamilyPriceMember => {
    const own = normInterval(m.interval ?? familyInterval);
    if (own === familyInterval) return m;
    return {
      ...m,
      priceCents: convertPriceCents(m.priceCents || 0, own, familyInterval),
      nativePriceCents: m.priceCents || 0,
      nativeInterval: own,
    };
  };
  // Only paying members are billed and counted towards the discount tier.
  const split = splitFamilyByCounted(opts.members);
  const members: FamilyPriceMember[] = split.counted.map(normalise);
  const uncounted: FamilyPriceMember[] = split.uncounted.map(normalise);
  const size = members.length;
  const subtotalCents = members.reduce((sum, m) => sum + (m.priceCents || 0), 0);
  const discountPercent = tierPercentFor(opts.tiers, size);
  const discountCents = Math.round((subtotalCents * discountPercent) / 100);
  return {
    size,
    subtotalCents,
    discountPercent,
    discountCents,
    totalCents: Math.max(0, subtotalCents - discountCents),
    currency: (opts.currency ?? "usd").toLowerCase(),
    interval: familyInterval,
    members,
    uncounted,
    missingPlanNames: members.filter((m) => !m.priceCents).map((m) => m.name),
    normalisedNames: members.filter((m) => m.nativeInterval).map((m) => m.name),
  };
}


export function formatMoney(cents: number, currency: string): string {
  return (cents / 100).toLocaleString(undefined, {
    style: "currency",
    currency: (currency || "usd").toUpperCase(),
  });
}

function intervalSuffix(interval: string): string {
  if (interval === "year") return "/year";
  if (interval === "one_time") return "";
  return "/month";
}

/**
 * The full breakdown, never just a final number:
 * "3 members · £80 + £50 + £50 = £180 · family discount 20% · £144/month"
 */
export function formatFamilyMaths(q: FamilyQuote): string {
  const uncountedNote = q.uncounted.length
    ? ` · not counted yet: ${q.uncounted
        .map((m) => `${m.name} (${familyExclusionLabel(m.status) ?? "not counted"})`)
        .join(", ")}`
    : "";
  if (q.size === 0) {
    return `No family member is being billed yet${uncountedNote} · nothing is charged until the first member starts a paid plan`;
  }
  const parts = q.members.map((m) => formatMoney(m.priceCents, q.currency));
  const sum = `${parts.join(" + ")} = ${formatMoney(q.subtotalCents, q.currency)}`;
  const head = `${q.size} counted member${q.size === 1 ? "" : "s"} · ${sum}`;
  const total = `${formatMoney(q.totalCents, q.currency)}${intervalSuffix(q.interval)}`;
  const notes = q.members
    .filter((m) => m.nativeInterval)
    .map(
      (m) =>
        `${m.name}'s ${intervalWord(m.nativeInterval)} plan ${formatMoney(m.nativePriceCents ?? 0, q.currency)}${intervalSuffix(normInterval(m.nativeInterval))} counts as ${formatMoney(m.priceCents, q.currency)}${intervalSuffix(q.interval)}`,
    );
  const tail = `${notes.length ? ` · ${notes.join(" · ")}` : ""}${uncountedNote}`;
  if (q.discountPercent <= 0) return `${head} · no family discount · ${total}${tail}`;
  return `${head} · family discount ${trimPct(q.discountPercent)}% · ${total}${tail}`;
}

export function trimPct(n: number): string {
  return String(Number(n));
}

/** Plain-English explanation of the two pricing models, for the UI. */
export function pricingModeExplainer(mode: FamilyPricingMode): string {
  return mode === "tiered"
    ? "Tiered discount (recommended): everyone keeps their own plan, and the payer is charged the total of all those plans minus the family discount for the family's size. Works when family members are on different plans."
    : "Flat price: the payer is charged the single price you set on the family plan, no matter which plans the other members would be on.";
}

/**
 * Prominent warning whenever a change would make the payer pay MORE. Because
 * the tiers step steeply, removing or pausing a cheap member can push the
 * family into a smaller discount and increase the bill.
 */
export function familyIncreaseWarning(
  before: FamilyQuote,
  after: FamilyQuote,
): string | null {
  const diff = after.totalCents - before.totalCents;
  if (diff <= 0) return null;
  const money = `from ${formatMoney(before.totalCents, before.currency)} to ${formatMoney(after.totalCents, after.currency)}${intervalSuffix(after.interval)}`;
  const reason =
    after.discountPercent < before.discountPercent
      ? ` because the family drops from the ${trimPct(before.discountPercent)}% tier to the ${trimPct(after.discountPercent)}% tier`
      : "";
  return `This will INCREASE the payer's ${intervalWord(after.interval)} charge ${money} (+${formatMoney(diff, after.currency)})${reason}.`;
}

/** Warning copy when a family shrinks into a cheaper tier. */
export function tierDropWarning(before: FamilyQuote, after: FamilyQuote): string | null {
  const increase = familyIncreaseWarning(before, after);
  if (increase) return increase;
  if (after.discountPercent >= before.discountPercent) return null;
  const diff = after.totalCents - before.totalCents;
  return `This drops the family from a ${trimPct(before.discountPercent)}% to a ${trimPct(after.discountPercent)}% discount, so the remaining members' price changes by ${formatMoney(Math.abs(diff), after.currency)} to ${formatMoney(after.totalCents, after.currency)}${intervalSuffix(after.interval)}.`;
}

