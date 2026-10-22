/**
 * Checkout payment methods.
 *
 * European gyms collect dues by direct debit rather than card — cards expire
 * and fail, which is a major churn driver. Stripe gates each method on
 * currency (and, for BACS, on the connected account's country), so we only
 * ever offer a method that can actually succeed.
 *
 *  - SEPA Direct Debit  → EUR only
 *  - BACS Direct Debit  → GBP only, and the connected account must be GB
 *  - Card               → always available
 */

export type PaymentMethodId = "card" | "sepa_debit" | "bacs_debit";

export const ALL_PAYMENT_METHODS: PaymentMethodId[] = [
  "card",
  "sepa_debit",
  "bacs_debit",
];

export const DIRECT_DEBIT_METHODS: PaymentMethodId[] = ["sepa_debit", "bacs_debit"];

export function isDirectDebitMethod(m: string | null | undefined): boolean {
  return m === "sepa_debit" || m === "bacs_debit" || m === "direct_debit";
}

export const PAYMENT_METHOD_LABELS: Record<PaymentMethodId, string> = {
  card: "Card",
  sepa_debit: "SEPA Direct Debit",
  bacs_debit: "BACS Direct Debit (UK)",
};

/**
 * Human label for a stored `members.payment_method` / `invoices.payment_method`
 * value. Used everywhere the method is displayed so a direct-debit payer never
 * reads as "Card".
 */
export function paymentMethodLabel(m: string | null | undefined): string {
  switch ((m ?? "card").toLowerCase()) {
    case "cash":
      return "Cash / offline";
    case "sepa_debit":
      return "SEPA Direct Debit";
    case "bacs_debit":
      return "BACS Direct Debit";
    case "direct_debit":
      return "Direct debit";
    default:
      return "Card";
  }
}

/** Compact label for dense rows and lists. */
export function paymentMethodShortLabel(m: string | null | undefined): string {
  switch ((m ?? "card").toLowerCase()) {
    case "cash":
      return "cash";
    case "sepa_debit":
      return "SEPA";
    case "bacs_debit":
      return "BACS";
    case "direct_debit":
      return "direct debit";
    default:
      return "card";
  }
}


/** Plain-English lead time, used in member-facing copy. */
export const PAYMENT_METHOD_LEAD_TIME: Record<PaymentMethodId, string | null> = {
  card: null,
  sepa_debit: "SEPA mandates take a few working days to confirm.",
  bacs_debit: "The first BACS collection takes about three working days.",
};

/** Rough working days until a direct debit first collection clears. */
export function directDebitLeadDays(m: string | null | undefined): number {
  if (m === "bacs_debit") return 3;
  if (m === "sepa_debit") return 5;
  return 0;
}

/**
 * SEPA countries — a payer with a bank account here can give a SEPA mandate.
 * (Euro area plus the non-euro SEPA members and micro-states.)
 */
export const SEPA_COUNTRIES = new Set([
  "AT", "BE", "BG", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR",
  "GB", "GI", "GR", "HR", "HU", "IE", "IS", "IT", "LI", "LT", "LU", "LV",
  "MC", "MT", "NL", "NO", "PL", "PT", "RO", "SE", "SI", "SK", "SM", "VA",
  "AD",
]);

/**
 * Which methods are technically possible for this charge.
 *
 *  - SEPA: the charge must be in EUR, and (when known) the payer must bank in
 *    the SEPA area.
 *  - BACS: the charge must be in GBP, the connected account must be GB, and
 *    (when known) the PAYER must be in the UK — a Cyprus member has no sort
 *    code, so offering BACS to them can only fail.
 *  - Card: always possible.
 */
export function eligiblePaymentMethods(args: {
  currency?: string | null;
  accountCountry?: string | null;
  /** Billing country of the person paying, when known. */
  payerCountry?: string | null;
}): PaymentMethodId[] {
  const currency = (args.currency ?? "").toLowerCase();
  const country = (args.accountCountry ?? "").toUpperCase();
  const payer = (args.payerCountry ?? "").toUpperCase();
  const out: PaymentMethodId[] = ["card"];
  if (currency === "eur" && (!payer || SEPA_COUNTRIES.has(payer))) out.push("sepa_debit");
  if (currency === "gbp" && country === "GB" && (!payer || payer === "GB")) {
    out.push("bacs_debit");
  }
  return out;
}

/**
 * Sensible default selection for a gym that has never touched the setting:
 * everything their currency and country allow.
 */
export function defaultPaymentMethods(args: {
  currency?: string | null;
  accountCountry?: string | null;
  payerCountry?: string | null;
}): PaymentMethodId[] {
  return eligiblePaymentMethods(args);
}

/**
 * The final `payment_method_types` for a Checkout Session: everything valid
 * for THIS charge, minus anything the gym has explicitly switched off.
 *
 * The gym's saved list can only ever contain methods that were eligible under
 * the gym's own settings currency (`settingsCurrency`). So a method that was
 * never offerable there — e.g. SEPA for a GBP-configured gym charging a EUR
 * plan — must NOT be treated as "switched off": it was never on the toggle
 * list to begin with. Without this, EUR checkouts silently fell back to card
 * only.
 */
export function resolveCheckoutPaymentMethods(args: {
  currency?: string | null;
  accountCountry?: string | null;
  payerCountry?: string | null;
  enabled?: string[] | null;
  /** The gym's configured default currency, which the saved list reflects. */
  settingsCurrency?: string | null;
  /** One-time charges cannot use BACS/SEPA mandates in the same way. */
  oneTime?: boolean;
}): PaymentMethodId[] {
  const eligible = eligiblePaymentMethods(args);
  const saved = args.enabled?.length
    ? (args.enabled.filter((m) =>
        ALL_PAYMENT_METHODS.includes(m as PaymentMethodId),
      ) as PaymentMethodId[])
    : null;
  if (!saved) return eligible;

  // Methods the saved list could have expressed an opinion about.
  const settingsEligible = new Set(
    eligiblePaymentMethods({
      currency: args.settingsCurrency ?? args.currency,
      accountCountry: args.accountCountry,
    }),
  );

  const list = eligible.filter(
    (m) => m === "card" || !settingsEligible.has(m) || saved.includes(m),
  );
  return list.length ? list : ["card"];
}


/* -------------------------------------------------------------------------
 * Currency constraints
 * ---------------------------------------------------------------------- */

/** Currency a connected account settles in natively, by country. */
const COUNTRY_CURRENCY: Record<string, string> = {
  GB: "gbp",
  US: "usd",
  CA: "cad",
  AU: "aud",
  NZ: "nzd",
  CH: "chf",
  DK: "dkk",
  NO: "nok",
  SE: "sek",
  PL: "pln",
  CZ: "czk",
  HU: "huf",
  RO: "ron",
  BG: "bgn",
  BR: "brl",
  SG: "sgd",
  JP: "jpy",
  AE: "aed",
  IN: "inr",
};

const EURO_COUNTRIES = new Set([
  "IE", "FR", "DE", "ES", "IT", "NL", "BE", "AT", "PT", "FI", "GR", "LU",
  "MT", "CY", "SK", "SI", "EE", "LV", "LT", "HR",
]);

/** The currency a gym in this country should normally price in. */
export function nativeCurrencyForCountry(country?: string | null): string | null {
  const c = (country ?? "").toUpperCase();
  if (!c) return null;
  if (EURO_COUNTRIES.has(c)) return "eur";
  return COUNTRY_CURRENCY[c] ?? null;
}

/**
 * Currencies a plan may be priced in. We lead with the gym's native
 * settlement currency, and always allow EUR so a gym whose members are in
 * the euro area (e.g. a GB-registered account serving Cyprus members) can
 * price in their members' currency and unlock SEPA Direct Debit. Anything
 * else stays hidden — mismatched currencies cost payout conversion.
 */
export function allowedPlanCurrencies(args: {
  accountCountry?: string | null;
  defaultCurrency?: string | null;
}): string[] {
  const native = nativeCurrencyForCountry(args.accountCountry);
  if (native) return Array.from(new Set([native, "eur"]));
  const fallback = (args.defaultCurrency ?? "").toLowerCase();
  const base = ["usd", "eur", "gbp", "cad", "aud", "brl"];
  return fallback && !base.includes(fallback) ? [fallback, ...base] : base;
}



/* -------------------------------------------------------------------------
 * First direct-debit collection
 *
 * A SEPA/BACS mandate is authorised at checkout, but the first collection
 * only clears a few working days later. Until then the member's
 * `payment_status` is still 'pending'/'none' while the Stripe subscription is
 * already active. That is NOT an unpaid member: they have done everything
 * required and must never be asked to "pay now" again.
 * ---------------------------------------------------------------------- */

/** Payment statuses that mean "no successful collection recorded yet". */
const UNSETTLED_STATUSES = new Set(["pending", "none", "due", null as any, undefined as any]);

export function isAwaitingFirstDirectDebit(args: {
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  /** Stripe subscription status, when known. */
  subscriptionStatus?: string | null;
  /** True once any invoice has actually been paid. */
  hasPaidInvoice?: boolean | null;
}): boolean {
  if (!isDirectDebitMethod(args.paymentMethod)) return false;
  if (args.hasPaidInvoice) return false;
  const sub = (args.subscriptionStatus ?? "").toLowerCase();
  // A failed/overdue collection is the dunning path, not setup.
  if (sub && !["active", "trialing", "incomplete"].includes(sub)) return false;
  const status = (args.paymentStatus ?? "none").toLowerCase();
  if (status === "overdue" || status === "disputed" || status === "current") return false;
  return UNSETTLED_STATUSES.has(status);
}

/** Rough expected date of the first collection, in working days. */
export function expectedFirstCollectionDate(
  from: string | Date | null | undefined,
  method: string | null | undefined,
): Date | null {
  if (!from) return null;
  const start = typeof from === "string" ? new Date(from) : from;
  if (Number.isNaN(start.getTime())) return null;
  let remaining = directDebitLeadDays(method);
  if (!remaining) return null;
  const d = new Date(start);
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return d;
}

/** One status a member can understand, replacing "pending" next to "active". */
export const DIRECT_DEBIT_PENDING_LABEL = "Direct debit being set up";

/** Compact staff label so nobody chases a member who has done everything. */
export const DIRECT_DEBIT_PENDING_SHORT = "Direct debit pending";

/** Calm member-facing explanation while the first collection clears. */
export function directDebitPendingMessage(args: {
  method?: string | null;
  expected?: Date | null;
}): string {
  const name = args.method === "bacs_debit" ? "Direct Debit" : "SEPA Direct Debit";
  const when = args.expected
    ? ` The first collection is expected around ${args.expected.toLocaleDateString()}.`
    : "";
  return `Your ${name} is set up.${when} It takes a few working days to clear — there's nothing further for you to do.`;
}
