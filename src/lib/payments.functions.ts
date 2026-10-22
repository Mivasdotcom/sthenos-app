import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  PLATFORM_FEE_PERCENT,
  billingModeFromDojo,
  subscriptionAppFeePercent,
  totalAppFeeCents,
  getConnectErrorMessage,
  getOrigin,
  getPlatformStripe,
  hasStripeSecret,
  planSubscriptionBilling,
} from "@/lib/stripe-connect.server";

const STAFF_ROLES = new Set(["owner", "manager", "admin"]);

/**
 * Ensure a Stripe Product+Price exists for this dojo_plan and cache the price
 * id on the row.
 *
 * IMPORTANT: we use DESTINATION CHARGES, so products, prices and customers
 * live on the PLATFORM account — the funds are routed to the gym's connected
 * account via `transfer_data.destination` at Checkout time. Do NOT pass a
 * `stripeAccount` option here: creating these objects on the connected
 * account makes them unusable by platform-created Checkout Sessions and
 * breaks checkout entirely.
 */
async function ensureConnectedPriceId(args: {
  stripe: ReturnType<typeof getPlatformStripe>;
  supabaseAdmin: any;
  plan: {
    id: string;
    name: string;
    price_cents: number;
    currency: string;
    interval: string;
    stripe_price_id: string | null;
  };
}): Promise<string> {
  const { stripe, supabaseAdmin, plan } = args;
  if (plan.stripe_price_id) return plan.stripe_price_id;

  const product = await stripe.products.create(
    { name: plan.name, metadata: { dojo_plan_id: plan.id } },
  );
  const isOneTime = plan.interval === "one_time";
  const price = await stripe.prices.create(
    {
      product: product.id,
      unit_amount: plan.price_cents,
      currency: (plan.currency ?? "usd").toLowerCase(),
      lookup_key: `plan_${plan.id}`,
      metadata: { dojo_plan_id: plan.id },
      ...(isOneTime
        ? {}
        : { recurring: { interval: plan.interval as "month" | "year" } }),
    },
  );

  await supabaseAdmin
    .from("dojo_plans")
    .update({ stripe_price_id: price.id })
    .eq("id", plan.id);

  return price.id;
}

/**
 * Ensure a Stripe Customer exists for this member on the PLATFORM account.
 *
 * Same destination-charge rule as above: the customer must NOT be created on
 * the connected account, so no `stripeAccount` option is passed.
 */
async function ensureConnectedCustomer(args: {
  stripe: ReturnType<typeof getPlatformStripe>;
  supabaseAdmin: any;
  member: {
    id: string;
    email: string | null;
    /** The guardian's address, for a child who has none of their own. */
    guardian_email?: string | null;
    name: string;
    stripe_customer_id: string | null;
  };
}): Promise<string> {
  const { stripe, supabaseAdmin, member } = args;
  if (member.stripe_customer_id) return member.stripe_customer_id;
  // A child added by their parent has no address of their own, so billing this
  // to `email` alone created a Stripe customer with none at all: no receipt,
  // no failed-payment notice, nothing reaching the parent actually paying.
  const billingEmail = member.email ?? member.guardian_email ?? undefined;
  const customer = await stripe.customers.create(
    {
      email: billingEmail,
      name: member.name,
      metadata: { member_id: member.id },
    },
  );
  await supabaseAdmin
    .from("members")
    .update({ stripe_customer_id: customer.id })
    .eq("id", member.id);
  return customer.id;
}


const CheckoutInput = z.object({
  memberId: z.string().uuid(),
  dojoId: z.string().uuid(),
  planId: z.string().uuid(),
  returnPath: z.string().optional(),
});

/**
 * PAY-LATER FLOW (admin "Send payment link", or a member paying from the
 * portal). This is the ONLY checkout entry point for members that already
 * exist — admin member creation (AddMemberDialog) never calls Stripe and
 * leaves payment unset, so staff are never blocked by Stripe.
 *
 * Uses the same billing planner as the member self-signup flow, so a member who
 * pays later still lands on the gym's configured billing day.
 */
export const createCheckoutSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => CheckoutInput.parse(input))
  .handler(async ({ data, context }) => {
    if (!hasStripeSecret()) {
      return { url: null as string | null, error: "Stripe not configured" };
    }

    // Load member + authorize.
    //
    // Read with the ADMIN client and authorise explicitly below. On the
    // caller's own client the members policy is `auth.uid() = user_id`, and a
    // child added by their parent has no login at all -- so this came back
    // null, returned "Member not found", and the guardian check beneath could
    // never run. Reading here grants nothing on its own: the function still
    // refuses unless the caller is the member, their guardian, or staff.
    const { supabaseAdmin: adminForLookup } = await import(
      "@/integrations/supabase/client.server"
    );
    const { data: member, error: mErr } = await adminForLookup
      .from("members")
      .select(
        "id, user_id, dojo_id, name, email, guardian_email, stripe_customer_id, guardian_member_id",
      )
      .eq("id", data.memberId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (mErr) throw new Error(mErr.message);
    if (!member) return { url: null, error: "Member not found" };

    let isSelf = !!member.user_id && member.user_id === context.userId;

    // A child has no login of their own, so paying for them can never be
    // "self". Their guardian stands in their place -- matched on records,
    // never on a name or an email.
    //
    // There are two shapes of guardian. An adult member who added their
    // children is named on the child's row. A parent whose login holds no
    // membership of its own, or holds a sibling's -- which is what signing a
    // child up produces -- is recorded as a manager of the child instead.
    // Missing the second meant a parent could not pay for their own child.
    if (!isSelf && (member as any).guardian_member_id) {
      const { data: caller } = await context.supabase
        .from("members")
        .select("id")
        .eq("user_id", context.userId)
        .eq("dojo_id", data.dojoId)
        .maybeSingle();
      if (caller && caller.id === (member as any).guardian_member_id) isSelf = true;
    }
    if (!isSelf) {
      const { data: link } = await adminForLookup
        .from("member_managers")
        .select("id")
        .eq("member_id", data.memberId)
        .eq("user_id", context.userId)
        .eq("dojo_id", data.dojoId)
        .maybeSingle();
      if (link) isSelf = true;
    }

    if (!isSelf) {
      const { data: mem } = await context.supabase
        .from("dojo_memberships")
        .select("role")
        .eq("user_id", context.userId)
        .eq("dojo_id", data.dojoId)
        .maybeSingle();
      if (!mem || !STAFF_ROLES.has(mem.role)) return { url: null, error: "Not allowed" };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: dojo } = await supabaseAdmin
      .from("dojos")
      .select(
        "stripe_account_id, stripe_charges_enabled, slug, pass_platform_fee_to_members, billing_day_of_month, billing_mode, timezone, payment_methods, stripe_account_country, country, default_currency",
      )
      .eq("id", data.dojoId)
      .single();
    if (!dojo?.stripe_account_id || !dojo.stripe_charges_enabled) {
      return { url: null, error: "This gym hasn't finished payment setup yet." };
    }
    const stripeAccount = dojo.stripe_account_id;
    const passFee = !!dojo.pass_platform_fee_to_members;



    const { data: plan, error: pErr } = await supabaseAdmin
      .from("dojo_plans")
      .select("id, name, price_cents, currency, interval, stripe_price_id, plan_type")
      .eq("id", data.planId)
      .eq("dojo_id", data.dojoId)
      .single();
    if (pErr) throw new Error(pErr.message);
    if (!plan) return { url: null, error: "Plan not found" };

    const stripe = getPlatformStripe();

    try {
      const customerId = await ensureConnectedCustomer({
        stripe,
        supabaseAdmin,
        member: member as any,
      });

      const origin = getOrigin();
      const isOneTime = plan.interval === "one_time";
      const returnPath = data.returnPath ?? "/portal";
      const successUrl = `${origin}${returnPath}?payment=success`;
      const cancelUrl = `${origin}${returnPath}?payment=cancelled`;

      // Tiered family pricing: the payer is charged the discounted sum of every
      // family member's own plan price. This is gated on the member being the
      // DESIGNATED PAYER of a family group with 2+ members — never on the
      // plan's plan_type, so a family payer on an ordinary Monthly plan still
      // gets the family discount. Only the designated payer is ever charged.
      let familyQuote: Awaited<
        ReturnType<typeof import("@/lib/family-pricing.server").familyTotalForPayer>
      > = null;
      {
        const { familyBillingRole, familyTotalForPayer } = await import(
          "@/lib/family-pricing.server"
        );
        const role = await familyBillingRole(supabaseAdmin, data.dojoId, data.memberId);
        if (role.inFamily && role.payerId && !role.isPayer) {
          return {
            url: null,
            error:
              "This member is covered by their family plan — only the family's designated payer is charged.",
          };
        }
        if (role.inFamily && (role.isPayer || !role.payerId)) {
          // familyTotalForPayer returns null when the group has fewer than 2
          // members or this member is not the payer.
          // Same reason as the signup checkout: this runs when payment has NOT
          // been set up, so the family is still pending. Treating them as
          // unpaid here would price the retry at zero -- on the very path
          // someone reaches because their first attempt failed.
          familyQuote = await familyTotalForPayer(
            supabaseAdmin,
            data.dojoId,
            data.memberId,
            { countPending: true },
          );
        }
      }

      // A family that prices to nothing is a bug, not a free membership.
      if (familyQuote && familyQuote.totalCents <= 0) {
        return {
          url: null,
          error:
            "This family plan priced to zero, so no payment was set up. Please contact your gym — nobody has been charged.",
        };
      }

      const originalCents = familyQuote?.totalCents ?? plan.price_cents;
      const grossCents = passFee
        ? originalCents + Math.round((originalCents * PLATFORM_FEE_PERCENT) / 100)
        : originalCents;
      const currency = (familyQuote?.currency ?? plan.currency ?? "usd").toLowerCase();
      const baseName = familyQuote
        ? `${plan.name} — ${familyQuote.size} ${familyQuote.size === 1 ? "member" : "members"} (${familyQuote.discountPercent}% family discount)`
        : plan.name;
      const displayName = passFee
        ? `${baseName} (includes ${PLATFORM_FEE_PERCENT}% platform fee)`
        : baseName;

      // Line items: when passing the fee to members — or when a tiered family
      // total applies — we use inline price_data so we can charge the exact
      // amount without minting a shadow Stripe Price.
      const lineItems =
        passFee || familyQuote
          ? [
              {
                quantity: 1,
                price_data: {
                  currency,
                  unit_amount: grossCents,
                  product_data: { name: displayName, metadata: { dojo_plan_id: plan.id } },
                  ...(isOneTime
                    ? {}
                    : { recurring: { interval: plan.interval as "month" | "year" } }),
                },
              },
            ]
          : [
              {
                price: await ensureConnectedPriceId({
                  stripe,
                  supabaseAdmin,
                  plan,
                }),
                quantity: 1,
              },
            ];


      // Application fee: always keep the platform's net at PLATFORM_FEE_PERCENT%
      // of the ORIGINAL plan price. When pass-through is on, the gym receives
      // the full original price and the member pays the fee on top.
      // Margin PLUS Stripe's cost, so the gym bears card fees rather than the
      // platform paying them out of its own balance.
      const oneTimeAppFee = totalAppFeeCents(originalCents, grossCents);
      // For subscriptions Stripe expects a percent of the invoice total. When
      // passing the fee to members, that percent must be adjusted down so the
      // deducted fee still equals fee%*original.
      const subAppFeePercent = subscriptionAppFeePercent(originalCents, grossCents, passFee);

      // Anchor + proration: monthly plans anchor to the gym's billing day in
      // its own timezone; annual plans charge in full today and renew on the
      // same date next year with no proration line.
      const billing = planSubscriptionBilling({
        interval: plan.interval,
        grossCents,
        currency,
        billingDay: (dojo as any).billing_day_of_month,
        billingMode: billingModeFromDojo(dojo),
        timezone: (dojo as any).timezone ?? "UTC",
      });

      // A member still on their free trial collects a payment method now but
      // is charged only once the trial has run its course. The trial clock
      // starts on their FIRST ATTENDED class, so until they attend the date is
      // provisional and deliberately generous — corrected the moment they
      // check in. Never charge before a trial has actually happened.
      const trialDeferral = isOneTime
        ? null
        : await (async () => {
            const { resolveTrialDeferral } = await import("@/lib/trial-billing.server");
            return resolveTrialDeferral(supabaseAdmin, data.dojoId, data.memberId);
          })();




      // Direct debit follows the PAYER as well as the gym: SEPA wherever the
      // charge is in EUR and the payer banks in the SEPA area, BACS only for
      // GBP on a GB account with a UK payer (a Cyprus member has no sort
      // code). Checkout collects and stores the mandate; the Subscription
      // inherits the same methods via payment_settings below.
      let payerCountry: string | null = null;
      try {
        const cust = await stripe.customers.retrieve(customerId);
        payerCountry = (cust as any)?.address?.country ?? null;
      } catch {
        payerCountry = null;
      }

      const { resolveCheckoutPaymentMethods } = await import("@/lib/payment-methods");
      const paymentMethodTypes = resolveCheckoutPaymentMethods({
        currency,
        accountCountry: (dojo as any).stripe_account_country ?? (dojo as any).country,
        payerCountry,
        enabled: (dojo as any).payment_methods,
        settingsCurrency: (dojo as any).default_currency,
        oneTime: isOneTime,
      });


      const session = await stripe.checkout.sessions.create({
        mode: isOneTime ? "payment" : "subscription",
        customer: customerId,
        line_items: lineItems as any,
        payment_method_types: paymentMethodTypes as any,
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          type: "member_dues",
          memberId: data.memberId,
          dojoId: data.dojoId,
          planId: data.planId,
          pass_platform_fee_to_members: passFee ? "true" : "false",
        },

        ...(isOneTime
          ? {
              payment_intent_data: {
                application_fee_amount: oneTimeAppFee,
                transfer_data: { destination: stripeAccount },
                on_behalf_of: stripeAccount,
                metadata: {
                  type: "member_dues",
                  memberId: data.memberId,
                  dojoId: data.dojoId,
                  planId: data.planId,
                },
              },
            }
          : {
              subscription_data: {
                application_fee_percent: subAppFeePercent,

                // Trial members: defer the first charge to the end of their
                // trial. A trial_end replaces the anchor entirely — after the
                // trial, billing follows that date under the gym's mode.
                ...(trialDeferral
                  ? { trial_end: trialDeferral.unix }
                  : // Annual plans deliberately send neither field. Keep the
                    // guard at the payload boundary so proration can never be
                    // sent without its required anchor.
                    billing.billingCycleAnchor
                    ? {
                        billing_cycle_anchor: billing.billingCycleAnchor,
                        proration_behavior: billing.prorationBehavior,
                      }
                    : {}),
                transfer_data: { destination: stripeAccount },
                on_behalf_of: stripeAccount,
                metadata: {
                  type: "member_dues",
                  memberId: data.memberId,
                  dojoId: data.dojoId,
                  planId: data.planId,
                  ...(trialDeferral
                    ? {
                        trial_end_provisional: trialDeferral.provisional ? "true" : "false",
                        trial_end_date: trialDeferral.date,
                      }
                    : {}),
                },
              },
            }),
      });

      return {
        url: session.url,
        error: null as string | null,
        trialDeferredUntil: trialDeferral?.date ?? null,
        trialProvisional: trialDeferral?.provisional ?? false,
        trialMessage: trialDeferral?.message ?? null,
      };

    } catch (e) {
      return { url: null, error: getConnectErrorMessage(e) };
    }
  });

export const createBillingPortalSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { memberId: string; dojoId: string; returnPath?: string }) => input)
  .handler(async ({ data, context }) => {
    if (!hasStripeSecret()) {
      return { url: null as string | null, error: "Stripe not configured" };
    }

    // Same reason as the checkout above: a child's row is invisible to the
    // parent's own client, so read with the admin client and authorise here.
    const { supabaseAdmin: adminForPortal } = await import(
      "@/integrations/supabase/client.server"
    );
    const { data: member, error } = await adminForPortal
      .from("members")
      .select("id, user_id, dojo_id, stripe_customer_id, guardian_member_id")
      .eq("id", data.memberId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!member) return { url: null, error: "Member not found" };

    let isSelf = !!member.user_id && member.user_id === context.userId;

    // The parent who manages this child may manage their billing too.
    if (!isSelf) {
      const { data: link } = await adminForPortal
        .from("member_managers")
        .select("id")
        .eq("member_id", data.memberId)
        .eq("user_id", context.userId)
        .eq("dojo_id", data.dojoId)
        .maybeSingle();
      if (link) isSelf = true;
    }
    if (!isSelf && (member as any).guardian_member_id) {
      const { data: caller } = await context.supabase
        .from("members")
        .select("id")
        .eq("user_id", context.userId)
        .eq("dojo_id", data.dojoId)
        .maybeSingle();
      if (caller && caller.id === (member as any).guardian_member_id) isSelf = true;
    }

    if (!isSelf) {
      const { data: mem } = await context.supabase
        .from("dojo_memberships")
        .select("role")
        .eq("user_id", context.userId)
        .eq("dojo_id", data.dojoId)
        .maybeSingle();
      if (!mem || !STAFF_ROLES.has(mem.role)) return { url: null, error: "Not allowed" };
    }
    if (!member.stripe_customer_id) {
      return { url: null, error: "No billing account yet — start a checkout first." };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: dojo } = await supabaseAdmin
      .from("dojos")
      .select("stripe_account_id")
      .eq("id", data.dojoId)
      .single();
    if (!dojo?.stripe_account_id) return { url: null, error: "Payments not set up" };

    try {
      const origin = getOrigin();
      const portal = await getPlatformStripe().billingPortal.sessions.create({
        customer: member.stripe_customer_id,
        return_url: `${origin}${data.returnPath ?? "/portal"}`,
      });
      return { url: portal.url, error: null as string | null };
    } catch (e) {
      return { url: null, error: getConnectErrorMessage(e) };
    }
  });
