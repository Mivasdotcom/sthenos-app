import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  ALL_PAYMENT_METHODS,
  defaultPaymentMethods,
  eligiblePaymentMethods,
  type PaymentMethodId,
} from "@/lib/payment-methods";

const STAFF_ROLES = ["owner", "admin"];

async function assertStaff(supabase: any, dojoId: string, userId: string) {
  const { data } = await supabase
    .from("dojo_memberships")
    .select("role")
    .eq("dojo_id", dojoId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data || !STAFF_ROLES.includes(data.role)) throw new Error("Not authorised");
}

export type DojoPaymentMethodSettings = {
  currency: string;
  accountCountry: string | null;
  eligible: PaymentMethodId[];
  enabled: PaymentMethodId[];
  /** True when the gym has never explicitly chosen — we're showing defaults. */
  usingDefaults: boolean;
};

export const getDojoPaymentMethods = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }): Promise<DojoPaymentMethodSettings> => {
    const { supabase, userId } = context as any;
    await assertStaff(supabase, data.dojoId, userId);
    const { data: dojo, error } = await supabase
      .from("dojos")
      .select("default_currency, stripe_account_country, country, payment_methods")
      .eq("id", data.dojoId)
      .single();
    if (error) throw error;
    const currency = (dojo.default_currency ?? "usd").toLowerCase();
    const accountCountry = dojo.stripe_account_country ?? dojo.country ?? null;
    const eligible = eligiblePaymentMethods({ currency, accountCountry });
    const stored = (dojo.payment_methods ?? null) as string[] | null;
    return {
      currency,
      accountCountry,
      eligible,
      enabled: stored?.length
        ? (stored.filter((m) => ALL_PAYMENT_METHODS.includes(m as PaymentMethodId)) as PaymentMethodId[])
        : defaultPaymentMethods({ currency, accountCountry }),
      usingDefaults: !stored?.length,
    };
  });

export const setDojoPaymentMethods = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; methods: string[] }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertStaff(supabase, data.dojoId, userId);
    const methods = Array.from(
      new Set(["card", ...data.methods.filter((m) => ALL_PAYMENT_METHODS.includes(m as PaymentMethodId))]),
    );
    const { error } = await supabase
      .from("dojos")
      .update({ payment_methods: methods })
      .eq("id", data.dojoId);
    if (error) throw error;
    return { ok: true, methods };
  });

export type CurrencyHealth = {
  defaultCurrency: string;
  accountCountry: string | null;
  /** Currencies the gym's active plans are priced in. */
  planCurrencies: string[];
  mismatchedPlans: { id: string; name: string; currency: string }[];
  /** Live subscriptions whose currency no longer matches the gym default. */
  legacySubscriptions: {
    memberId: string;
    memberName: string;
    currency: string;
    status: string;
  }[];
};

/**
 * Currency drift for a gym: plans priced off the gym default, more than one
 * plan currency, and live Stripe subscriptions still billed in an old
 * currency (Stripe cannot change a subscription's currency in place).
 */
export const getCurrencyHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }): Promise<CurrencyHealth> => {
    const { supabase, userId } = context as any;
    await assertStaff(supabase, data.dojoId, userId);

    const [{ data: dojo }, { data: plans }, { data: subs }] = await Promise.all([
      supabase
        .from("dojos")
        .select("default_currency, stripe_account_country, country")
        .eq("id", data.dojoId)
        .single(),
      supabase
        .from("dojo_plans")
        .select("id, name, currency")
        .eq("dojo_id", data.dojoId)
        .eq("is_active", true),
      supabase
        .from("member_subscriptions")
        .select("status, currency, member_id, members:member_id(name)")
        .eq("dojo_id", data.dojoId)
        .in("status", ["active", "trialing", "past_due", "unpaid", "incomplete"]),
    ]);

    const defaultCurrency = (dojo?.default_currency ?? "usd").toLowerCase();
    const planRows = (plans ?? []) as { id: string; name: string; currency: string }[];
    return {
      defaultCurrency,
      accountCountry: dojo?.stripe_account_country ?? dojo?.country ?? null,
      planCurrencies: Array.from(
        new Set(planRows.map((p) => (p.currency ?? "").toLowerCase())),
      ).filter(Boolean),
      mismatchedPlans: planRows
        .filter((p) => (p.currency ?? "").toLowerCase() !== defaultCurrency)
        .map((p) => ({ id: p.id, name: p.name, currency: (p.currency ?? "").toLowerCase() })),
      legacySubscriptions: ((subs ?? []) as any[])
        .filter((s) => s.currency && s.currency.toLowerCase() !== defaultCurrency)
        .map((s) => ({
          memberId: s.member_id,
          memberName: s.members?.name ?? "Member",
          currency: String(s.currency).toLowerCase(),
          status: s.status,
        })),
    };
  });
