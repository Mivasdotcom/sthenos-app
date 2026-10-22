import type Stripe from "stripe";
import { duesRequestOptions } from "@/lib/stripe-connect.server";
import { platformFeeCents } from "@/lib/platform-fee";

/**
 * Refund helpers for member dues.
 *
 * Dues are DESTINATION CHARGES on the PLATFORM account
 * (`transfer_data.destination` + `on_behalf_of` + an application fee), so
 * every Stripe call here goes through `duesRequestOptions()` — never with a
 * `stripeAccount` header. Refunds must additionally `reverse_transfer: true`,
 * to pull the gym's share back out of the connected account.
 *
 * WHO PAYS STRIPE ON A REFUND
 *
 * Stripe keeps its processing fee when a payment is refunded: "Stripe's
 * processing fees from the original transaction aren't returned." Someone has
 * to absorb it, and the application fee now covers two different things --
 * the platform's 1% margin AND an estimate of Stripe's cost, which the gym
 * bears (see platform-fee.ts and clause 6.3 of the licence agreement).
 *
 * So the fee is NOT refunded wholesale. `refund_application_fee: true` would
 * hand the gym back both parts, leaving the platform paying the gym's card
 * fees on every refund -- €1.23 on a €65.65 payment. Instead this refunds the
 * application fee separately, for the MARGIN portion only, which Stripe
 * supports: "you can provide a `refund_application_fee` value of false and
 * refund the application fee separately through the API."
 *
 * Net effect of a full refund: the member gets everything back, the platform
 * keeps nothing, and the gym carries Stripe's cost -- exactly as it would
 * refunding a member on its own Stripe account.
 *
 * Charges taken BEFORE the fee split (application fee = the 1% alone) have no
 * Stripe portion to keep, so the whole fee goes back, as it does today.
 */

export type InvoiceChargeRef = {
  chargeId: string | null;
  paymentIntentId: string | null;
  currency: string;
};

/**
 * Resolve the charge behind an invoice. Reads the modern `invoice.payments`
 * shape first and falls back to the legacy top-level `charge` /
 * `payment_intent` fields so this works across API versions.
 */
export async function resolveInvoiceCharge(
  stripe: Stripe,
  stripeInvoiceId: string,
): Promise<InvoiceChargeRef> {
  const inv: any = await stripe.invoices.retrieve(
    stripeInvoiceId,
    { expand: ["payments"] } as any,
    duesRequestOptions(),
  );

  let chargeId: string | null =
    typeof inv.charge === "string" ? inv.charge : (inv.charge?.id ?? null);
  let paymentIntentId: string | null =
    typeof inv.payment_intent === "string"
      ? inv.payment_intent
      : (inv.payment_intent?.id ?? null);

  for (const p of inv.payments?.data ?? []) {
    const pay: any = p?.payment ?? {};
    if (!paymentIntentId) {
      paymentIntentId =
        typeof pay.payment_intent === "string"
          ? pay.payment_intent
          : (pay.payment_intent?.id ?? null);
    }
    if (!chargeId) {
      chargeId = typeof pay.charge === "string" ? pay.charge : (pay.charge?.id ?? null);
    }
  }

  if (!chargeId && paymentIntentId) {
    const pi: any = await stripe.paymentIntents.retrieve(
      paymentIntentId,
      undefined,
      duesRequestOptions(),
    );
    chargeId =
      typeof pi.latest_charge === "string" ? pi.latest_charge : (pi.latest_charge?.id ?? null);
  }

  return {
    chargeId,
    paymentIntentId,
    currency: (inv.currency ?? "usd").toLowerCase(),
  };
}

export type RefundQuote = {
  chargeId: string;
  paymentIntentId: string | null;
  currency: string;
  /** Original captured amount on the charge. */
  chargeAmountCents: number;
  /** Already refunded on the charge, straight from Stripe. */
  alreadyRefundedCents: number;
  /** The hard ceiling for any new refund. */
  remainingRefundableCents: number;
  /** Amount this refund would return to the member. */
  refundAmountCents: number;
  /** Portion clawed back from the gym's connected account. */
  gymGivesBackCents: number;
  /** The platform's 1% margin, credited back to the gym proportionally. */
  platformFeeReversedCents: number;
  /**
   * The Stripe-cost portion of the application fee, which the platform keeps
   * because Stripe keeps its processing fee on a refund. The gym bears it.
   */
  stripeCostBorneByGymCents: number;
  /** The application fee object to refund the margin against, if any. */
  applicationFeeId: string | null;
  /** Remaining refundable balance AFTER this refund. */
  remainingAfterCents: number;
};

/**
 * Build the exact breakdown for a proposed refund, reading the live charge so
 * the already-refunded total can never be stale. `amountCents` of null means
 * a full refund of whatever is still refundable.
 */
export async function quoteRefund(
  stripe: Stripe,
  chargeId: string,
  amountCents: number | null,
): Promise<RefundQuote> {
  const charge: any = await stripe.charges.retrieve(
    chargeId,
    undefined,
    duesRequestOptions(),
  );

  const chargeAmount = Number(charge.amount ?? 0);
  const alreadyRefunded = Number(charge.amount_refunded ?? 0);
  const remaining = Math.max(0, chargeAmount - alreadyRefunded);
  const appFee = Number(charge.application_fee_amount ?? 0);

  const requested = amountCents == null ? remaining : Math.max(0, Math.round(amountCents));
  const refundAmount = Math.min(requested, remaining);

  // Split the application fee into the platform's margin and Stripe's cost.
  // Only the margin goes back. `platformFeeCents` of the gross is a hair over
  // the 1% of the base price actually charged (a cent at most, in the gym's
  // favour), and capping at the fee itself keeps pre-split charges whole:
  // their fee was the margin and nothing else.
  const marginShare = Math.min(appFee, platformFeeCents(chargeAmount));
  const stripeShare = Math.max(0, appFee - marginShare);

  // Proportional for partial refunds, so a half refund gives back half the
  // margin and leaves half of Stripe's cost with the gym.
  const ratio = chargeAmount > 0 ? refundAmount / chargeAmount : 0;
  const feeReversed = Math.min(refundAmount, Math.round(marginShare * ratio));
  const stripeBorne = Math.round(stripeShare * ratio);
  const gymGivesBack = Math.max(0, refundAmount - feeReversed);

  return {
    chargeId,
    paymentIntentId:
      typeof charge.payment_intent === "string"
        ? charge.payment_intent
        : (charge.payment_intent?.id ?? null),
    currency: (charge.currency ?? "usd").toLowerCase(),
    chargeAmountCents: chargeAmount,
    alreadyRefundedCents: alreadyRefunded,
    remainingRefundableCents: remaining,
    refundAmountCents: refundAmount,
    gymGivesBackCents: gymGivesBack,
    platformFeeReversedCents: feeReversed,
    stripeCostBorneByGymCents: stripeBorne,
    applicationFeeId:
      typeof charge.application_fee === "string"
        ? charge.application_fee
        : (charge.application_fee?.id ?? null),
    remainingAfterCents: Math.max(0, remaining - refundAmount),
  };
}

const STRIPE_REASONS = new Set(["duplicate", "fraudulent", "requested_by_customer"]);

/**
 * Issue a refund on the platform account, reversing the gym's transfer and
 * crediting back the platform's margin. Free-text staff reasons are stored in
 * metadata (Stripe only accepts three enum reasons).
 *
 * `feeCreditCents` is the margin to hand back (see the note at the top of this
 * file). The member's money moves first and is never held up by the fee
 * credit: if that second call fails the refund still stands, and the platform
 * is holding a fee it owes the gym rather than the member waiting on a
 * transfer that already left.
 */
export async function createDuesRefund(args: {
  stripe: Stripe;
  chargeId: string;
  amountCents: number;
  reason: string | null;
  metadata: Record<string, string>;
  idempotencyKey?: string;
  feeCreditCents?: number;
  applicationFeeId?: string | null;
}): Promise<Stripe.Refund> {
  const enumReason =
    args.reason && STRIPE_REASONS.has(args.reason)
      ? (args.reason as "duplicate" | "fraudulent" | "requested_by_customer")
      : undefined;

  const refund = (await args.stripe.refunds.create(
    {
      charge: args.chargeId,
      amount: args.amountCents,
      reverse_transfer: true,
      // Handled below, for the margin only.
      refund_application_fee: false,
      ...(enumReason ? { reason: enumReason } : {}),
      metadata: args.metadata,
    },
    {
      ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
    },
  )) as Stripe.Refund;

  const credit = Math.max(0, Math.round(args.feeCreditCents ?? 0));
  if (credit > 0 && args.applicationFeeId) {
    try {
      await args.stripe.applicationFees.createRefund(
        args.applicationFeeId,
        { amount: credit },
        { idempotencyKey: `${refund.id}-fee-credit` },
      );
    } catch (e) {
      // Worth shouting about: the gym is owed this and nothing retries it.
      console.error(
        `[createDuesRefund] refund ${refund.id} succeeded but crediting the ${credit}c platform fee on ${args.applicationFeeId} failed`,
        e,
      );
    }
  }

  return refund;
}

/**
 * Credit the gym its Transaction Fee when a payment is taken back by
 * chargeback.
 *
 * Clause 6.3 of the licence promises this in the same breath as a refund:
 * "Where a Card Payment is refunded to the Member in full, or is reversed by
 * way of chargeback, the corresponding Transaction Fee shall be credited to
 * the Licensee." Refunds did it; chargebacks did not, so a gym that lost a
 * dispute also lost the 1% it was owed back, quietly.
 *
 * Only the margin, as with a refund: Stripe keeps its processing fee on a
 * disputed payment and adds a dispute fee on top, and the licence puts Stripe's
 * charges on the gym.
 *
 * Idempotent on the dispute id, so a replayed webhook credits once.
 */
export async function creditFeeForChargeback(args: {
  stripe: Stripe;
  chargeId: string;
  disputeId: string;
}): Promise<{ creditedCents: number; reason?: string }> {
  const charge: any = await args.stripe.charges.retrieve(
    args.chargeId,
    undefined,
    duesRequestOptions(),
  );

  const appFeeId =
    typeof charge.application_fee === "string"
      ? charge.application_fee
      : (charge.application_fee?.id ?? null);
  if (!appFeeId) return { creditedCents: 0, reason: "no application fee on this charge" };

  const chargeAmount = Number(charge.amount ?? 0);
  const appFee = Number(charge.application_fee_amount ?? 0);
  if (appFee <= 0) return { creditedCents: 0, reason: "application fee is zero" };

  // Same split as a refund: the margin goes back, Stripe's share stays with
  // the gym. A pre-split charge's fee was margin alone, so it returns whole.
  const margin = Math.min(appFee, platformFeeCents(chargeAmount));
  if (margin <= 0) return { creditedCents: 0, reason: "no margin to credit" };

  // Whatever is left uncredited -- a partial refund may already have given
  // some of it back -- so the two paths can never over-refund the fee between
  // them.
  const fee: any = await args.stripe.applicationFees.retrieve(
    appFeeId,
    undefined,
    duesRequestOptions(),
  );
  const alreadyRefunded = Number(fee?.amount_refunded ?? 0);
  const credit = Math.max(0, Math.min(margin, appFee - alreadyRefunded));
  if (credit <= 0) return { creditedCents: 0, reason: "fee already credited" };

  await args.stripe.applicationFees.createRefund(
    appFeeId,
    { amount: credit, metadata: { type: "chargeback_fee_credit", disputeId: args.disputeId } },
    { idempotencyKey: `chargeback-fee-credit:${args.disputeId}` },
  );

  return { creditedCents: credit };
}

/** Invoice status implied by the refunded total. */
export function invoiceStatusForRefund(
  invoiceAmountCents: number,
  refundedCents: number,
): "paid" | "partially_refunded" | "refunded" {
  if (refundedCents <= 0) return "paid";
  if (refundedCents >= invoiceAmountCents) return "refunded";
  return "partially_refunded";
}

/** Public Stripe dashboard URL for a dispute. */
export function disputeDashboardUrl(disputeId: string): string {
  return `https://dashboard.stripe.com/disputes/${disputeId}`;
}

/* ---------------------------------------------------------------------------
 * Local persistence — shared by the staff refund action and the webhook, so
 * a dashboard-issued refund lands in exactly the same shape.
 * ------------------------------------------------------------------------- */

export type RecordRefundInput = {
  stripeRefundId: string;
  stripeChargeId: string | null;
  stripePaymentIntentId: string | null;
  dojoId: string;
  memberId: string | null;
  invoiceId: string | null;
  amountCents: number;
  currency: string;
  reason: string | null;
  status: string;
  source: "app" | "stripe_dashboard";
  createdBy?: string | null;
};

/**
 * Upsert a refund row (idempotent on stripe_refund_id) and re-derive the
 * invoice's refunded total + status from the refund rows themselves, so
 * repeated deliveries can never double-count.
 */
export async function recordRefund(
  supabaseAdmin: any,
  input: RecordRefundInput,
): Promise<void> {
  const { error } = await supabaseAdmin.from("refunds").upsert(
    {
      stripe_refund_id: input.stripeRefundId,
      stripe_charge_id: input.stripeChargeId,
      stripe_payment_intent_id: input.stripePaymentIntentId,
      dojo_id: input.dojoId,
      member_id: input.memberId,
      invoice_id: input.invoiceId,
      amount_cents: input.amountCents,
      currency: input.currency,
      reason: input.reason,
      status: input.status,
      source: input.source,
      ...(input.createdBy ? { created_by: input.createdBy } : {}),
    },
    { onConflict: "stripe_refund_id" },
  );
  if (error) throw new Error(`refunds upsert failed: ${error.message}`);

  if (input.invoiceId) await syncInvoiceRefundTotals(supabaseAdmin, input.invoiceId);
}

/** Recompute invoices.refunded_amount_cents + status from the refund rows. */
export async function syncInvoiceRefundTotals(
  supabaseAdmin: any,
  invoiceId: string,
): Promise<void> {
  const { data: invoice, error: invErr } = await supabaseAdmin
    .from("invoices")
    .select("id, amount_cents")
    .eq("id", invoiceId)
    .maybeSingle();
  if (invErr) throw new Error(`invoice load failed: ${invErr.message}`);
  if (!invoice) return;

  const { data: rows, error: rErr } = await supabaseAdmin
    .from("refunds")
    .select("amount_cents, status")
    .eq("invoice_id", invoiceId);
  if (rErr) throw new Error(`refunds load failed: ${rErr.message}`);

  const refunded = (rows ?? [])
    .filter((r: any) => r.status !== "failed" && r.status !== "canceled")
    .reduce((s: number, r: any) => s + Number(r.amount_cents ?? 0), 0);

  const { error: upErr } = await supabaseAdmin
    .from("invoices")
    .update({
      refunded_amount_cents: refunded,
      status: invoiceStatusForRefund(Number(invoice.amount_cents ?? 0), refunded) as any,
    })
    .eq("id", invoiceId);
  if (upErr) throw new Error(`invoice refund sync failed: ${upErr.message}`);
}

/** Resolve (dojo, member, invoice) for a Stripe charge that we refunded/disputed. */
export async function resolveChargeContext(
  supabaseAdmin: any,
  charge: any,
): Promise<{ dojoId: string; memberId: string | null; invoiceId: string | null } | null> {
  const md = charge?.metadata ?? {};
  let dojoId: string | null = md.dojoId ?? null;
  let memberId: string | null = md.memberId ?? null;
  let invoiceId: string | null = null;

  const stripeInvoiceId =
    typeof charge?.invoice === "string" ? charge.invoice : (charge?.invoice?.id ?? null);
  if (stripeInvoiceId) {
    const { data: inv } = await supabaseAdmin
      .from("invoices")
      .select("id, dojo_id, member_id")
      .eq("stripe_invoice_id", stripeInvoiceId)
      .maybeSingle();
    if (inv) {
      invoiceId = inv.id;
      dojoId = dojoId ?? inv.dojo_id;
      memberId = memberId ?? inv.member_id;
    }
  }

  if (!dojoId || !memberId) {
    const custId =
      typeof charge?.customer === "string" ? charge.customer : (charge?.customer?.id ?? null);
    if (custId) {
      const { data: member } = await supabaseAdmin
        .from("members")
        .select("id, dojo_id")
        .eq("stripe_customer_id", custId)
        .maybeSingle();
      if (member) {
        memberId = memberId ?? member.id;
        dojoId = dojoId ?? member.dojo_id;
      }
    }
  }

  if (!dojoId) return null;
  return { dojoId, memberId, invoiceId };
}

/* ---------------------------------------------------------------------------
 * Staff-facing operations (called from refunds.functions.ts)
 * ------------------------------------------------------------------------- */

export type InvoiceRefundQuote = RefundQuote & {
  invoiceId: string;
  memberName: string | null;
  invoiceAmountCents: number;
  /** Locally recorded refunds so far. */
  locallyRefundedCents: number;
};

async function loadRefundableInvoice(supabaseAdmin: any, dojoId: string, invoiceId: string) {
  const { data: invoice, error } = await supabaseAdmin
    .from("invoices")
    .select(
      "id, dojo_id, member_id, amount_cents, currency, status, refunded_amount_cents, stripe_invoice_id, members(name)",
    )
    .eq("id", invoiceId)
    .eq("dojo_id", dojoId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!invoice) throw new Error("Invoice not found");
  if (!invoice.stripe_invoice_id) {
    throw new Error("This invoice was not paid through Stripe, so it cannot be refunded here.");
  }
  if (!["paid", "partially_refunded"].includes(invoice.status)) {
    throw new Error(`Only paid invoices can be refunded (this one is ${invoice.status}).`);
  }
  return invoice;
}

/** Exact breakdown of what a proposed refund would do. */
export async function quoteInvoiceRefund(args: {
  supabaseAdmin: any;
  stripe: Stripe;
  dojoId: string;
  invoiceId: string;
  amountCents: number | null;
}): Promise<InvoiceRefundQuote> {
  const invoice = await loadRefundableInvoice(args.supabaseAdmin, args.dojoId, args.invoiceId);
  const ref = await resolveInvoiceCharge(args.stripe, invoice.stripe_invoice_id);
  if (!ref.chargeId) {
    throw new Error("Stripe has no completed charge for this invoice, so there is nothing to refund.");
  }
  const quote = await quoteRefund(args.stripe, ref.chargeId, args.amountCents);
  return {
    ...quote,
    invoiceId: invoice.id,
    memberName: (invoice as any).members?.name ?? null,
    invoiceAmountCents: Number(invoice.amount_cents ?? 0),
    locallyRefundedCents: Number(invoice.refunded_amount_cents ?? 0),
  };
}

/**
 * Issue a refund and persist it.
 *
 * The refundable ceiling is re-read from Stripe immediately before issuing, so
 * repeated clicks or retries can never exceed the remaining balance. Refunding
 * deliberately does NOT touch the membership: ending a membership stays an
 * explicit, separate staff decision.
 */
export async function issueInvoiceRefund(args: {
  supabaseAdmin: any;
  stripe: Stripe;
  dojoId: string;
  invoiceId: string;
  amountCents: number | null;
  reason: string | null;
  userId: string;
}): Promise<{ refundId: string; quote: InvoiceRefundQuote }> {
  const quote = await quoteInvoiceRefund({
    supabaseAdmin: args.supabaseAdmin,
    stripe: args.stripe,
    dojoId: args.dojoId,
    invoiceId: args.invoiceId,
    amountCents: args.amountCents,
  });

  if (quote.remainingRefundableCents <= 0) {
    throw new Error("This payment has already been refunded in full.");
  }
  const requested = args.amountCents == null ? quote.remainingRefundableCents : args.amountCents;
  if (requested <= 0) throw new Error("Refund amount must be greater than zero.");
  if (requested > quote.remainingRefundableCents) {
    throw new Error(
      `You can refund at most ${(quote.remainingRefundableCents / 100).toFixed(2)} ${quote.currency.toUpperCase()} on this payment.`,
    );
  }

  const refund = await createDuesRefund({
    stripe: args.stripe,
    chargeId: quote.chargeId,
    amountCents: requested,
    reason: args.reason,
    // The quote was built for this exact amount, so its split is the one to
    // act on: the margin goes back, Stripe's cost stays with the gym.
    feeCreditCents: quote.platformFeeReversedCents,
    applicationFeeId: quote.applicationFeeId,
    metadata: {
      type: "member_dues_refund",
      dojoId: args.dojoId,
      invoiceId: args.invoiceId,
      ...(args.reason ? { staff_reason: args.reason.slice(0, 480) } : {}),
    },
  });

  const { data: invoice } = await args.supabaseAdmin
    .from("invoices")
    .select("member_id")
    .eq("id", args.invoiceId)
    .maybeSingle();

  await recordRefund(args.supabaseAdmin, {
    stripeRefundId: refund.id,
    stripeChargeId: quote.chargeId,
    stripePaymentIntentId: quote.paymentIntentId,
    dojoId: args.dojoId,
    memberId: invoice?.member_id ?? null,
    invoiceId: args.invoiceId,
    amountCents: Number(refund.amount ?? requested),
    currency: (refund.currency ?? quote.currency).toLowerCase(),
    reason: args.reason,
    status: refund.status ?? "succeeded",
    source: "app",
    createdBy: args.userId,
  });

  return {
    refundId: refund.id,
    quote: { ...quote, refundAmountCents: requested },
  };
}
