import { createFileRoute } from "@tanstack/react-router";
import { verifyConnectWebhook } from "@/lib/stripe-connect.server";

// BYOK Stripe Connect webhook — handles member-dues events on connected
// accounts (identified by metadata.type === "member_dues") plus account
// status changes. Configure this URL in the Stripe Dashboard →
// Developers → Webhooks with secret STRIPE_WEBHOOK_SECRET.

function statusToPaymentStatus(s: string): "current" | "overdue" | "none" | "pending" {
  switch (s) {
    case "active":
      return "current";
    // A trialing subscription has taken no money yet, so the member must not
    // be shown as having paid. This matches what checkout already writes.
    case "trialing":
      return "pending";

    case "past_due":
    case "unpaid":
    case "incomplete":
      return "overdue";
    default:
      return "none";
  }
}

function isMemberDues(md: any): boolean {
  return md && md.type === "member_dues" && md.memberId && md.dojoId;
}

/**
 * Stripe removed the top-level `invoice.subscription` field in recent API
 * versions (it now lives under `invoice.parent.subscription_details`).
 * Read both so the pipeline works regardless of the account's API version.
 */
function invoiceSubscriptionId(invoice: any): string | null {
  const top = invoice?.subscription;
  if (typeof top === "string") return top;
  if (top?.id) return top.id;
  const parent = invoice?.parent?.subscription_details?.subscription;
  if (typeof parent === "string") return parent;
  if (parent?.id) return parent.id;
  return null;
}

/** Member-dues metadata copied onto the invoice by Stripe (same place). */
function invoiceSubscriptionMetadata(invoice: any): any {
  return invoice?.parent?.subscription_details?.metadata ?? invoice?.metadata ?? {};
}

/** Period fields, reading the current Stripe API shape (item first). */
function subPeriods(sub: any): { start: string | null; end: string | null } {
  const item = sub?.items?.data?.[0];
  const start = item?.current_period_start ?? sub?.current_period_start ?? null;
  const end = item?.current_period_end ?? sub?.current_period_end ?? null;
  return {
    start: start ? new Date(start * 1000).toISOString() : null,
    end: end ? new Date(end * 1000).toISOString() : null,
  };
}

/**
 * Stripe's own trial end, as an ISO string.
 *
 * This is the date the MONEY moves. It is deliberately mirrored locally so it
 * can be compared with `members.free_trial_ends_at` -- the date the member was
 * promised at signup. The two are computed in different places, and until this
 * was stored there was nothing to compare, so a disagreement would only ever
 * surface as a charge landing on a day nobody expected.
 */
function subTrialEnd(sub: any): string | null {
  const t = sub?.trial_end ?? null;
  return typeof t === "number" ? new Date(t * 1000).toISOString() : null;
}

/** Event `created` (unix seconds) as an ISO string, for ordering guards. */
function eventTs(created?: number | null): string | null {
  return typeof created === "number" ? new Date(created * 1000).toISOString() : null;
}

/**
 * Locally terminal subscription states. Once a row reaches one of these, no
 * `created`/`updated` event may move it back to a live state — a cancellation
 * is terminal locally, and only a genuinely new stripe_subscription_id may
 * create a fresh active row.
 */
const TERMINAL_SUB_STATUSES = new Set(["canceled", "incomplete_expired"]);

type SubGuardRow = {
  status: string | null;
  canceled_at: string | null;
  updated_at: string | null;
  created_at: string | null;
  last_event_at: string | null;
} | null;

/**
 * Stripe does not guarantee delivery order, and old events can be replayed by
 * hand. The write must be skipped when either:
 *  - the event is older than evidence already on the row (last_event_at, or
 *    when that is null: canceled_at / updated_at / created_at), or
 *  - it would resurrect a locally cancelled subscription (invariant, checked
 *    regardless of timestamps).
 */
async function subscriptionWriteGuard(
  supabaseAdmin: any,
  subId: string,
  eventAt: string | null,
  incomingStatus?: string | null,
): Promise<{ blocked: boolean; existing: SubGuardRow }> {
  if (!subId) return { blocked: true, existing: null };
  const { data } = await supabaseAdmin
    .from("member_subscriptions")
    .select("status, canceled_at, updated_at, created_at, last_event_at")
    .eq("stripe_subscription_id", subId)
    .maybeSingle();
  const existing: SubGuardRow = data ?? null;
  if (!existing) return { blocked: false, existing: null };

  // FIX 1 — cancellation is terminal locally.
  if (
    existing.status &&
    TERMINAL_SUB_STATUSES.has(existing.status) &&
    incomingStatus &&
    !TERMINAL_SUB_STATUSES.has(incomingStatus)
  ) {
    console.log("subscription guard: refusing to un-cancel", subId, incomingStatus);
    return { blocked: true, existing };
  }

  // FIX 2 — ordering guard with a safe fallback when last_event_at is null.
  if (eventAt) {
    const t = Date.parse(eventAt);
    const baselines = existing.last_event_at
      ? [existing.last_event_at]
      : [existing.canceled_at, existing.updated_at, existing.created_at];
    for (const b of baselines) {
      if (b && t < Date.parse(b)) {
        console.log("subscription guard: stale event", subId, eventAt, "<", b);
        return { blocked: true, existing };
      }
    }
  }
  return { blocked: false, existing };
}

/** canceled_at is never cleared by a later event. */
function preserveCanceledAt(sub: any, existing: SubGuardRow): string | null {
  const incoming = sub?.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null;
  return incoming ?? existing?.canceled_at ?? null;
}

/**
 * Advance status + billing period on an EXISTING member_subscriptions row,
 * keyed by stripe_subscription_id. Used when the Stripe object carries no
 * member_dues metadata — the row must still never go stale, otherwise the
 * payment-status sweep sees an expired period.
 * Returns false when the event was skipped by the write guard.
 */
async function syncSubscriptionPeriodsById(
  supabaseAdmin: any,
  sub: any,
  eventAt: string | null,
): Promise<boolean> {
  if (!sub?.id) return false;
  const { blocked, existing } = await subscriptionWriteGuard(
    supabaseAdmin,
    sub.id,
    eventAt,
    sub.status,
  );
  if (blocked) return false;
  const { start, end } = subPeriods(sub);
  const { error } = await supabaseAdmin
    .from("member_subscriptions")
    .update({
      status: sub.status,
      current_period_start: start,
      current_period_end: end,
      trial_end: subTrialEnd(sub),
      cancel_at_period_end: !!sub.cancel_at_period_end,
      canceled_at: preserveCanceledAt(sub, existing),
      last_event_at: eventAt,
    })
    .eq("stripe_subscription_id", sub.id);
  if (error) throw new Error(`member_subscriptions sync failed: ${error.message}`);
  return true;
}

/**
 * Has the subscription's most recent invoice actually been paid? Returns null
 * when it cannot be determined (never guess — callers keep prior state).
 */
async function latestInvoicePaid(sub: any): Promise<boolean | null> {
  const raw = sub?.latest_invoice;
  if (!raw) return null;
  if (typeof raw === "object") {
    if (typeof raw.paid === "boolean") return raw.paid;
    if (raw.status) return raw.status === "paid";
  }
  const id = typeof raw === "string" ? raw : raw?.id;
  if (!id) return null;
  try {
    const { getPlatformStripe } = await import("@/lib/stripe-connect.server");
    const inv: any = await getPlatformStripe().invoices.retrieve(id);
    if (typeof inv?.paid === "boolean") return inv.paid;
    return inv?.status === "paid";
  } catch {
    return null;
  }
}

/**
 * SINGLE SOURCE OF TRUTH for "is this member still inside their trial".
 *
 * Stripe issues a ZERO-AMOUNT invoice the moment a subscription starts with a
 * trial and marks it paid immediately, so invoice.paid fires at signup even
 * though no money has moved. Every handler must agree on trial state — derived
 * from the subscription's live Stripe status — instead of deciding for itself.
 * Falls back to the stored row, and returns false only when neither knows.
 */
async function subscriptionIsTrialing(
  supabaseAdmin: any,
  subId: string | null,
  connectedAccountId?: string | null,
): Promise<boolean> {
  if (!subId) return false;
  try {
    const { getPlatformStripe } = await import("@/lib/stripe-connect.server");
    const sub: any = await getPlatformStripe().subscriptions.retrieve(
      subId,
      undefined,
      connectedAccountId ? { stripeAccount: connectedAccountId } : undefined,
    );
    if (sub?.status) return sub.status === "trialing";
  } catch (e) {
    console.error("[connect-webhook] trial status lookup failed", e);
  }
  const { data: row } = await supabaseAdmin
    .from("member_subscriptions")
    .select("status")
    .eq("stripe_subscription_id", subId)
    .maybeSingle();
  return (row as any)?.status === "trialing";
}


async function upsertMemberSubscription(

  supabaseAdmin: any,
  sub: any,
  eventAt: string | null,
): Promise<boolean> {
  const md = sub.metadata ?? {};
  if (!isMemberDues(md)) {
    return await syncSubscriptionPeriodsById(supabaseAdmin, sub, eventAt);
  }
  const { blocked, existing } = await subscriptionWriteGuard(
    supabaseAdmin,
    sub.id,
    eventAt,
    sub.status,
  );
  if (blocked) return false;
  const { start: periodStart, end: periodEnd } = subPeriods(sub);

  // Direct debit subscriptions sit in `incomplete` while the mandate and the
  // first collection clear. That is NOT non-payment, so it maps to 'pending'
  // rather than 'overdue'.
  //
  // The method is read from the subscription's ACTUAL default payment method,
  // never from `payment_settings.payment_method_types` — that is only the list
  // of methods the subscription is ALLOWED to use.
  let usedMethod: string | null = null;
  try {
    const { getPlatformStripe } = await import("@/lib/stripe-connect.server");
    const { methodFromSubscription } = await import("@/lib/stripe-method.server");
    usedMethod = await methodFromSubscription(getPlatformStripe(), sub);
  } catch (e) {
    console.error("[connect-webhook] could not resolve subscription method", e);
  }
  const subIsDirectDebit = usedMethod === "sepa_debit" || usedMethod === "bacs_debit";

  const { error: subErr } = await supabaseAdmin.from("member_subscriptions").upsert(
    {
      member_id: md.memberId,
      dojo_id: md.dojoId,
      plan_id: md.planId ?? null,
      stripe_subscription_id: sub.id,
      stripe_customer_id: typeof sub.customer === "string" ? sub.customer : null,
      status: sub.status,
      currency: sub.currency ?? null,
      ...(usedMethod ? { payment_method: usedMethod } : {}),

      current_period_start: periodStart,
      current_period_end: periodEnd,
      trial_end: subTrialEnd(sub),
      cancel_at_period_end: !!sub.cancel_at_period_end,
      canceled_at: preserveCanceledAt(sub, existing),
      last_event_at: eventAt,
    },
    { onConflict: "stripe_subscription_id" },
  );
  if (subErr) throw new Error(`member_subscriptions upsert failed: ${subErr.message}`);

  // Only mirror payment_status when the subscription write actually applied.
  //
  // Direct debit: a mandate can be accepted (subscription `active` or
  // `incomplete`) days before money actually moves. Hold the member in
  // 'pending' until the first invoice is genuinely paid, so staff read
  // "direct debit pending" rather than unpaid/overdue.
  let mappedStatus: string = statusToPaymentStatus(sub.status);
  if (subIsDirectDebit) {
    // `incomplete` is genuine setup: the mandate/first collection has not been
    // attempted or has not cleared yet, so the member is 'pending' and is not
    // chased. `past_due` / `unpaid` are NOT setup — the collection was
    // attempted and FAILED, which is the dunning path. Mapping those to
    // 'pending' hid failed SEPA collections from staff and from dunning.
    if (sub.status === "incomplete") {
      mappedStatus = "pending";
    } else if (sub.status === "active" || sub.status === "trialing") {
      const firstPaid = await latestInvoicePaid(sub);
      if (firstPaid === false) mappedStatus = "pending";
    }
  }

  const memberUpdates: Record<string, unknown> = {
    payment_status: mappedStatus,
    payment_status_updated_at: new Date().toISOString(),
  };
  // Record the method the member genuinely uses, so direct-debit handling
  // applies. Never overwrite a cash payer (they are managed off-Stripe).
  if (usedMethod) {
    const { data: cur } = await supabaseAdmin
      .from("members")
      .select("payment_method")
      .eq("id", md.memberId)
      .maybeSingle();
    if ((cur as any)?.payment_method !== "cash") memberUpdates.payment_method = usedMethod;
  }
  const { error: mErr } = await supabaseAdmin
    .from("members")
    .update(memberUpdates)
    .eq("id", md.memberId);
  if (mErr) throw new Error(`members payment_status update failed: ${mErr.message}`);

  // SAFETY NET. A member marked overdue must always be told. If the matching
  // invoice.payment_failed never reached us (lost, replayed out of order, or
  // dropped by an earlier guard), open the dunning case from here instead.
  // recordPaymentFailure is idempotent per (invoice, stage), so when both
  // paths run only one notice is sent.
  if (mappedStatus === "overdue" && (sub.status === "past_due" || sub.status === "unpaid")) {
    try {
      const latest = sub.latest_invoice;
      const invId = typeof latest === "string" ? latest : latest?.id ?? null;
      if (invId) {
        // A subscription event carries latest_invoice as a bare ID, not the
        // invoice. Reading an amount off it gave 0 and no payment link -- and
        // because this path usually arrives BEFORE invoice.payment_failed, it
        // claimed the notice first and the member was emailed that a payment
        // of €0.00 had failed, with no way to pay. Fetch the real invoice.
        let invoice: any = typeof latest === "object" ? latest : null;
        if (!invoice || invoice.amount_due == null) {
          const { getPlatformStripe } = await import("@/lib/stripe-connect.server");
          invoice = await getPlatformStripe().invoices.retrieve(String(invId));
        }
        const { recordPaymentFailure } = await import("@/lib/dunning.server");
        await recordPaymentFailure(supabaseAdmin, {
          dojoId: md.dojoId,
          memberId: md.memberId,
          stripeInvoiceId: String(invId),
          amountCents: invoice?.amount_due ?? invoice?.amount_remaining ?? 0,
          currency: (invoice?.currency ?? sub.currency ?? "usd").toLowerCase(),
          hostedInvoiceUrl: invoice?.hosted_invoice_url ?? null,
          failedAt: eventAt ?? null,
        });
      }
    } catch (e) {
      console.error("[connect-webhook] dunning safety net failed", e);
    }
  }




  return true;
}



async function handleCheckoutCompleted(
  supabaseAdmin: any,
  session: any,
  connectedAccountId: string | null | undefined,
  eventAt: string | null,
) {
  const md = session.metadata ?? {};
  if (!isMemberDues(md)) return;

  // DIRECT DEBIT IS NOT INSTANT. A SEPA mandate takes a few working days to
  // confirm and a first BACS collection about three. Completing Checkout only
  // means the mandate was accepted — no money has moved. Hold the member in a
  // 'pending' payment state until invoice.paid actually lands, so staff see
  // "direct debit pending" rather than assuming non-payment.
  //
  // The method is resolved from the SetupIntent / PaymentIntent / subscription
  // the session created. `session.payment_method_types` is only the OFFERED
  // list — reading it recorded every SEPA and BACS payer as a card payer.
  let chosenMethod: string | null = null;
  try {
    const { getPlatformStripe } = await import("@/lib/stripe-connect.server");
    const { methodFromCheckoutSession } = await import("@/lib/stripe-method.server");
    chosenMethod = await methodFromCheckoutSession(getPlatformStripe(), session);
  } catch (e) {
    console.error("[connect-webhook] could not resolve checkout method", e);
  }
  const isDirectDebit = chosenMethod === "sepa_debit" || chosenMethod === "bacs_debit";
  // A SEPA/BACS first collection is only settled once Stripe reports the
  // invoice paid; a completed session never proves that on its own.
  const collected = session.payment_status === "paid" && !isDirectDebit;


  // A member converting off a free trial changes their family's total, so run
  // the shared trial-conversion path (status -> active, payer's new total
  // scheduled for next renewal with notice) instead of flipping status here.
  const { data: priorMember } = await supabaseAdmin
    .from("members")
    .select("status")
    .eq("id", md.memberId)
    .eq("dojo_id", md.dojoId)
    .maybeSingle();
  const wasTrial = (priorMember as any)?.status === "trial";

  // TRIAL DEFERRAL: when the Checkout session created a subscription that is
  // still in its trial, no money has moved and the member is mid-trial. They
  // stay a trial member — with the attendance clock, per-day limits and booking
  // rules intact — and only convert to active when the first payment lands at
  // the end of the trial (handled in handleInvoicePaid).
  let trialingSub: any = null;
  if (wasTrial && typeof session.subscription === "string") {
    try {
      const { getPlatformStripe } = await import("@/lib/stripe-connect.server");
      const s = await getPlatformStripe().subscriptions.retrieve(
        session.subscription,
        undefined,
        connectedAccountId ? { stripeAccount: connectedAccountId } : undefined,
      );
      if ((s as any)?.status === "trialing") trialingSub = s;
    } catch (e) {
      console.error("[connect-webhook] trial status lookup failed", e);
    }
  }
  const stillOnTrial = !!trialingSub;

  const updates: Record<string, unknown> = {
    status: stillOnTrial ? "trial" : "active",
    payment_status:
      stillOnTrial || (isDirectDebit && !collected) ? "pending" : "current",
    payment_status_updated_at: new Date().toISOString(),
  };
  // Record the method genuinely used ('sepa_debit' / 'bacs_debit' / 'card'),
  // so all direct-debit handling downstream applies.
  if (chosenMethod) updates.payment_method = chosenMethod;

  if (md.planId) updates.selected_plan_id = md.planId;
  if (typeof session.customer === "string") updates.stripe_customer_id = session.customer;
  const { error: memberErr } = await supabaseAdmin
    .from("members")
    .update(updates)
    .eq("id", md.memberId)
    .eq("dojo_id", md.dojoId);
  if (memberErr) throw new Error(`checkout.session.completed: ${memberErr.message}`);

  if (wasTrial && !stillOnTrial) {
    try {
      const { convertTrialToActiveInternal } = await import("@/lib/trial-convert.server");
      await convertTrialToActiveInternal({
        dojoId: md.dojoId,
        memberId: md.memberId,
        actorUserId: null,
      });
    } catch (e) {
      // Never fail the webhook over the family-total notice — the payment is
      // already recorded and the nightly sweep re-checks family totals.
      console.error("[connect-webhook] trial conversion follow-up failed", e);
    }
  }

  // Make sure the created Subscription can actually renew on the direct-debit
  // method the member just mandated — keyed off the method they ACTUALLY used,
  // not the offered list, so renewals cannot fall back to card only.
  if (typeof session.subscription === "string" && isDirectDebit && chosenMethod) {
    try {
      const { getPlatformStripe } = await import("@/lib/stripe-connect.server");
      const stripe = getPlatformStripe();
      const sub = await stripe.subscriptions.retrieve(session.subscription);
      const current: string[] = (sub as any).payment_settings?.payment_method_types ?? [];
      if (!current.includes(chosenMethod)) {
        await stripe.subscriptions.update(session.subscription, {
          payment_settings: {
            payment_method_types: Array.from(
              new Set([...current, chosenMethod]),
            ) as any,
            save_default_payment_method: "on_subscription",
          },
        });
      }
    } catch (e) {
      console.error("[connect-webhook] subscription payment_settings sync failed", e);
    }
  }





  // Belt-and-braces: persist the subscription here too, so a missed or
  // undelivered customer.subscription.created event can never leave a paying
  // member without a local member_subscriptions row. A failure here leaves
  // state inconsistent, so it must propagate and let Stripe retry.
  const subId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id ?? null;
  let nextPaymentAt: string | null = null;
  // The RECURRING amount on the subscription — what will actually be collected
  // at renewal. Sourced from the subscription items (so family/tiered and
  // grandfathered prices are reflected), never from the pro-rated first charge.
  let renewalAmountCents: number | null = null;
  let renewalCurrency: string | null = null;
  if (subId) {
    const { getPlatformStripe } = await import("@/lib/stripe-connect.server");
    const sub = await getPlatformStripe().subscriptions.retrieve(
      subId,
      undefined,
      connectedAccountId ? { stripeAccount: connectedAccountId } : undefined,
    );
    await upsertMemberSubscription(supabaseAdmin, sub, eventAt);
    // Basil puts the period on the item; older API versions on the subscription.
    const periodEnd =
      (sub as any)?.items?.data?.[0]?.current_period_end ?? (sub as any)?.current_period_end;
    if (periodEnd) nextPaymentAt = new Date(Number(periodEnd) * 1000).toISOString();
    try {
      let total = 0;
      for (const item of ((sub as any)?.items?.data ?? []) as any[]) {
        const unit = item?.price?.unit_amount;
        if (typeof unit !== "number") {
          total = 0;
          break;
        }
        total += unit * (typeof item?.quantity === "number" ? item.quantity : 1);
        renewalCurrency = renewalCurrency ?? item?.price?.currency ?? null;
      }
      renewalAmountCents = total > 0 ? total : null;
      if (renewalAmountCents == null) renewalCurrency = null;
    } catch {
      renewalAmountCents = null;
      renewalCurrency = null;
    }

    if (isDirectDebit || chosenMethod) {
      await supabaseAdmin
        .from("member_subscriptions")
        .update({ payment_method: isDirectDebit ? chosenMethod ?? "direct_debit" : chosenMethod })
        .eq("stripe_subscription_id", subId);
    }
  }

  // PAID SIGNUP WELCOME. Their first contact from the gym, sent only once the
  // payment side of joining has actually completed. Dedupes on the member, so a
  // redelivered event can never welcome them twice, and never fails the webhook.
  try {
    const { sendSignupWelcome } = await import("@/lib/welcome-email.server");
    const trialFirstChargeAt = stillOnTrial
      ? (trialingSub as any)?.trial_end
        ? new Date(Number((trialingSub as any).trial_end) * 1000).toISOString()
        : null
      : null;
    const res = await sendSignupWelcome({
      dojoId: md.dojoId,
      memberId: md.memberId,
      kind: stillOnTrial ? "trial" : "paid",
      // Nothing has been charged for a trial signup, so the plan they picked
      // and the deferred first charge are passed instead of a paid amount.
      ...(stillOnTrial
        ? {
            trialFirstCharge: {
              amountCents: renewalAmountCents,
              currency: renewalCurrency,
              atIso: trialFirstChargeAt,
            },
          }
        : {}),
      amountCents: typeof session.amount_total === "number" ? session.amount_total : null,
      currency: session.currency ?? null,
      paymentMethod: chosenMethod ?? "card",
      nextPaymentAt,
      renewalAmountCents,
      renewalCurrency,

      collectionPending: isDirectDebit && !collected,
    });
    if (!res.ok) console.error("[connect-webhook] welcome email not sent:", res.error);
  } catch (e) {
    console.error("[connect-webhook] welcome email failed", e);
  }
}




/**
 * Resolve a paid invoice to (memberId, dojoId, subscriptionRowId) through
 * three fallbacks, so invoice.paid ALWAYS results in an invoices row when
 * the invoice belongs to a member-dues subscription. Order:
 *   1. member_subscriptions row keyed by stripe_subscription_id
 *   2. members row keyed by stripe_customer_id in the connected account
 *   3. Retrieve the subscription from Stripe (on the connected account)
 *      and read its member_dues metadata.
 */
async function resolveInvoiceContext(
  supabaseAdmin: any,
  invoice: any,
  connectedAccountId: string | null | undefined,
  eventAt: string | null,

): Promise<{
  memberId: string;
  dojoId: string;
  subscriptionRowId: string | null;
  planId: string | null;
} | null> {
  const subId = invoiceSubscriptionId(invoice);

  if (subId) {
    const { data: sub } = await supabaseAdmin
      .from("member_subscriptions")
      .select("id, member_id, dojo_id, plan_id")
      .eq("stripe_subscription_id", subId)
      .maybeSingle();
    if (sub?.member_id) {
      return {
        memberId: sub.member_id,
        dojoId: sub.dojo_id,
        subscriptionRowId: sub.id,
        planId: sub.plan_id ?? null,
      };
    }
  }

  const custId =
    typeof invoice.customer === "string"
      ? invoice.customer
      : invoice.customer?.id ?? null;
  if (custId) {
    const { data: member } = await supabaseAdmin
      .from("members")
      .select("id, dojo_id, selected_plan_id")
      .eq("stripe_customer_id", custId)
      .maybeSingle();
    if (member?.id) {
      return {
        memberId: member.id,
        dojoId: member.dojo_id,
        subscriptionRowId: null,
        planId: member.selected_plan_id ?? null,
      };
    }
  }

  // Metadata copied onto the invoice by Stripe from the subscription.
  const invMd = invoiceSubscriptionMetadata(invoice);
  if (isMemberDues(invMd)) {
    return {
      memberId: invMd.memberId,
      dojoId: invMd.dojoId,
      subscriptionRowId: null,
      planId: invMd.planId ?? null,
    };
  }

  if (subId) {
    try {
      const { getPlatformStripe } = await import("@/lib/stripe-connect.server");
      // Destination charges: subscriptions/invoices live on the PLATFORM
      // account, so only pass stripeAccount when the event itself came from
      // a connected account.
      const sub = await getPlatformStripe().subscriptions.retrieve(
        subId,
        undefined,
        connectedAccountId ? { stripeAccount: connectedAccountId } : undefined,
      );
      const md: any = sub.metadata ?? {};
      if (isMemberDues(md)) {
        // Persist the subscription so future events resolve on the fast path.
        await upsertMemberSubscription(supabaseAdmin, sub, eventAt);

        return {
          memberId: md.memberId,
          dojoId: md.dojoId,
          subscriptionRowId: null,
          planId: md.planId ?? null,
        };
      }
    } catch (e) {
      console.error("resolveInvoiceContext: subscription retrieve failed", subId, e);
    }
  }

  return null;
}

/**
 * Invoice plan label, derived from the ACTUAL plan behind the invoice.
 *
 * Resolution order: the subscription's plan row -> the invoice context's
 * planId -> the member's selected plan -> the member's stored plan label.
 * When none of those resolve we record "Unknown" rather than silently
 * defaulting to "Monthly", which used to mislabel annual members and corrupt
 * revenue-by-plan reporting.
 */
async function resolveInvoicePlanLabel(
  supabaseAdmin: any,
  ctx: { memberId: string; dojoId: string; planId: string | null },
  stripeSubscriptionId: string | null,
): Promise<"Monthly" | "Annual" | "Drop-in" | "Family" | "Unknown"> {
  const labelFor = (plan: any) => {
    if (!plan) return null;
    if ((plan.plan_type ?? "").toLowerCase() === "family") return "Family" as const;
    if (plan.interval === "year") return "Annual" as const;
    if (plan.interval === "one_time") return "Drop-in" as const;
    if (plan.interval === "month") return "Monthly" as const;
    return null;
  };

  let planId: string | null = ctx.planId ?? null;

  if (stripeSubscriptionId) {
    const { data: subRow } = await supabaseAdmin
      .from("member_subscriptions")
      .select("plan_id")
      .eq("stripe_subscription_id", stripeSubscriptionId)
      .maybeSingle();
    if (subRow?.plan_id) planId = subRow.plan_id;
  }

  const { data: member } = await supabaseAdmin
    .from("members")
    .select("plan, selected_plan_id")
    .eq("id", ctx.memberId)
    .maybeSingle();
  if (!planId && member?.selected_plan_id) planId = member.selected_plan_id;

  if (planId) {
    const { data: plan } = await supabaseAdmin
      .from("dojo_plans")
      .select("interval, plan_type")
      .eq("id", planId)
      .maybeSingle();
    const label = labelFor(plan);
    if (label) return label;
  }

  const stored = member?.plan;
  if (stored === "Monthly" || stored === "Annual" || stored === "Drop-in" || stored === "Family") {
    return stored;
  }
  console.warn("invoice.paid: could not resolve plan label for member", ctx.memberId);
  return "Unknown";
}

async function handleInvoicePaid(
  supabaseAdmin: any,
  invoice: any,
  connectedAccountId: string | null | undefined,
  eventAt: string | null,
) {
  const ctx = await resolveInvoiceContext(
    supabaseAdmin,
    invoice,
    connectedAccountId,
    eventAt,
  );
  if (!ctx) {
    console.log("invoice.paid: unresolved invoice (not a member-dues invoice?)", invoice.id);
    return;
  }

  const paidSubId = invoiceSubscriptionId(invoice);
  // Out-of-order guard: never let an older invoice event drive payment_status
  // backwards over a newer subscription event. It must NOT gate the invoices
  // ledger write — Stripe emits customer.subscription.created one second AFTER
  // the invoice.paid that created it, and when that arrived first every paid
  // invoice was silently dropped, leaving payment history and revenue empty.
  const staleForMember =
    !!paidSubId &&
    (await subscriptionWriteGuard(supabaseAdmin, paidSubId, eventAt, "active")).blocked;
  if (staleForMember) {
    console.log(
      "invoice.paid: out-of-order for member status; still recording invoice",
      invoice.id,
      eventAt,
    );
  }

  // The method that genuinely settled this invoice, read from its charge /
  // payment intent — never from any list of offered methods.
  let paidMethod: string | null = null;
  try {
    const { getPlatformStripe } = await import("@/lib/stripe-connect.server");
    const { methodFromInvoice } = await import("@/lib/stripe-method.server");
    paidMethod = await methodFromInvoice(getPlatformStripe(), invoice);
  } catch (e) {
    console.error("[connect-webhook] could not resolve invoice method", e);
  }

  if (!staleForMember) {
    const { data: memberMethodRow } = await supabaseAdmin
      .from("members")
      .select("payment_method, status")
      .eq("id", ctx.memberId)
      .maybeSingle();

    // A zero-amount invoice is NOT a payment. Stripe raises and instantly
    // "pays" one when a trial subscription starts, which used to flip trial
    // members straight to active before they had paid anything. Money must
    // actually have moved, AND the subscription must no longer be trialing,
    // before a member counts as active.
    const amountPaid = Number(invoice.amount_paid ?? 0);
    const moneyMoved = amountPaid > 0;
    const stillOnTrial = await subscriptionIsTrialing(
      supabaseAdmin,
      paidSubId,
      connectedAccountId,
    );
    const genuinePayment = moneyMoved && !stillOnTrial;

    // A trial member whose deferred first payment has just been taken is
    // converting off their trial, so run the shared conversion path (family
    // totals, notice) rather than flipping status here alone.
    const convertingFromTrial =
      genuinePayment && (memberMethodRow as any)?.status === "trial";

    const statusUpdates: Record<string, unknown> = {};
    if (genuinePayment) {
      statusUpdates.status = "active";
      statusUpdates.payment_status = "current";
      statusUpdates.payment_status_updated_at = new Date().toISOString();
    } else {
      console.log(
        "invoice.paid: not a genuine payment (zero amount or still trialing); leaving member status untouched",
        invoice.id,
        { amountPaid, stillOnTrial },
      );
    }
    if (paidMethod && (memberMethodRow as any)?.payment_method !== "cash") {
      statusUpdates.payment_method = paidMethod;
    }
    if (Object.keys(statusUpdates).length > 0) {
      const { error: statusErr } = await supabaseAdmin
        .from("members")
        .update(statusUpdates)
        .eq("id", ctx.memberId);
      if (statusErr)
        throw new Error(`invoice.paid: payment_status update failed: ${statusErr.message}`);
    }

    if (convertingFromTrial) {
      try {
        const { convertTrialToActiveInternal } = await import("@/lib/trial-convert.server");
        await convertTrialToActiveInternal({
          dojoId: ctx.dojoId,
          memberId: ctx.memberId,
          actorUserId: null,
        });
      } catch (e) {
        // The payment is recorded either way; the nightly sweep re-checks
        // family totals, so never fail the webhook over this.
        console.error("[connect-webhook] trial conversion on first payment failed", e);
      }
    }
  }


  const planLabel = await resolveInvoicePlanLabel(
    supabaseAdmin,
    ctx,
    invoiceSubscriptionId(invoice),
  );

  // The subscription row is often created by customer.subscription.created a
  // beat after this event; re-resolve so the ledger row is linked.
  let subscriptionRowId = ctx.subscriptionRowId;
  if (!subscriptionRowId && paidSubId) {
    const { data: late } = await supabaseAdmin
      .from("member_subscriptions")
      .select("id")
      .eq("stripe_subscription_id", paidSubId)
      .maybeSingle();
    subscriptionRowId = (late as any)?.id ?? null;
  }

  const paidAt = invoice.status_transitions?.paid_at
    ? new Date(invoice.status_transitions.paid_at * 1000).toISOString()
    : new Date().toISOString();
  const periodStart = invoice.period_start
    ? new Date(invoice.period_start * 1000).toISOString()
    : null;
  const periodEnd = invoice.period_end
    ? new Date(invoice.period_end * 1000).toISOString()
    : null;

  const { error: upErr } = await supabaseAdmin.from("invoices").upsert(
    {
      member_id: ctx.memberId,
      dojo_id: ctx.dojoId,
      subscription_id: subscriptionRowId,

      plan: planLabel as any,
      amount_cents: invoice.amount_paid ?? invoice.amount_due ?? 0,
      currency: (invoice.currency ?? "usd").toLowerCase(),
      status: "paid" as any,
      due_date: paidAt.slice(0, 10),
      paid_at: paidAt,
      period_start: periodStart,
      period_end: periodEnd,
      stripe_invoice_id: invoice.id,
      hosted_invoice_url: invoice.hosted_invoice_url ?? null,
      invoice_number: invoice.number ?? null,
      ...(paidMethod ? { payment_method: paidMethod } : {}),
    },
    { onConflict: "stripe_invoice_id" },
  );
  if (upErr) throw new Error(`invoice.paid: invoice upsert failed: ${upErr.message}`);


  // Always advance the local subscription period from Stripe on renewal, so
  // current_period_end never goes stale (a stale period used to look
  // "expired" and flagged paying members overdue). A failure here leaves the
  // invoice row written but the period stale — inconsistent state — so it
  // must propagate and make Stripe retry the whole event.
  if (paidSubId) {
    const { getPlatformStripe } = await import("@/lib/stripe-connect.server");
    const sub = await getPlatformStripe().subscriptions.retrieve(
      paidSubId,
      undefined,
      connectedAccountId ? { stripeAccount: connectedAccountId } : undefined,
    );
    await upsertMemberSubscription(supabaseAdmin, sub, eventAt);
  }

  // Cache the Stripe customer on the member so future events resolve fast.
  const custId =
    typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id ?? null;
  if (custId) {
    await supabaseAdmin
      .from("members")
      .update({ stripe_customer_id: custId })
      .eq("id", ctx.memberId)
      .is("stripe_customer_id", null);
  }

  // A recovered payment must STOP the dunning sequence and say so. Continuing
  // to chase someone who has already paid is worse than not chasing at all.
  try {
    const { resolvePaymentRecovered } = await import("@/lib/dunning.server");
    await resolvePaymentRecovered(supabaseAdmin, {
      dojoId: ctx.dojoId,
      memberId: ctx.memberId,
      stripeInvoiceId: invoice.id ? String(invoice.id) : null,
      amountCents: invoice.amount_paid ?? invoice.amount_due ?? 0,
      currency: (invoice.currency ?? "usd").toLowerCase(),
    });
  } catch (e) {
    console.error("[connect-webhook] closing dunning case failed", e);
  }
}



async function handleInvoiceFailed(
  supabaseAdmin: any,
  invoice: any,
  eventAt: string | null,
) {
  const ctx = await resolveInvoiceContext(supabaseAdmin, invoice, null, eventAt);
  if (!ctx) return;
  const subId = invoiceSubscriptionId(invoice);
  // A failed collection must NEVER be dropped by the subscription-row ordering
  // guard. Stripe emits customer.subscription.updated (past_due) with a
  // `created` one second AFTER the invoice.payment_failed that caused it; when
  // that arrived first, last_event_at moved ahead and this handler bailed out
  // — no overdue flag, no dunning email. That is exactly how a failed SEPA
  // collection went silent. This handler writes no subscription row, so the
  // only thing worth refusing is a case that is already locally terminal
  // (cancelled), where chasing the member would be wrong.
  if (subId) {
    const { data: subRow } = await supabaseAdmin
      .from("member_subscriptions")
      .select("status")
      .eq("stripe_subscription_id", subId)
      .maybeSingle();
    const st = (subRow as any)?.status ?? null;
    if (st && TERMINAL_SUB_STATUSES.has(st)) {
      console.log("invoice.payment_failed: subscription already terminal", invoice.id, st);
      return;
    }
  }

  // Same rule as invoice.paid: a zero-amount invoice on a still-trialing
  // subscription is Stripe bookkeeping, not a failed collection. Never mark a
  // trial member overdue or chase them for it.
  const amountDue = Number(invoice.amount_due ?? invoice.amount_remaining ?? 0);
  if (amountDue <= 0 && (await subscriptionIsTrialing(supabaseAdmin, subId))) {
    console.log("invoice.payment_failed: zero-amount trial invoice, ignoring", invoice.id);
    return;
  }



  const { error } = await supabaseAdmin
    .from("members")
    .update({
      payment_status: "overdue",
      payment_status_updated_at: new Date().toISOString(),
    })
    .eq("id", ctx.memberId);
  if (error) throw new Error(`invoice.payment_failed: ${error.message}`);

  // Tell the member. Marking them overdue and stopping there meant the first
  // they heard of it was being turned away at the desk. The notice itself is
  // idempotent per (invoice, stage), so a replayed event cannot double-send.
  try {
    const { recordPaymentFailure } = await import("@/lib/dunning.server");
    await recordPaymentFailure(supabaseAdmin, {
      dojoId: ctx.dojoId,
      memberId: ctx.memberId,
      stripeInvoiceId: String(invoice.id),
      amountCents: invoice.amount_due ?? invoice.amount_remaining ?? 0,
      currency: (invoice.currency ?? "usd").toLowerCase(),
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
      failedAt: eventAt ?? null,
    });
  } catch (e) {
    // Notification must never lose the status write that Stripe is relying on.
    console.error("[connect-webhook] dunning notice failed", e);
  }

  // Record the unpaid invoice so outstanding amounts are visible in billing
  // instead of existing only inside Stripe. Idempotent on stripe_invoice_id,
  // and never downgrades a row that already settled.
  const { data: existingInv } = await supabaseAdmin
    .from("invoices")
    .select("id, status")
    .eq("stripe_invoice_id", String(invoice.id))
    .maybeSingle();
  const settled = new Set(["paid", "refunded", "partially_refunded"]);
  if (existingInv && settled.has(String((existingInv as any).status))) return;

  const planLabel = await resolveInvoicePlanLabel(supabaseAdmin, ctx, subId);
  let subscriptionRowId: string | null = ctx.subscriptionRowId;
  if (!subscriptionRowId && subId) {
    const { data: late } = await supabaseAdmin
      .from("member_subscriptions")
      .select("id")
      .eq("stripe_subscription_id", subId)
      .maybeSingle();
    subscriptionRowId = (late as any)?.id ?? null;
  }

  const dueDate = invoice.due_date
    ? new Date(invoice.due_date * 1000)
    : eventAt
      ? new Date(eventAt)
      : new Date();
  const dueDateStr = dueDate.toISOString().slice(0, 10);
  const status = dueDate.getTime() < Date.now() ? "overdue" : "due";

  const { error: invErr } = await supabaseAdmin.from("invoices").upsert(
    {
      member_id: ctx.memberId,
      dojo_id: ctx.dojoId,
      subscription_id: subscriptionRowId,
      plan: planLabel as any,
      amount_cents: invoice.amount_due ?? invoice.amount_remaining ?? 0,
      currency: (invoice.currency ?? "usd").toLowerCase(),
      status: status as any,
      due_date: dueDateStr,
      paid_at: null,
      period_start: invoice.period_start
        ? new Date(invoice.period_start * 1000).toISOString()
        : null,
      period_end: invoice.period_end ? new Date(invoice.period_end * 1000).toISOString() : null,
      stripe_invoice_id: invoice.id,
      hosted_invoice_url: invoice.hosted_invoice_url ?? null,
      invoice_number: invoice.number ?? null,
    },
    { onConflict: "stripe_invoice_id" },
  );
  if (invErr) throw new Error(`invoice.payment_failed: invoice upsert failed: ${invErr.message}`);
}




async function handleAccountUpdated(supabaseAdmin: any, account: any) {
  if (!account?.id) return;
  await supabaseAdmin
    .from("dojos")
    .update({
      stripe_charges_enabled: !!account.charges_enabled,
      stripe_details_submitted: !!account.details_submitted,
      stripe_account_country: account.country ?? null,
    })
    .eq("stripe_account_id", account.id);
}

async function handleCapabilityUpdated(supabaseAdmin: any, capability: any) {
  const acctId = typeof capability?.account === "string" ? capability.account : null;
  if (!acctId) return;
  const { getPlatformStripe } = await import("@/lib/stripe-connect.server");
  try {
    const acct = await getPlatformStripe().accounts.retrieve(acctId);
    await handleAccountUpdated(supabaseAdmin, acct);
  } catch (e) {
    console.error("capability.updated: failed to retrieve account", acctId, e);
  }
}


/* ---------------------------------------------------------------------------
 * Refunds issued anywhere (app or Stripe Dashboard)
 * -------------------------------------------------------------------------
 * Idempotent on stripe_refund_id, so a refund we already recorded locally is
 * simply re-upserted and the invoice total re-derived from the refund rows.
 * ------------------------------------------------------------------------- */

async function retrieveCharge(chargeId: string): Promise<any | null> {
  const { getPlatformStripe, duesRequestOptions } = await import(
    "@/lib/stripe-connect.server"
  );
  try {
    return await getPlatformStripe().charges.retrieve(
      chargeId,
      undefined,
      duesRequestOptions(),
    );
  } catch (e) {
    console.error("charge retrieve failed", chargeId, e);
    return null;
  }
}

async function recordRefundFromStripe(
  supabaseAdmin: any,
  charge: any,
  refund: any,
  source: "app" | "stripe_dashboard",
) {
  const { recordRefund, resolveChargeContext } = await import("@/lib/refunds.server");
  const ctx = await resolveChargeContext(supabaseAdmin, charge);
  if (!ctx) {
    console.log("refund: could not resolve dojo for charge", charge?.id);
    return;
  }
  await recordRefund(supabaseAdmin, {
    stripeRefundId: refund.id,
    stripeChargeId: typeof refund.charge === "string" ? refund.charge : (charge?.id ?? null),
    stripePaymentIntentId:
      typeof refund.payment_intent === "string"
        ? refund.payment_intent
        : (refund.payment_intent?.id ??
          (typeof charge?.payment_intent === "string" ? charge.payment_intent : null)),
    dojoId: ctx.dojoId,
    memberId: ctx.memberId,
    invoiceId: ctx.invoiceId,
    amountCents: Number(refund.amount ?? 0),
    currency: (refund.currency ?? charge?.currency ?? "usd").toLowerCase(),
    reason: refund.reason ?? refund.metadata?.staff_reason ?? null,
    status: refund.status ?? "succeeded",
    source,
  });
}

async function handleChargeRefunded(supabaseAdmin: any, charge: any) {
  let refunds: any[] = charge?.refunds?.data ?? [];
  if (refunds.length === 0 && charge?.id) {
    const { getPlatformStripe, duesRequestOptions } = await import(
      "@/lib/stripe-connect.server"
    );
    const list = await getPlatformStripe().refunds.list(
      { charge: charge.id, limit: 100 },
      duesRequestOptions(),
    );
    refunds = list.data as any[];
  }
  for (const refund of refunds) {
    // A refund created by our own action is already recorded; the upsert makes
    // this a no-op rather than a duplicate.
    await recordRefundFromStripe(supabaseAdmin, charge, refund, "stripe_dashboard");
  }
}

async function handleRefundUpdated(supabaseAdmin: any, refund: any) {
  const chargeId =
    typeof refund?.charge === "string" ? refund.charge : (refund?.charge?.id ?? null);
  if (!chargeId) return;
  const charge = await retrieveCharge(chargeId);
  if (!charge) throw new Error(`charge.refund.updated: could not load charge ${chargeId}`);
  await recordRefundFromStripe(supabaseAdmin, charge, refund, "stripe_dashboard");
}

/* ---------------------------------------------------------------------------
 * Disputes / chargebacks — money has already left the gym's account.
 * ------------------------------------------------------------------------- */

async function disputeEventIsStale(
  supabaseAdmin: any,
  disputeId: string,
  eventAt: string | null,
): Promise<boolean> {
  if (!eventAt) return false;
  const { data } = await supabaseAdmin
    .from("disputes")
    .select("last_event_at")
    .eq("stripe_dispute_id", disputeId)
    .maybeSingle();
  if (!data?.last_event_at) return false;
  return Date.parse(eventAt) < Date.parse(data.last_event_at);
}

async function handleDispute(
  supabaseAdmin: any,
  dispute: any,
  eventAt: string | null,
  closed: boolean,
) {
  if (!dispute?.id) return;
  if (await disputeEventIsStale(supabaseAdmin, dispute.id, eventAt)) {
    console.log("dispute: skipping out-of-order event", dispute.id, eventAt);
    return;
  }

  const chargeId =
    typeof dispute.charge === "string" ? dispute.charge : (dispute.charge?.id ?? null);
  const charge = chargeId ? await retrieveCharge(chargeId) : null;
  if (chargeId && !charge) {
    throw new Error(`dispute: could not load charge ${chargeId}`);
  }

  const { resolveChargeContext, syncInvoiceRefundTotals } = await import(
    "@/lib/refunds.server"
  );
  const ctx = charge ? await resolveChargeContext(supabaseAdmin, charge) : null;
  if (!ctx) {
    console.log("dispute: could not resolve dojo for charge", chargeId);
    return;
  }

  const status: string = dispute.status ?? "needs_response";
  const won = status === "won";
  const lost = status === "lost";
  const outcome = closed ? (won ? "won" : lost ? "lost" : status) : null;

  // Whether this is the first we have heard of this dispute, read before the
  // upsert below makes it look familiar. Which Stripe event arrives first
  // varies, so "first seen" is a safer trigger for the alert than any
  // particular event type or status.
  const { data: knownDispute } = await supabaseAdmin
    .from("disputes")
    .select("id")
    .eq("stripe_dispute_id", dispute.id)
    .maybeSingle();
  const isNewDispute = !knownDispute;

  const { error } = await supabaseAdmin.from("disputes").upsert(
    {
      stripe_dispute_id: dispute.id,
      stripe_charge_id: chargeId,
      stripe_payment_intent_id:
        typeof dispute.payment_intent === "string" ? dispute.payment_intent : null,
      dojo_id: ctx.dojoId,
      member_id: ctx.memberId,
      invoice_id: ctx.invoiceId,
      amount_cents: Number(dispute.amount ?? 0),
      currency: (dispute.currency ?? charge?.currency ?? "usd").toLowerCase(),
      reason: dispute.reason ?? null,
      status,
      evidence_due_by: dispute.evidence_details?.due_by
        ? new Date(dispute.evidence_details.due_by * 1000).toISOString()
        : null,
      outcome,
      closed_at: closed ? new Date().toISOString() : null,
      last_event_at: eventAt,
    },
    { onConflict: "stripe_dispute_id" },
  );
  if (error) throw new Error(`disputes upsert failed: ${error.message}`);

  // A dispute is rare, urgent and on a clock -- the money is already gone and
  // evidence is due by a date that passes quietly. The dashboard panel only
  // helps whoever opens the dashboard.
  //
  // Sent the first time we see a dispute, whatever state it arrives in. Some
  // card networks open and close one in the same breath, and a gym still wants
  // to know a member charged them back. The idempotency key is the dispute id,
  // so the several events Stripe sends for one dispute still send one email.
  if (isNewDispute) {
    try {
      const { sendChargebackAlert } = await import("@/lib/staff-notify.server");
      await sendChargebackAlert({
        dojoId: ctx.dojoId,
        memberId: ctx.memberId ?? null,
        disputeId: dispute.id,
        amountCents: Number(dispute.amount ?? 0),
        currency: (dispute.currency ?? charge?.currency ?? "eur").toLowerCase(),
        reason: dispute.reason ?? null,
        evidenceDueBy: dispute.evidence_details?.due_by
          ? new Date(dispute.evidence_details.due_by * 1000).toISOString()
          : null,
        status,
      });
    } catch (e) {
      // Recording the dispute matters more; throwing would make Stripe retry
      // the whole event and redo the updates below.
      console.error(`dispute ${dispute.id}: staff alert failed`, e);
    }
  }

  // Member payment status: an open chargeback must never look normal.
  if (ctx.memberId) {
    const paymentStatus = !closed || status === "needs_response" || status === "under_review"
      ? "disputed"
      : lost
        ? "overdue"
        : "current";
    const { error: mErr } = await supabaseAdmin
      .from("members")
      .update({
        payment_status: paymentStatus as any,
        payment_status_updated_at: new Date().toISOString(),
      })
      .eq("id", ctx.memberId);
    if (mErr) throw new Error(`dispute member update failed: ${mErr.message}`);
  }

  // A lost dispute is a Card Payment reversed by chargeback, which under
  // clause 6.3 of the licence credits the gym its Transaction Fee -- the same
  // 1% a full refund returns. Stripe's own fees and the dispute fee stay with
  // the gym, as they do on a refund.
  if (closed && lost && chargeId) {
    try {
      const { creditFeeForChargeback } = await import("@/lib/refunds.server");
      const { getPlatformStripe } = await import("@/lib/stripe-connect.server");
      const res = await creditFeeForChargeback({
        stripe: getPlatformStripe(),
        chargeId,
        disputeId: dispute.id,
      });
      console.log(
        res.creditedCents > 0
          ? `dispute ${dispute.id}: credited ${res.creditedCents}c transaction fee to dojo ${ctx.dojoId}`
          : `dispute ${dispute.id}: no fee credit — ${res.reason}`,
      );
    } catch (e) {
      // The dispute record matters more than the credit: throwing here would
      // have Stripe retry the whole event and re-run everything above. Logged
      // loudly instead, because the gym is owed this and nothing retries it.
      console.error(`dispute ${dispute.id}: transaction fee credit failed`, e);
    }
  }

  // Invoice: a lost dispute means the money is gone for good.
  if (ctx.invoiceId && closed) {
    if (lost) {
      const { data: inv } = await supabaseAdmin
        .from("invoices")
        .select("amount_cents")
        .eq("id", ctx.invoiceId)
        .maybeSingle();
      const { error: iErr } = await supabaseAdmin
        .from("invoices")
        .update({
          status: "refunded" as any,
          refunded_amount_cents: Number(inv?.amount_cents ?? dispute.amount ?? 0),
        })
        .eq("id", ctx.invoiceId);
      if (iErr) throw new Error(`dispute invoice update failed: ${iErr.message}`);
    } else if (won) {
      // Restore whatever the refund rows say the true state is.
      await syncInvoiceRefundTotals(supabaseAdmin, ctx.invoiceId);
    }
  }
}

/* ---------------------------------------------------------------------------
 * Payment method removed — catch a silently deleted card before renewal.
 * ------------------------------------------------------------------------- */

async function handlePaymentMethodDetached(
  supabaseAdmin: any,
  paymentMethod: any,
  previousAttributes: any,
) {
  const customerId =
    (typeof paymentMethod?.customer === "string" ? paymentMethod.customer : null) ??
    (typeof previousAttributes?.customer === "string" ? previousAttributes.customer : null);
  if (!customerId) return;

  const { data: member } = await supabaseAdmin
    .from("members")
    .select("id, payment_status")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  if (!member) return;

  // Drop the stored card record for this payment method.
  if (paymentMethod?.id) {
    await supabaseAdmin
      .from("member_payment_methods")
      .delete()
      .eq("stripe_payment_method_id", paymentMethod.id);
  }

  const { getPlatformStripe, duesRequestOptions } = await import(
    "@/lib/stripe-connect.server"
  );
  const remaining = await getPlatformStripe().paymentMethods.list(
    { customer: customerId, limit: 1 },
    duesRequestOptions(),
  );
  if ((remaining.data ?? []).length > 0) return;

  // No card left on file: they need payment details before the next renewal.
  await supabaseAdmin
    .from("member_payment_methods")
    .delete()
    .eq("member_id", member.id);

  if (member.payment_status !== "disputed") {
    const { error } = await supabaseAdmin
      .from("members")
      .update({
        payment_status: "none" as any,
        payment_status_updated_at: new Date().toISOString(),
      })
      .eq("id", member.id);
    if (error) throw new Error(`payment_method.detached: ${error.message}`);
  }
}




export const Route = createFileRoute("/api/public/stripe/connect-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let event: {
          type: string;
          data: { object: any };
          id: string;
          account?: string;
          created?: number;
        };
        try {
          event = await verifyConnectWebhook(request);
        } catch (e) {
          console.error("Connect webhook verify failed:", e);
          return new Response("Invalid signature", { status: 400 });
        }

        const connectedAccountId = event.account ?? null;
        const eventAt = eventTs(event.created);
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // ---- Idempotency ledger ----------------------------------------
        // Claim the event id first. A conflict means we have seen it before:
        // if it was already processed, ack immediately without re-running the
        // handler; if it was received but never completed (previous attempt
        // failed), fall through and reprocess.
        const { error: claimErr } = await supabaseAdmin.from("stripe_events").insert({
          event_id: event.id,
          type: event.type,
          account: connectedAccountId,
          created_at: eventAt,
          status: "received",
        });
        if (claimErr) {
          const { data: existing } = await supabaseAdmin
            .from("stripe_events")
            .select("processed_at")
            .eq("event_id", event.id)
            .maybeSingle();
          if (existing?.processed_at) {
            console.log("Connect webhook: duplicate event ignored", event.id, event.type);
            return Response.json({ received: true, duplicate: true });
          }
          if (!existing) {
            // The insert failed for a reason other than a replay — surface it
            // so Stripe retries rather than silently dropping the event.
            console.error("stripe_events insert failed", event.id, claimErr);
            return new Response("Ledger error", { status: 500 });
          }
          console.log("Connect webhook: reprocessing previously failed event", event.id);
        }

        try {
          switch (event.type) {
            case "checkout.session.completed":
              await handleCheckoutCompleted(
                supabaseAdmin,
                event.data.object,
                connectedAccountId,
                eventAt,
              );
              break;
            case "customer.subscription.created":
            case "customer.subscription.updated":
              await upsertMemberSubscription(supabaseAdmin, event.data.object, eventAt);
              break;
            case "customer.subscription.deleted": {
              const sub = event.data.object;
              if (isMemberDues(sub.metadata ?? {})) {
                if (
                  (await subscriptionWriteGuard(supabaseAdmin, sub.id, eventAt, "canceled"))
                    .blocked
                ) {
                  console.log("subscription.deleted: skipping out-of-order event", sub.id);
                  break;
                }
                const { data: existingRow } = await supabaseAdmin
                  .from("member_subscriptions")
                  .select("canceled_at")
                  .eq("stripe_subscription_id", sub.id)
                  .maybeSingle();
                const { error: subErr } = await supabaseAdmin
                  .from("member_subscriptions")
                  .update({
                    status: "canceled",
                    canceled_at:
                      (existingRow as any)?.canceled_at ??
                      (sub.canceled_at
                        ? new Date(sub.canceled_at * 1000).toISOString()
                        : new Date().toISOString()),
                    last_event_at: eventAt,
                  })
                  .eq("stripe_subscription_id", sub.id);
                if (subErr) throw new Error(subErr.message);
                const { error: mErr } = await supabaseAdmin
                  .from("members")
                  .update({
                    payment_status: "none",
                    payment_status_updated_at: new Date().toISOString(),
                  })
                  .eq("id", sub.metadata.memberId);
                if (mErr) throw new Error(mErr.message);
              }
              break;
            }
            case "invoice.paid":
            case "invoice.payment_succeeded":
              await handleInvoicePaid(
                supabaseAdmin,
                event.data.object,
                connectedAccountId,
                eventAt,
              );
              break;
            case "invoice.payment_failed":
              await handleInvoiceFailed(supabaseAdmin, event.data.object, eventAt);
              break;
            case "account.updated":
              await handleAccountUpdated(supabaseAdmin, event.data.object);
              break;
            case "capability.updated":
              await handleCapabilityUpdated(supabaseAdmin, event.data.object);
              break;

            // ---- Refunds (app-issued or Stripe Dashboard) ---------------
            case "charge.refunded":
              await handleChargeRefunded(supabaseAdmin, event.data.object);
              break;
            case "charge.refund.updated":
            case "refund.updated":
              await handleRefundUpdated(supabaseAdmin, event.data.object);
              break;

            // ---- Disputes / chargebacks --------------------------------
            case "charge.dispute.created":
            case "charge.dispute.updated":
              await handleDispute(supabaseAdmin, event.data.object, eventAt, false);
              break;
            case "charge.dispute.closed":
              await handleDispute(supabaseAdmin, event.data.object, eventAt, true);
              break;

            // ---- Card removed ------------------------------------------
            case "payment_method.detached":
              await handlePaymentMethodDetached(
                supabaseAdmin,
                event.data.object,
                (event.data as any).previous_attributes ?? null,
              );
              break;



            default:
              console.log("Connect webhook: unhandled event", event.type);
          }
        } catch (e) {
          // Leave processed_at NULL so the retry reprocesses this event, and
          // return non-2xx so Stripe actually retries — never ack partial
          // state.
          console.error("Connect webhook handler error:", event.type, e);
          await supabaseAdmin
            .from("stripe_events")
            .update({ status: "failed" })
            .eq("event_id", event.id);
          return new Response("Handler error", { status: 500 });
        }

        await supabaseAdmin
          .from("stripe_events")
          .update({ status: "processed", processed_at: new Date().toISOString() })
          .eq("event_id", event.id);
        return Response.json({ received: true });
      },
    },
  },
});

