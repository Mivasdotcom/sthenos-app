import type Stripe from "stripe";

/**
 * Resolve the payment method a member ACTUALLY used.
 *
 * `session.payment_method_types` is the list of methods a Checkout Session
 * OFFERED, so reading index 0 always yields "card" for a session that offered
 * ["card", "sepa_debit"] — every SEPA/BACS payer was silently recorded as a
 * card payer, which bypassed all direct-debit handling.
 *
 * The truth lives on real objects:
 *   - a subscription's `default_payment_method` type
 *   - a charge's `payment_method_details.type`
 *   - the PaymentIntent / SetupIntent the session created
 *
 * We never infer from the offered list.
 */

export type UsedMethod = "card" | "sepa_debit" | "bacs_debit" | string;

function typeOfPaymentMethod(pm: any): string | null {
  if (!pm) return null;
  if (typeof pm === "object" && typeof pm.type === "string") return pm.type;
  return null;
}

async function retrievePaymentMethodType(
  stripe: Stripe,
  pm: unknown,
): Promise<string | null> {
  const inline = typeOfPaymentMethod(pm);
  if (inline) return inline;
  if (typeof pm === "string" && pm.startsWith("pm_")) {
    try {
      const full = await stripe.paymentMethods.retrieve(pm);
      return (full as any)?.type ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Method backing a subscription, read from its default payment method. */
export async function methodFromSubscription(
  stripe: Stripe,
  sub: any,
): Promise<string | null> {
  if (!sub) return null;
  const direct = await retrievePaymentMethodType(stripe, sub.default_payment_method);
  if (direct) return direct;
  // Fall back to the customer's invoice default.
  const cust = sub.customer;
  const custId = typeof cust === "string" ? cust : cust?.id;
  if (custId) {
    try {
      const full: any = await stripe.customers.retrieve(custId);
      const pm = full?.invoice_settings?.default_payment_method;
      const t = await retrievePaymentMethodType(stripe, pm);
      if (t) return t;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Method that settled an invoice, read from its charge / payment intent. */
export async function methodFromInvoice(
  stripe: Stripe,
  invoice: any,
): Promise<string | null> {
  if (!invoice) return null;
  const inlineCharge = invoice.charge;
  const chargeId = typeof inlineCharge === "string" ? inlineCharge : inlineCharge?.id;
  if (chargeId) {
    try {
      const charge: any = await stripe.charges.retrieve(chargeId);
      const t = charge?.payment_method_details?.type;
      if (t) return t;
    } catch {
      /* ignore */
    }
  }
  const piRaw = invoice.payment_intent;
  const piId = typeof piRaw === "string" ? piRaw : piRaw?.id;
  if (piId) {
    try {
      const pi: any = await stripe.paymentIntents.retrieve(piId, {
        expand: ["payment_method", "latest_charge"],
      });
      const t =
        pi?.latest_charge?.payment_method_details?.type ??
        typeOfPaymentMethod(pi?.payment_method);
      if (t) return t;
    } catch {
      /* ignore */
    }
  }
  const t = await retrievePaymentMethodType(stripe, invoice.default_payment_method);
  return t ?? null;
}

/**
 * Method a completed Checkout Session actually used. Follows the SetupIntent
 * (subscription mandates) or PaymentIntent (one-off charges), then the created
 * subscription. Returns null rather than guessing.
 */
export async function methodFromCheckoutSession(
  stripe: Stripe,
  session: any,
): Promise<string | null> {
  const siRaw = session?.setup_intent;
  const siId = typeof siRaw === "string" ? siRaw : siRaw?.id;
  if (siId) {
    try {
      const si: any = await stripe.setupIntents.retrieve(siId, {
        expand: ["payment_method"],
      });
      const t = typeOfPaymentMethod(si?.payment_method);
      if (t) return t;
    } catch {
      /* ignore */
    }
  }

  const piRaw = session?.payment_intent;
  const piId = typeof piRaw === "string" ? piRaw : piRaw?.id;
  if (piId) {
    try {
      const pi: any = await stripe.paymentIntents.retrieve(piId, {
        expand: ["payment_method", "latest_charge"],
      });
      const t =
        pi?.latest_charge?.payment_method_details?.type ??
        typeOfPaymentMethod(pi?.payment_method);
      if (t) return t;
    } catch {
      /* ignore */
    }
  }

  const subRaw = session?.subscription;
  const subId = typeof subRaw === "string" ? subRaw : subRaw?.id;
  if (subId) {
    try {
      const sub: any = await stripe.subscriptions.retrieve(subId, {
        expand: ["default_payment_method", "latest_invoice.payment_intent"],
      });
      const t = await methodFromSubscription(stripe, sub);
      if (t) return t;
      const inv = sub?.latest_invoice;
      if (inv) {
        const it = await methodFromInvoice(stripe, inv);
        if (it) return it;
      }
    } catch {
      /* ignore */
    }
  }

  return null;
}
