// Welcome email for a completed public signup. This is the gym's first contact
// with a new member, so it has to say exactly what they just did — paid for a
// plan, or taken free trial classes — and what happens next.
//
// TRANSACTIONAL: it confirms a purchase and the start of a contract, so it goes
// out with `marketing: false` (no opt-out link) and is never blocked by a
// marketing unsubscribe. It still routes through `sendAppEmail`, so suppression
// (bounces/complaints), logging, retry and idempotency all apply.
//
// SENT ONCE PER SIGNUP: the provider dedupes on the idempotency key, and we
// additionally refuse to compose a second welcome when the log already shows
// one for this member — so a redelivered Stripe event or a re-run signup cannot
// welcome somebody twice.

import { PUBLIC_SITE_URL } from "@/lib/site";

export type WelcomeKind = "paid" | "trial";

const TEMPLATE = "signup-welcome";

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: (currency || "gbp").toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${(currency || "").toUpperCase()}`.trim();
  }
}

function longDate(iso: string | null | undefined) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function methodLabel(method: string | null | undefined) {
  switch (method) {
    case "sepa_debit":
      return "SEPA Direct Debit";
    case "bacs_debit":
      return "Direct Debit";
    case "cash":
      return "cash or bank transfer at the gym";
    default:
      return "card";
  }
}

/** Capitalised form for the summary table so values line up with plan names. */
function methodLabelTable(method: string | null | undefined) {
  switch (method) {
    case "sepa_debit":
      return "SEPA Direct Debit";
    case "bacs_debit":
      return "Direct Debit";
    case "cash":
      return "Cash or bank transfer at the gym";
    default:
      return "Card";
  }
}

function isDirectDebit(method: string | null | undefined) {
  return method === "sepa_debit" || method === "bacs_debit";
}

/** Already welcomed? Never send a second one for the same signup. */
async function alreadyWelcomed(supabaseAdmin: any, memberId: string): Promise<boolean> {
  try {
    const { data } = await supabaseAdmin
      .from("email_send_log")
      .select("id, status, metadata")
      .eq("template_name", TEMPLATE)
      .in("status", ["sent", "pending"])
      .contains("metadata", { member_id: memberId })
      .limit(1);
    return (data ?? []).length > 0;
  } catch (e) {
    // A log lookup failure must not silence the welcome — the provider
    // idempotency key is still a hard second line of defence.
    console.error("[welcome-email] dedupe lookup failed", e);
    return false;
  }
}

export async function sendSignupWelcome(args: {
  dojoId: string;
  memberId: string;
  kind: WelcomeKind;
  /** Amount actually charged at checkout, for paid signups. */
  amountCents?: number | null;
  currency?: string | null;
  /** The method they actually paid with ('card' | 'sepa_debit' | 'bacs_debit'). */
  paymentMethod?: string | null;
  /** When the NEXT payment is due (subscription period end). */
  nextPaymentAt?: string | null;
  /**
   * What will genuinely be collected on the renewal date — the RECURRING
   * subscription amount, never the (usually pro-rated) first charge. Sourced
   * independently of `amountCents` so the two rows cannot share one figure.
   */
  renewalAmountCents?: number | null;
  renewalCurrency?: string | null;
  /** True when the first direct-debit collection has not landed yet. */
  collectionPending?: boolean;
  /** Anchor for the first collection estimate — should be the subscription period start. */
  periodStartAt?: string | null;
  /**
   * A trial member who picked a plan at signup: their payment method is saved
   * but nothing is charged until the trial finishes. `atIso` is null while the
   * trial has not started (it starts at their first class), in which case we
   * promise a date later rather than inventing one.
   */
  trialFirstCharge?: {
    amountCents?: number | null;
    currency?: string | null;
    atIso?: string | null;
  } | null;

}): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  if (await alreadyWelcomed(supabaseAdmin, args.memberId)) {
    return { ok: true, skipped: "already sent" };
  }

  const [{ data: member }, { data: dojo }] = await Promise.all([
    supabaseAdmin
      .from("members")
      .select(
        "name, email, date_of_birth, guardian_email, guardian_name, selected_plan_id, payment_method, free_trial_ends_at, dojo_plans:selected_plan_id(name, price_cents, currency, interval)",
      )
      .eq("id", args.memberId)
      .maybeSingle(),
    supabaseAdmin
      .from("dojos")
      .select(
        "name, slug, timezone, signup_free_days, trial_length_days, trial_classes_per_day, trial_max_total_classes",
      )
      .eq("id", args.dojoId)
      .maybeSingle(),
  ]);


  if (!member) return { ok: false, error: "Member not found" };

  const { contactEmailFor } = await import("@/lib/minors");
  const to = contactEmailFor(member as any);
  if (!to) return { ok: false, error: "No email address on file" };

  const gymName = (dojo as any)?.name || "your gym";
  const plan = (member as any)?.dojo_plans ?? null;
  const firstName = String((member as any).name ?? "").trim().split(/\s+/)[0] || "there";
  const portalUrl = `${PUBLIC_SITE_URL}/portal`;
  const method = args.paymentMethod ?? (member as any).payment_method ?? "card";

  const rows: string[] = [];
  const paras: string[] = [];

  if (args.kind === "paid") {
    // 1. What was actually charged at checkout — usually a pro-rata amount.
    const amount =
      typeof args.amountCents === "number" && args.amountCents > 0
        ? money(args.amountCents, args.currency || plan?.currency || "gbp")
        : plan?.price_cents
          ? money(plan.price_cents, plan.currency || "gbp")
          : null;

    // 2. What will be collected on the renewal date. INDEPENDENT of the charge
    // above: the recurring subscription amount, else the plan price, else no
    // figure at all. Never the pro-rated first charge — that understates the
    // real monthly amount on almost every signup.
    const renewalAmount =
      typeof args.renewalAmountCents === "number" && args.renewalAmountCents > 0
        ? money(args.renewalAmountCents, args.renewalCurrency || plan?.currency || "gbp")
        : plan?.price_cents
          ? money(plan.price_cents, plan.currency || "gbp")
          : null;

    const nextDate = longDate(args.nextPaymentAt);

    paras.push(
      `Welcome to ${escapeHtml(gymName)}, ${escapeHtml(firstName)} — your membership is set up and you're good to train.`,
    );

    if (plan?.name) rows.push(["Plan", escapeHtml(String(plan.name))].join("|"));

    const ddPending = isDirectDebit(method) && !!args.collectionPending;
    let expectedFirst: Date | null = null;
    if (ddPending) {
      const { expectedFirstCollectionDate } = await import("@/lib/payment-methods");
      const anchor = args.periodStartAt ? new Date(args.periodStartAt) : new Date();
      expectedFirst = expectedFirstCollectionDate(anchor, method) ?? null;
    }
    const nextAt = args.nextPaymentAt ? new Date(args.nextPaymentAt) : null;
    const nextValid = nextAt && !Number.isNaN(nextAt.getTime()) ? nextAt : null;
    // Direct-debit lead time can push the first collection past the renewal
    // date, which reads as two rows going backwards in time. Combine them.
    const collectionsOverlap = !!(expectedFirst && nextValid && expectedFirst >= nextValid);

    if (collectionsOverlap) {
      const expectedWhen = longDate(expectedFirst!.toISOString());
      rows.push(["Payment method", escapeHtml(methodLabelTable(method))].join("|"));
      rows.push(
        [
          "First collections",
          `${amount ? `${escapeHtml(amount)} pro-rata` : "Your pro-rata amount"}${
            renewalAmount ? `, then ${escapeHtml(renewalAmount)}` : ""
          } — both around ${escapeHtml(expectedWhen ?? "the next few working days")}`,
        ].join("|"),
      );
      paras.push(
        `Because you joined just before your billing date, the small pro-rata amount for the rest of this month and your first full ${escapeHtml(String(plan?.interval ?? "month"))} will be collected close together${
          nextDate ? ` (your billing date is ${escapeHtml(nextDate)})` : ""
        }. After that it settles into one regular collection${renewalAmount ? ` of ${escapeHtml(renewalAmount)}` : ""}.`,
      );
    } else {
      if (amount) {
        // A direct debit whose first collection has not cleared has NOT been
        // paid — labelling it "Paid today" contradicts the mandate paragraph.
        if (ddPending) {
          const when = expectedFirst ? longDate(expectedFirst.toISOString()) : null;
          rows.push(
            [
              "First collection",
              `${escapeHtml(amount)}${when ? ` · expected ${escapeHtml(when)}` : " · in a few working days"}`,
            ].join("|"),
          );
        } else {
          rows.push(["Paid today", escapeHtml(amount)].join("|"));
        }
      }

      rows.push(["Payment method", escapeHtml(methodLabel(method))].join("|"));
      if (nextDate)
        rows.push(
          [
            "Next payment",
            `${escapeHtml(nextDate)}${renewalAmount ? ` · ${escapeHtml(renewalAmount)}` : ""}`,
          ].join("|"),
        );
    }

    if (isDirectDebit(method)) {
      // Direct debit is not instant, and a member who sees "paid" but no money
      // leaving their account will otherwise assume something went wrong.
      paras.push(
        args.collectionPending
          ? `You've set up ${escapeHtml(methodLabel(method))}, so nothing has left your account yet. Your mandate is being confirmed with your bank and the first collection usually takes about three working days to appear — you'll see it on your statement as ${escapeHtml(gymName)}. Nothing more for you to do.`
          : `Your ${escapeHtml(methodLabel(method))} is set up, and future payments will be collected automatically on the date above.`,
      );

    } else {
      paras.push(
        `Payments are collected automatically from your card${nextDate ? `, next on ${escapeHtml(nextDate)}` : ""}. You can change your card or view your payments any time in your member portal.`,
      );
    }
  } else {
    const {
      trialPolicyFromDojo,
      trialPolicyLabel,
      trialPolicyDescription,
      trialOffered,
      freeAccessWindow,
    } = await import("@/lib/trial-policy");
    const policy = trialPolicyFromDojo(dojo);
    const offered = trialOffered(policy);
    const label = trialPolicyLabel(policy) ?? "Trial";
    const perDay =
      policy.perDay === 1 ? "one class a day" : `up to ${policy.perDay} classes a day`;
    // SIGNUP FREE PERIOD: the same rolling window the portal and Stripe use, so
    // the email never describes an attendance clock this member doesn't have.
    const freeWindow = freeAccessWindow({
      freeTrialEndsAt: (member as any)?.free_trial_ends_at ?? null,
      timezone: (dojo as any)?.timezone ?? null,
      days: (dojo as any)?.signup_free_days ?? null,
    });

    if (freeWindow) {
      paras.push(
        `Welcome to ${escapeHtml(gymName)}, ${escapeHtml(firstName)} — you're registered and your first ${freeWindow.days} days are free.`,
      );
      rows.push(
        ["Your free period", escapeHtml(`${freeWindow.days} days, full access`)].join("|"),
      );
      rows.push(
        [
          "How it works",
          escapeHtml(
            `Train as much as you like until ${longDate(freeWindow.endsAt) ?? "the end of your free period"} — no class limits`,
          ),
        ].join("|"),
      );
      rows.push(["Paid today", "Nothing"].join("|"));
    } else {
      paras.push(
        `Welcome to ${escapeHtml(gymName)}, ${escapeHtml(firstName)} — you're registered and your ${offered ? escapeHtml(label.toLowerCase()) : "trial"} is ready to use.`,
      );
      rows.push(
        ["Your trial", offered ? escapeHtml(label) : "Trial — speak to us at the gym"].join("|"),
      );
      if (offered && policy.lengthDays != null && policy.lengthDays > 1) {
        rows.push(
          [
            "How it works",
            escapeHtml(
              `${perDay} for ${policy.lengthDays} days, starting from your first class`,
            ),
          ].join("|"),
        );
      } else if (offered && policy.maxTotal != null) {
        rows.push(["How it works", escapeHtml(`${policy.maxTotal} class${policy.maxTotal === 1 ? "" : "es"} in total`)].join("|"));
      }
      rows.push(["Paid today", "Nothing — your trial is free"].join("|"));
    }


    // Plan chosen at signup, charge deferred to the end of the trial (or, on a
    // signup free period, to the exact end of that rolling window).
    const deferred = args.trialFirstCharge ?? null;
    if (deferred) {
      const deferredAmount =
        typeof deferred.amountCents === "number" && deferred.amountCents > 0
          ? money(deferred.amountCents, deferred.currency || plan?.currency || "gbp")
          : plan?.price_cents
            ? money(plan.price_cents, plan.currency || "gbp")
            : null;
      const deferredDate = longDate(freeWindow ? freeWindow.endsAt : deferred.atIso);
      if (plan?.name) rows.push(["Plan chosen", escapeHtml(String(plan.name))].join("|"));
      rows.push(["Payment method", escapeHtml(methodLabelTable(method))].join("|"));
      rows.push(
        [
          "First payment",
          `${deferredAmount ? escapeHtml(deferredAmount) : "Your plan price"} · ${
            deferredDate
              ? `on ${escapeHtml(deferredDate)}`
              : freeWindow
                ? "when your free period finishes"
                : "when your trial finishes"
          }`,
        ].join("|"),
      );
      paras.push(
        freeWindow
          ? `You've chosen ${plan?.name ? `<strong>${escapeHtml(String(plan.name))}</strong>` : "a plan"} and saved your ${escapeHtml(methodLabel(method))} details, but <strong>nothing is due today</strong>. Your free period runs until ${deferredDate ? escapeHtml(deferredDate) : "the end of your free days"}, when your first payment${deferredAmount ? ` of ${escapeHtml(deferredAmount)}` : ""} is taken automatically.`
          : `You've chosen ${plan?.name ? `<strong>${escapeHtml(String(plan.name))}</strong>` : "a plan"} and saved your ${escapeHtml(methodLabel(method))} details, but <strong>nothing is due today</strong>. Your first payment${deferredAmount ? ` of ${escapeHtml(deferredAmount)}` : ""} is only taken once your free trial has finished${
              deferredDate ? `, on ${escapeHtml(deferredDate)}` : " — your trial starts at your first class, so we'll confirm the exact date then"
            }.`,
      );
    }
    paras.push(
      freeWindow
        ? `Book your first class in your member portal under <strong>Book a class</strong> — pick any session on the timetable and you're on the list. Train as often as you like during your free days; there are no class limits.`
        : `Book your first class in your member portal under <strong>Book a class</strong> — pick any session on the timetable and you're on the list. ${
            args.trialFirstCharge
              ? "There's nothing to pay for your trial classes."
              : "There's nothing to pay and no card needed."
          } ${escapeHtml(trialPolicyDescription(policy))}`,
    );
    paras.push(
      freeWindow
        ? `Your free days run from today, so come as often as you like. Your membership then carries on automatically, and you can see and change everything — including cancelling before that first payment — in the portal under <strong>My plan</strong>.`
        : args.trialFirstCharge
          ? `Your trial clock starts on your first class, not today — so come when it suits you. Your membership then carries on automatically, and you can see and change everything in the portal under <strong>My plan</strong>.`
          : `Your trial clock starts on your first class, not today — so come when it suits you. When it's finished, choose a plan in the portal under <strong>My plan</strong> to keep training. We'll never charge you automatically after a trial.`,
    );

  }

  paras.push(
    `<strong>Getting started:</strong> everything lives in your member portal — book classes, see the sessions you've attended, read the waiver you signed and check your plan and payments. Just log in with the email address this was sent to.`,
  );
  paras.push(`Any questions, reply to this email and it comes straight to us. See you on the mats.`);

  const rowsHtml = rows
    .map((r) => {
      const [label, value] = r.split("|");
      return `<tr><td style="padding:6px 14px 6px 0;color:#6B7280;font-size:13px;white-space:nowrap">${label}</td><td style="padding:6px 0;color:#111827;font-size:14px;font-weight:600">${value}</td></tr>`;
    })
    .join("");

  const subject =
    args.kind === "paid"
      ? `Welcome to ${gymName} — your membership is active`
      : args.trialFirstCharge
        ? `Welcome to ${gymName} — your free trial is ready (nothing to pay today)`
        : `Welcome to ${gymName} — your free trial is ready`;

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.55;color:#1b1b1b">
  <h2 style="font-size:19px;margin:0 0 16px">${escapeHtml(subject)}</h2>
  ${paras.map((p) => `<p style="margin:0 0 14px">${p}</p>`).join("")}
  ${rowsHtml ? `<table role="presentation" style="margin:4px 0 20px;border-collapse:collapse">${rowsHtml}</table>` : ""}
  <p style="margin:0 0 22px">
    <a href="${portalUrl}" style="background:#C2410C;color:#ffffff;font-size:14px;font-weight:700;border-radius:8px;padding:12px 20px;text-decoration:none;display:inline-block">Open my member portal</a>
  </p>
  <p style="margin:0;font-size:13px;color:#6B7280">${escapeHtml(gymName)} · <a href="${portalUrl}" style="color:#C2410C">${portalUrl}</a></p>
</div>`;

  const { sendAppEmail } = await import("@/lib/email-send.server");
  const res = await sendAppEmail({
    dojoId: args.dojoId,
    to,
    subject,
    html,
    templateName: TEMPLATE,
    idempotencyKey: `signup-welcome:${args.memberId}`,
    marketing: false,
    memberId: args.memberId,
    metadata: { welcome_kind: args.kind },
  });

  if ((res as any)?.ok) return { ok: true };
  return { ok: false, error: String((res as any)?.error ?? "Email send failed") };
}
