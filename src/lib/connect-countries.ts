import { nativeCurrencyForCountry } from "@/lib/payment-methods";
/**
 * Curated list of countries supported for Stripe Connect (Express) accounts.
 * ISO 3166-1 alpha-2 codes. Used by gym onboarding and validated server-side
 * before a connected account is created.
 */
export const CONNECT_COUNTRIES: { code: string; label: string }[] = [
  { code: "GB", label: "United Kingdom" },
  { code: "US", label: "United States" },
  { code: "IE", label: "Ireland" },
  { code: "FR", label: "France" },
  { code: "DE", label: "Germany" },
  { code: "ES", label: "Spain" },
  { code: "IT", label: "Italy" },
  { code: "NL", label: "Netherlands" },
  { code: "BE", label: "Belgium" },
  { code: "AT", label: "Austria" },
  { code: "PT", label: "Portugal" },
  { code: "FI", label: "Finland" },
  { code: "GR", label: "Greece" },
  { code: "LU", label: "Luxembourg" },
  { code: "MT", label: "Malta" },
  { code: "CY", label: "Cyprus" },
  { code: "SK", label: "Slovakia" },
  { code: "SI", label: "Slovenia" },
  { code: "EE", label: "Estonia" },
  { code: "LV", label: "Latvia" },
  { code: "LT", label: "Lithuania" },
  { code: "PL", label: "Poland" },
  { code: "CZ", label: "Czechia" },
  { code: "DK", label: "Denmark" },
  { code: "SE", label: "Sweden" },
  { code: "NO", label: "Norway" },
  { code: "CH", label: "Switzerland" },
  { code: "CA", label: "Canada" },
  { code: "AU", label: "Australia" },
  { code: "NZ", label: "New Zealand" },
  { code: "SG", label: "Singapore" },
  { code: "JP", label: "Japan" },
  { code: "AE", label: "United Arab Emirates" },
  { code: "BR", label: "Brazil" },
];

export const CONNECT_COUNTRY_CODES = CONNECT_COUNTRIES.map((c) => c.code);

export const DEFAULT_CONNECT_COUNTRY = "GB";

export function isSupportedConnectCountry(code: string | null | undefined): boolean {
  if (!code) return false;
  return CONNECT_COUNTRY_CODES.includes(code.toUpperCase());
}

/** Normalise to a supported code, falling back to the platform default. */
export function normalizeConnectCountry(code: string | null | undefined): string {
  const upper = (code ?? "").toUpperCase();
  return CONNECT_COUNTRY_CODES.includes(upper) ? upper : DEFAULT_CONNECT_COUNTRY;
}

export function countryLabel(code: string): string {
  return CONNECT_COUNTRIES.find((c) => c.code === code.toUpperCase())?.label ?? code.toUpperCase();
}

/* -------------------------------------------------------------------------
 * Country ↔ currency pairing
 *
 * Stripe fixes a connected account's country at creation and only accepts a
 * default currency the country actually supports ("Stripe currently doesn't
 * support currency aed with country GB"). We validate the pairing ourselves
 * so the gym owner gets an actionable message instead of a raw Stripe error.
 * ---------------------------------------------------------------------- */

/**
 * Currencies a connected account in this country may settle in: its native
 * currency, plus EUR so a non-euro European gym can bill euro-area members
 * (and unlock SEPA Direct Debit).
 */
export function allowedAccountCurrencies(country: string | null | undefined): string[] {
  const native = nativeCurrencyForCountry(country);
  if (!native) return [];
  return Array.from(new Set([native, "eur"]));
}

export function isSupportedCountryCurrency(
  country: string | null | undefined,
  currency: string | null | undefined,
): boolean {
  const allowed = allowedAccountCurrencies(country);
  const cur = (currency ?? "").toLowerCase();
  if (!allowed.length || !cur) return false;
  return allowed.includes(cur);
}

/** Actionable explanation for a country/currency pairing Stripe will reject. */
export function countryCurrencyMessage(
  country: string | null | undefined,
  currency: string | null | undefined,
): string {
  const label = countryLabel(country ?? "");
  const cur = (currency ?? "").toUpperCase() || "(unset)";
  const allowed = allowedAccountCurrencies(country);
  if (!allowed.length) {
    return `Your gym's country (${label}) isn't supported for payouts. Set a supported country in Settings → Payments before connecting Stripe.`;
  }
  const wants = allowed.map((c) => c.toUpperCase()).join(" or ");
  return `Stripe doesn't support ${cur} for a ${label} account. A ${label} gym must use ${wants}. Change your default currency in Settings → Payments before connecting Stripe.`;
}
