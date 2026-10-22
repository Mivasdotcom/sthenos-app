// DUNNING — telling a member their payment failed, on a schedule, and stopping
// the moment it is fixed.
//
// Rules that this module exists to enforce:
//  1. A failed payment ALWAYS reaches the member. Silence means they are turned
//     away at the desk with no warning, which is the outcome we are fixing.
//  2. Exactly one notice per (failed invoice, stage). The unique constraint on
//     dunning_notices(stripe_invoice_id, stage) is the guard — a replayed Stripe
//     event or a re-run of the nightly sweep cannot double-send.
//  3. The sequence follows the gym's OWN grace period (dojos.hold_grace_days),
//     never a hardcoded one, because that is the same number that governs when
//     access is actually restricted.
//  4. The wording matches the method genuinely recorded on the member. A card is
//     fixed by updating the card; a direct debit is usually funds or a cancelled
//     mandate and is re-collected rather than retried by the member.
//  5. A recovered payment closes the case and says so. Chasing someone who has
//     already paid is worse than not chasing at all.
//
// Every send goes through notifyMember → sendAppEmail, so suppression, send
// logging, retry queueing and idempotency behave exactly as for other email.

import { PUBLIC_SITE_URL } from "@/lib/site";

export type DunningStage = "first" | "reminder" | "final" | "recovered";

/** Stages that represent an unresolved failure (i.e. not the all-clear). */
const CHASE_STAGES: DunningStage[] = ["first", "reminder", "final"];

function money(cents: number, currency: string): string {
  const cur = (currency || "usd").toUpperCase();
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: cur }).format(cents / 100);
  } catch {
    return `${cur} ${(cents / 100).toFixed(2)}`;
  }
}

/**
 * When each stage is due, expressed in days after the first failure, derived
 * from the gym's grace period:
 *  - first    → immediately
 *  - reminder → about halfway through the grace period
 *  - final    → at the end of it, just before access is restricted
 * Days are kept strictly increasing so a 0- or 1-day grace period still
 * produces three distinct notices rather than three on the same day.
 */
export function dunningSchedule(graceDays: number): { reminderDay: number; finalDay: number } {
  const grace = Math.max(0, Math.floor(graceDays || 0));
  const reminderDay = Math.max(1, Math.ceil(grace / 2));
  const finalDay = Math.max(reminderDay + 1, grace);
  return { reminderDay, finalDay };
}

function isDirectDebit(method: string | null | undefined): boolean {
  return method === "sepa_debit" || method === "bacs_debit" || method === "direct_debit";
}

function methodNoun(method: string | null | undefined): string {
  if (method === "sepa_debit") return "SEPA Direct Debit";
  if (method === "bacs_debit") return "Bacs Direct Debit";
  if (method === "direct_debit") return "Direct Debit";
  return "card";
}

/**
 * The member-facing message. Calm and practical: a failed payment is almost
 * always an expiry, a bank block or a short balance, so nothing here reads as
 * an accusation or a threat.
 */
export function dunningMessage(args: {
  stage: DunningStage;
  memberName: string | null;
  gymName: string;
  amountCents: number;
  currency: string;
  paymentMethod: string | null;
  /** Days left before access is restricted. Only used for reminder/final. */
  daysLeft: number;
  portalUrl: string;
  invoiceUrl: string | null;
}): { subject: string; body: string } {
  const hi = args.memberName ? `Hi ${args.memberName.split(" ")[0]},` : "Hi,";
  const amount = money(args.amountCents, args.currency);
  const dd = isDirectDebit(args.paymentMethod);
  const noun = methodNoun(args.paymentMethod);

  if (args.stage === "recovered") {
    return {
      subject: `Payment received — you're all set at ${args.gymName}`,
      body: [
        hi,
        `Your payment of ${amount} has gone through, so your membership at ${args.gymName} is up to date again. Nothing further is needed and we've stopped the reminders.`,
        `Thanks for sorting it out — see you in class.`,
      ].join("\n\n"),
    };
  }

  // What the member actually has to DO, which differs by method.
  const fix = dd
    ? `${noun} collections usually fail for one of two reasons: there weren't enough funds in the account on the collection day, or the mandate was cancelled at the bank. We'll try the collection again, but if the mandate has gone you'll need to set it up again — you can do that here:`
    : `This is nearly always an expired card, a new card number, or a routine block from your bank rather than anything wrong on your side. You can update your ${noun} details here:`;

  const link = `${args.portalUrl}\n\nThat link opens your membership page, where "Update payment method" takes you to our secure payment page.`;

  if (args.stage === "first") {
    return {
      subject: `We couldn't collect your ${amount} membership payment`,
      body: [
        hi,
        `Your membership payment of ${amount} to ${args.gymName} didn't go through${
          dd ? ` when we collected it by ${noun}` : ""
        }.`,
        fix,
        link,
        dd
          ? `Because ${noun} takes a few days to clear, please do this as soon as you can so the next collection isn't affected.`
          : `Once it's updated we'll take the payment automatically — you don't need to do anything else.`,
        `If you think this is a mistake, or you'd rather sort it at the desk, just reply to this email.`,
      ].join("\n\n"),
    };
  }

  const daysLeft = Math.max(0, args.daysLeft);
  const window =
    daysLeft <= 0
      ? "today"
      : daysLeft === 1
        ? "in the next day"
        : `in the next ${daysLeft} days`;

  if (args.stage === "reminder") {
    return {
      subject: `Reminder: your ${amount} payment is still outstanding`,
      body: [
        hi,
        `We still haven't been able to collect your membership payment of ${amount} for ${args.gymName}${
          dd ? ` by ${noun}` : ""
        }.`,
        fix,
        link,
        `Sorting it ${window} keeps your access to classes uninterrupted.`,
        `Any problems, reply to this email and we'll help.`,
      ].join("\n\n"),
    };
  }

  return {
    subject: `Final reminder: ${amount} outstanding on your membership`,
    body: [
      hi,
      `Your membership payment of ${amount} for ${args.gymName} is still outstanding${
        dd ? ` after the ${noun} collection failed` : ""
      }. This is the last reminder we'll send.`,
      `Class access is paused while a payment is outstanding, so please update your details ${window}:`,
      link,
      dd
        ? `If the mandate at your bank was cancelled, setting it up again from that page is all that's needed.`
        : `As soon as the payment goes through your access resumes automatically.`,
      `If money is the problem, talk to us — we'd much rather pause your membership than lose you.`,
    ].join("\n\n"),
  };
}

type SendArgs = {
  dojoId: string;
  memberId: string;
  stage: DunningStage;
  stripeInvoiceId: string;
  amountCents: number;
  currency: string;
  paymentMethod: string | null;
  hostedInvoiceUrl: string | null;
  firstFailedAt: string;
  daysLeft: number;
  gymName: string;
  memberName: string | null;
};

/**
 * Claims the (invoice, stage) slot and, only if the claim succeeded, sends.
 * The insert is the lock: a duplicate event loses the race on the unique
 * constraint and sends nothing.
 */
async function claimAndSend(supabaseAdmin: any, args: SendArgs): Promise<boolean> {
  // A failed payment of nothing is never real -- it means the caller had the
  // invoice ID but not the invoice. Refuse BEFORE claiming, so the slot stays
  // open for the path that does have the amount and the payment link. Claiming
  // it here is how a member was once emailed that €0.00 had failed with no
  // way to pay, while the correct notice was discarded as a duplicate.
  if (CHASE_STAGES.includes(args.stage) && !(args.amountCents > 0)) {
    console.error(
      "[dunning] refusing a zero-amount notice; leaving the slot for a caller with the invoice",
      args.stripeInvoiceId,
      args.stage,
    );
    return false;
  }

  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from("dunning_notices")
    .insert({
      dojo_id: args.dojoId,
      member_id: args.memberId,
      stripe_invoice_id: args.stripeInvoiceId,
      stage: args.stage,
      amount_cents: args.amountCents,
      currency: args.currency,
      payment_method: args.paymentMethod,
      hosted_invoice_url: args.hostedInvoiceUrl,
      first_failed_at: args.firstFailedAt,
      // The all-clear is itself the resolution of the case.
      resolved_at: args.stage === "recovered" ? new Date().toISOString() : null,
    })
    .select("id")
    .maybeSingle();

  if (claimErr) {
    // 23505 = this stage was already sent for this invoice. Correct, not an error.
    if ((claimErr as any).code === "23505") return false;
    console.error("[dunning] could not record notice", args.stage, claimErr);
    return false;
  }
  if (!claimed?.id) return false;

  const { subject, body } = dunningMessage({
    stage: args.stage,
    memberName: args.memberName,
    gymName: args.gymName,
    amountCents: args.amountCents,
    currency: args.currency,
    paymentMethod: args.paymentMethod,
    daysLeft: args.daysLeft,
    portalUrl: `${PUBLIC_SITE_URL}/portal`,
    invoiceUrl: args.hostedInvoiceUrl,
  });

  const { notifyMember } = await import("@/lib/member-notify.server");
  const res = await notifyMember({
    dojoId: args.dojoId,
    memberId: args.memberId,
    subject,
    body,
    // Stable per intended send: a retry of the whole flow cannot double-send.
    idempotencyKey: `dunning-${args.stripeInvoiceId}-${args.stage}`,
  });

  await supabaseAdmin
    .from("dunning_notices")
    .update({ emailed: res.emailed, send_error: res.emailError })
    .eq("id", claimed.id);

  if (!res.emailed) {
    console.warn("[dunning] notice email did not go out", {
      stage: args.stage,
      invoice: args.stripeInvoiceId,
      error: res.emailError,
      pending: res.emailPending,
    });
  }
  return true;
}

async function loadContext(
  supabaseAdmin: any,
  dojoId: string,
  memberId: string,
): Promise<{ gymName: string; graceDays: number; memberName: string | null; method: string | null }> {
  const [{ data: dojo }, { data: member }] = await Promise.all([
    supabaseAdmin.from("dojos").select("name, hold_grace_days").eq("id", dojoId).maybeSingle(),
    supabaseAdmin.from("members").select("name, payment_method").eq("id", memberId).maybeSingle(),
  ]);
  return {
    gymName: (dojo as any)?.name ?? "your gym",
    graceDays: (dojo as any)?.hold_grace_days ?? 1,
    memberName: (member as any)?.name ?? null,
    method: (member as any)?.payment_method ?? null,
  };
}

/**
 * First failure. Called from invoice.payment_failed, after the member has been
 * marked overdue. Also raises a staff task so the gym can have a conversation
 * instead of being surprised at the door.
 */
export async function recordPaymentFailure(
  supabaseAdmin: any,
  args: {
    dojoId: string;
    memberId: string;
    stripeInvoiceId: string;
    amountCents: number;
    currency: string;
    hostedInvoiceUrl: string | null;
    failedAt?: string | null;
  },
): Promise<void> {
  const ctx = await loadContext(supabaseAdmin, args.dojoId, args.memberId);
  // Cash members are not collected through Stripe; chasing them by email here
  // would be wrong.
  if (ctx.method === "cash") return;

  const firstFailedAt = args.failedAt ?? new Date().toISOString();
  const { finalDay } = dunningSchedule(ctx.graceDays);

  const sent = await claimAndSend(supabaseAdmin, {
    dojoId: args.dojoId,
    memberId: args.memberId,
    stage: "first",
    stripeInvoiceId: args.stripeInvoiceId,
    amountCents: args.amountCents,
    currency: args.currency,
    paymentMethod: ctx.method,
    hostedInvoiceUrl: args.hostedInvoiceUrl,
    firstFailedAt,
    daysLeft: finalDay,
    gymName: ctx.gymName,
    memberName: ctx.memberName,
  });
  if (!sent) return;

  try {
    await supabaseAdmin.from("internal_tasks").insert({
      dojo_id: args.dojoId,
      member_id: args.memberId,
      title: `Payment failed — ${ctx.memberName ?? "member"} (${money(args.amountCents, args.currency)})`,
      description: `A ${methodNoun(ctx.method)} payment of ${money(
        args.amountCents,
        args.currency,
      )} failed. The member has been emailed with a link to update their details. Access is restricted after ${finalDay} day(s) if it stays unpaid.`,
      status: "open",
    });
  } catch (e) {
    console.error("[dunning] staff task insert failed", e);
  }

  // The task above is the gym's record of it; this is how they actually hear.
  // Nothing in the app displays tasks yet, so without an email a failed
  // payment reached the gym only if someone happened to notice "overdue"
  // beside a name on the billing page.
  try {
    const { sendPaymentFailedAlert } = await import("@/lib/staff-notify.server");
    const res = await sendPaymentFailedAlert({
      dojoId: args.dojoId,
      memberId: args.memberId,
      amountCents: args.amountCents,
      currency: args.currency,
      hostedInvoiceUrl: args.hostedInvoiceUrl,
      attempt: "first",
    });
    if (!res.ok) console.error("[dunning] staff payment alert not sent:", res.error);
  } catch (e) {
    // The member has already been chased; the gym's copy must never undo that.
    console.error("[dunning] staff payment alert failed", e);
  }
}

/**
 * Payment recovered. Closes every open notice for the invoice and sends the
 * all-clear once — but only if we actually chased them, so a member who never
 * saw a failure notice never gets a confusing "it's sorted" email.
 *
 * `silent: true` closes the case WITHOUT the all-clear email. Used when a case
 * stops being chaseable for a reason other than payment (cancelled, lapsed,
 * subscription deleted, switched to cash) — telling those members "your payment
 * has gone through" would be a lie.
 */
export async function resolvePaymentRecovered(
  supabaseAdmin: any,
  args: {
    dojoId: string;
    memberId: string;
    stripeInvoiceId?: string | null;
    amountCents: number;
    currency: string;
    silent?: boolean;
  },
): Promise<void> {
  let q = supabaseAdmin
    .from("dunning_notices")
    .select("id, stripe_invoice_id, stage, amount_cents, currency, payment_method")
    .eq("member_id", args.memberId)
    .is("resolved_at", null)
    .in("stage", CHASE_STAGES);
  // A renewal invoice differs from the failed one, so recovery is scoped to the
  // member rather than the invoice unless we were given the same invoice.
  if (args.stripeInvoiceId) {
    const { data: sameInvoice } = await supabaseAdmin
      .from("dunning_notices")
      .select("id")
      .eq("stripe_invoice_id", args.stripeInvoiceId)
      .limit(1);
    if ((sameInvoice ?? []).length > 0) q = q.eq("stripe_invoice_id", args.stripeInvoiceId);
  }

  const { data: open, error } = await q;
  if (error) {
    console.error("[dunning] could not load open notices", error);
    return;
  }
  const rows = (open ?? []) as any[];
  if (rows.length === 0) return;

  const now = new Date().toISOString();
  await supabaseAdmin
    .from("dunning_notices")
    .update({ resolved_at: now })
    .in(
      "id",
      rows.map((r) => r.id),
    );

  // Close the staff task(s) raised for this member.
  try {
    await supabaseAdmin
      .from("internal_tasks")
      .update({ status: "done", completed_at: now })
      .eq("member_id", args.memberId)
      .eq("status", "open")
      .like("title", "Payment failed —%");
  } catch (e) {
    console.error("[dunning] closing staff task failed", e);
  }

  if (args.silent) return;

  const ctx = await loadContext(supabaseAdmin, args.dojoId, args.memberId);
  const invoiceId = rows[0]!.stripe_invoice_id as string;
  await claimAndSend(supabaseAdmin, {
    dojoId: args.dojoId,
    memberId: args.memberId,
    stage: "recovered",
    stripeInvoiceId: invoiceId,
    amountCents: args.amountCents || rows[0]!.amount_cents || 0,
    currency: args.currency || rows[0]!.currency || "usd",
    paymentMethod: ctx.method ?? rows[0]!.payment_method ?? null,
    hostedInvoiceUrl: null,
    firstFailedAt: now,
    daysLeft: 0,
    gymName: ctx.gymName,
    memberName: ctx.memberName,
  });
}

/**
 * Nightly: sends the mid-grace reminder and the final notice for cases that are
 * still open, using each gym's own grace period.
 */
export async function runDunningSweep(): Promise<{
  checked: number;
  reminders: number;
  finals: number;
  skipped: number;
}> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const out = { checked: 0, reminders: 0, finals: 0, skipped: 0 };

  const { data: open, error } = await supabaseAdmin
    .from("dunning_notices")
    .select(
      "dojo_id, member_id, stripe_invoice_id, amount_cents, currency, payment_method, hosted_invoice_url, first_failed_at, stage",
    )
    .is("resolved_at", null)
    .in("stage", CHASE_STAGES);
  if (error) {
    console.error("[dunning] sweep could not load open notices", error);
    return out;
  }

  // An archived gym is dormant: nobody there gets chased, escalated, or has
  // their status changed by this sweep.
  const { archivedDojoIds } = await import("@/lib/archived-dojos.server");
  const archived = await archivedDojoIds();

  // Collapse to one open case per failed invoice.
  const cases = new Map<string, any>();
  for (const row of (open ?? []) as any[]) {
    if (archived.has(row.dojo_id)) continue;
    const existing = cases.get(row.stripe_invoice_id);
    if (!existing || new Date(row.first_failed_at) < new Date(existing.first_failed_at)) {
      cases.set(row.stripe_invoice_id, row);
    }
  }

  for (const c of cases.values()) {
    out.checked += 1;
    const ctx = await loadContext(supabaseAdmin, c.dojo_id, c.member_id);


    // Anything that is no longer an unpaid Stripe member closes itself: paid up,
    // switched to cash, cancelled/lapsed, or no longer active.
    //
    // These closures are SILENT. The sweep cannot tell "they paid" from
    // "their subscription was cancelled after retries ran out", so it never
    // claims a payment arrived. The genuine all-clear is sent from
    // invoice.paid in the Stripe webhook, which is real proof of payment.
    const { data: member } = await supabaseAdmin
      .from("members")
      .select("payment_status, status, payment_method")
      .eq("id", c.member_id)
      .maybeSingle();
    const stillOwing =
      (member as any)?.payment_status === "overdue" || (member as any)?.payment_status === "due";
    if (!member || !stillOwing || (member as any).payment_method === "cash") {
      await resolvePaymentRecovered(supabaseAdmin, {
        dojoId: c.dojo_id,
        memberId: c.member_id,
        stripeInvoiceId: c.stripe_invoice_id,
        amountCents: c.amount_cents,
        currency: c.currency,
        silent: true,
      });
      out.skipped += 1;
      continue;
    }

    const { reminderDay, finalDay } = dunningSchedule(ctx.graceDays);
    const ageDays = Math.floor(
      (Date.now() - new Date(c.first_failed_at).getTime()) / (24 * 60 * 60 * 1000),
    );

    // Reminders reuse what the FIRST notice recorded. A first notice opened
    // from a bare invoice ID stored no amount and no payment link, so every
    // follow-up inherited "€0.00" -- and the zero-amount guard would now
    // refuse them outright, leaving the member with no reminder at all. Heal
    // the case from Stripe once, and write it back so it stays healed.
    let amountCents: number = Number(c.amount_cents ?? 0);
    let hostedInvoiceUrl: string | null = c.hosted_invoice_url ?? null;
    let currency: string = c.currency;
    if (!(amountCents > 0) || !hostedInvoiceUrl) {
      try {
        const { getPlatformStripe } = await import("@/lib/stripe-connect.server");
        const inv: any = await getPlatformStripe().invoices.retrieve(c.stripe_invoice_id);
        amountCents = Number(inv?.amount_due ?? inv?.amount_remaining ?? amountCents) || amountCents;
        hostedInvoiceUrl = inv?.hosted_invoice_url ?? hostedInvoiceUrl;
        currency = (inv?.currency ?? currency ?? "usd").toLowerCase();
        await supabaseAdmin
          .from("dunning_notices")
          .update({ amount_cents: amountCents, hosted_invoice_url: hostedInvoiceUrl, currency })
          .eq("stripe_invoice_id", c.stripe_invoice_id);
      } catch (e) {
        console.error("[dunning] could not heal case from Stripe", c.stripe_invoice_id, e);
      }
    }

    const base = {
      dojoId: c.dojo_id,
      memberId: c.member_id,
      stripeInvoiceId: c.stripe_invoice_id,
      amountCents,
      currency,
      paymentMethod: ctx.method ?? c.payment_method ?? null,
      hostedInvoiceUrl,
      firstFailedAt: c.first_failed_at,
      gymName: ctx.gymName,
      memberName: ctx.memberName,
    };

    if (ageDays >= finalDay) {
      if (await claimAndSend(supabaseAdmin, { ...base, stage: "final", daysLeft: 0 })) {
        out.finals += 1;
        // The last notice to the member is the point the gym most needs to
        // know: from here the member loses access, and a conversation at the
        // door beats a surprise.
        try {
          const { sendPaymentFailedAlert } = await import("@/lib/staff-notify.server");
          await sendPaymentFailedAlert({
            dojoId: c.dojo_id,
            memberId: c.member_id,
            amountCents,
            currency,
            hostedInvoiceUrl,
            attempt: "final",
          });
        } catch (e) {
          console.error("[dunning] staff final alert failed", e);
        }
      }
    } else if (ageDays >= reminderDay) {
      if (
        await claimAndSend(supabaseAdmin, {
          ...base,
          stage: "reminder",
          daysLeft: finalDay - ageDays,
        })
      ) {
        out.reminders += 1;
      }
    }
  }

  return out;
}
