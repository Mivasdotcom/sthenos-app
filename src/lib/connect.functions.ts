import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  getConnectErrorMessage,
  getOrigin,
  getPlatformStripe,
  hasStripeSecret,
} from "@/lib/stripe-connect.server";
import {
  countryCurrencyMessage,
  isSupportedConnectCountry,
  isSupportedCountryCurrency,
  normalizeConnectCountry,
  CONNECT_COUNTRY_CODES,
} from "@/lib/connect-countries";

const STAFF_ROLES = new Set(["owner", "manager", "admin"]);

async function assertDojoOwnerOrAdmin(supabase: any, userId: string, dojoId: string) {
  const { data } = await supabase
    .from("dojo_memberships")
    .select("role")
    .eq("user_id", userId)
    .eq("dojo_id", dojoId)
    .maybeSingle();
  if (!data || !STAFF_ROLES.has(data.role)) throw new Error("Not allowed");
}

/**
 * Create (or reuse) an Express connected account for this dojo and return
 * a one-time onboarding URL. Idempotent — reuses `dojos.stripe_account_id`.
 */
export const startConnectOnboarding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; returnPath?: string }) =>
    z.object({ dojoId: z.string().uuid(), returnPath: z.string().optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    if (!hasStripeSecret()) {
      console.error("[connect] STRIPE_SECRET_KEY missing");
      return { url: null as string | null, error: "Stripe not configured" };
    }
    await assertDojoOwnerOrAdmin(context.supabase, context.userId, data.dojoId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: dojo, error } = await supabaseAdmin
      .from("dojos")
      .select("id, name, contact_email, default_currency, country, stripe_account_id")
      .eq("id", data.dojoId)
      .single();
    if (error || !dojo) {
      console.error("[connect] load dojo failed", error);
      return { url: null, error: error?.message ?? "Dojo not found" };
    }
    const dojoRow = dojo;

    const stripe = getPlatformStripe();


    async function createFreshAccount(): Promise<string> {
      // Stripe fixes country at creation — validate the dojo's country against
      // the platform's supported list before creating the account.
      const rawCountry = dojoRow.country ?? null;
      if (!isSupportedConnectCountry(rawCountry)) {
        throw new Error(
          `Country ${rawCountry ?? "(unset)"} is not supported for payouts. Update your gym's country in settings.`,
        );
      }
      const country = normalizeConnectCountry(rawCountry);
      // Stripe rejects unsupported country/currency pairings with an opaque
      // error — check first so the owner gets an actionable message.
      if (!isSupportedCountryCurrency(country, dojoRow.default_currency)) {
        throw new Error(countryCurrencyMessage(country, dojoRow.default_currency));
      }
      const acct = await stripe.accounts.create({
        type: "express",
        country,
        email: dojoRow.contact_email ?? undefined,
        default_currency: dojoRow.default_currency ?? undefined,
        business_profile: { name: dojoRow.name },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
          // Direct debit: with destination charges + on_behalf_of the
          // connected account is the settlement merchant, so it needs these
          // capabilities or Checkout rejects sepa_debit / bacs_debit.
          sepa_debit_payments: { requested: true },
          ...(country === "GB" ? { bacs_debit_payments: { requested: true } } : {}),
        },

        metadata: { dojo_id: dojoRow.id },
      });

      await supabaseAdmin
        .from("dojos")
        .update({
          stripe_account_id: acct.id,
          stripe_account_country: acct.country ?? null,
          stripe_charges_enabled: false,
          stripe_details_submitted: false,
        })
        .eq("id", dojoRow.id);
      return acct.id;
    }

    try {
      let acctId = (dojoRow.stripe_account_id as string | null) ?? null;

      // If an account id is stored, verify it exists in the current Stripe
      // mode. If not (e.g. created in live mode with a test-mode key), clear
      // it and create a fresh one before continuing to the account link.
      if (acctId) {
        try {
          await stripe.accounts.retrieve(acctId);
        } catch (e: any) {
          const code = e?.code ?? e?.raw?.code;
          const msg = e?.message ?? e?.raw?.message ?? "";
          const missing =
            code === "account_invalid" ||
            code === "resource_missing" ||
            /no such account/i.test(msg);
          if (!missing) throw e;
          console.warn(
            "[connect] stale stripe_account_id, recreating",
            { dojoId: dojoRow.id, acctId, code, msg },
          );
          acctId = null;
        }
      }

      if (!acctId) acctId = await createFreshAccount();
      else {
        // Existing accounts were created before direct debit was requested —
        // ask for the capabilities now so SEPA/BACS become usable.
        try {
          const acct = await stripe.accounts.retrieve(acctId);
          const caps = (acct as any).capabilities ?? {};
          const want: Record<string, { requested: boolean }> = {};
          if (!caps.sepa_debit_payments) want.sepa_debit_payments = { requested: true };
          if (acct.country === "GB" && !caps.bacs_debit_payments) {
            want.bacs_debit_payments = { requested: true };
          }
          if (Object.keys(want).length) {
            await stripe.accounts.update(acctId, { capabilities: want as any });
          }
        } catch (e) {
          console.warn("[connect] could not request direct-debit capabilities", e);
        }
      }



      const origin = getOrigin();
      const returnPath = data.returnPath ?? "/settings/payments";
      const link = await stripe.accountLinks.create({
        account: acctId,
        type: "account_onboarding",
        return_url: `${origin}${returnPath}?connect=return`,
        refresh_url: `${origin}${returnPath}?connect=refresh`,
      });
      if (!link?.url) {
        console.error("[connect] accountLinks.create returned no url", link);
        return { url: null, error: "Stripe did not return an onboarding URL" };
      }
      return { url: link.url, error: null as string | null };
    } catch (e) {
      console.error("[connect] startConnectOnboarding failed", e);
      return { url: null, error: getConnectErrorMessage(e) };
    }
  });


/**
 * Refresh Stripe account status (`charges_enabled`, `details_submitted`)
 * and mirror to the dojos row.
 */
export const refreshConnectStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) =>
    z.object({ dojoId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    if (!hasStripeSecret()) return { error: "Stripe not configured" as string };
    await assertDojoOwnerOrAdmin(context.supabase, context.userId, data.dojoId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: dojo } = await supabaseAdmin
      .from("dojos")
      .select("stripe_account_id")
      .eq("id", data.dojoId)
      .single();
    if (!dojo?.stripe_account_id) return { error: "No connected account" };

    const stripe = getPlatformStripe();
    try {
      const acct = await stripe.accounts.retrieve(dojo.stripe_account_id);
      const liveCurrency = (acct.default_currency ?? null) as string | null;
      await supabaseAdmin
        .from("dojos")
        .update({
          stripe_charges_enabled: !!acct.charges_enabled,
          stripe_details_submitted: !!acct.details_submitted,
          stripe_account_country: acct.country ?? null,
          ...(liveCurrency ? { default_currency: liveCurrency } : {}),
        })
        .eq("id", data.dojoId);
      return {
        chargesEnabled: !!acct.charges_enabled,
        detailsSubmitted: !!acct.details_submitted,
        defaultCurrency: liveCurrency,
        error: null as string | null,
      };
    } catch (e) {
      return { error: getConnectErrorMessage(e), chargesEnabled: false, detailsSubmitted: false };
    }
  });

/** Log in to the connected account's Express dashboard. */
export const createExpressLoginLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) =>
    z.object({ dojoId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    if (!hasStripeSecret()) return { url: null as string | null, error: "Stripe not configured" };
    await assertDojoOwnerOrAdmin(context.supabase, context.userId, data.dojoId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: dojo } = await supabaseAdmin
      .from("dojos")
      .select("stripe_account_id")
      .eq("id", data.dojoId)
      .single();
    if (!dojo?.stripe_account_id) return { url: null, error: "No connected account" };
    try {
      const link = await getPlatformStripe().accounts.createLoginLink(dojo.stripe_account_id);
      return { url: link.url, error: null as string | null };
    } catch (e) {
      return { url: null, error: getConnectErrorMessage(e) };
    }
  });

/**
 * Staff-only read of the dojo's Stripe/billing columns.
 * Regular dojo members no longer have column-level SELECT on these fields,
 * so they are served here behind an owner/admin check.
 */
export const getDojoStripeStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) =>
    z.object({ dojoId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertDojoOwnerOrAdmin(context.supabase, context.userId, data.dojoId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: dojo, error } = await supabaseAdmin
      .from("dojos")
      .select(
        "id, stripe_account_id, stripe_charges_enabled, stripe_details_submitted, stripe_account_country, country, default_currency, pass_platform_fee_to_members, billing_day_of_month, billing_mode, timezone",
      )
      .eq("id", data.dojoId)
      .maybeSingle();
    if (error) throw new Error("Could not load payment status");
    return dojo ?? null;
  });

/**
 * Staff-only update of the gym's monthly billing day and timezone.
 *
 * The day is clamped to 1-28 so the anchor is valid in February, and it is
 * applied in the gym's own timezone. Existing subscriptions keep their current
 * cycle — this only affects new signups.
 */
export const updateBillingSchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      dojoId: string;
      billingDayOfMonth: number;
      timezone: string;
      billingMode?: "fixed_day" | "anniversary";
    }) =>
      z
        .object({
          dojoId: z.string().uuid(),
          billingDayOfMonth: z.number().int().min(1).max(28),
          timezone: z.string().min(1).max(64),
          billingMode: z.enum(["fixed_day", "anniversary"]).optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertDojoOwnerOrAdmin(context.supabase, context.userId, data.dojoId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("dojos")
      .update({
        billing_day_of_month: data.billingDayOfMonth,
        timezone: data.timezone,
        ...(data.billingMode ? { billing_mode: data.billingMode } : {}),
      })
      .eq("id", data.dojoId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });


/**
 * Correct the gym's country and default currency.
 *
 * Only possible while no Stripe account exists: Stripe fixes a connected
 * account's country at creation, so allowing an edit afterwards would let our
 * records disagree with Stripe.
 */
export const updateDojoLocale = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; country: string; defaultCurrency: string }) =>
    z
      .object({
        dojoId: z.string().uuid(),
        country: z.string().length(2),
        defaultCurrency: z.string().min(3).max(4),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertDojoOwnerOrAdmin(context.supabase, context.userId, data.dojoId);

    const country = data.country.toUpperCase();
    const currency = data.defaultCurrency.toLowerCase();
    if (!CONNECT_COUNTRY_CODES.includes(country)) {
      throw new Error("That country isn't supported for payouts yet.");
    }
    if (!isSupportedCountryCurrency(country, currency)) {
      throw new Error(countryCurrencyMessage(country, currency));
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: dojo, error: readErr } = await supabaseAdmin
      .from("dojos")
      .select("id, stripe_account_id")
      .eq("id", data.dojoId)
      .maybeSingle();
    if (readErr || !dojo) throw new Error("Could not load your gym.");
    if (dojo.stripe_account_id) {
      throw new Error(
        "Your Stripe account is already connected, so the country and currency are locked. Stripe doesn't allow a connected account's country to change — a new Stripe connection would be required.",
      );
    }

    const { error } = await supabaseAdmin
      .from("dojos")
      .update({ country, default_currency: currency })
      .eq("id", data.dojoId);
    if (error) throw new Error(error.message);
    return { ok: true as const, country, defaultCurrency: currency };
  });
