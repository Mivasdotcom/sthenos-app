/**
 * Trial-ending reminder.
 *
 * The end of a free trial is the conversion moment, so we email the member
 * shortly before their window closes: how much is left, and a nudge to pick a
 * plan. Transactional (a trial they signed up for is expiring), suppression and
 * logging come from the shared pipeline, and `members.trial_reminder_sent_at`
 * makes it once-per-trial.
 */
import {
  freeAccessWindow, computeTrialStatus, dojoTodayIso, trialPolicyFromDojo } from "@/lib/trial-policy";
import { grossChargeCents } from "@/lib/platform-fee";
import { PUBLIC_SITE_URL } from "@/lib/site";

const portalUrl = `${PUBLIC_SITE_URL}/portal`;

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Same formatting as the welcome email, so the two agree to the cent. */
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


export async function runTrialEndingReminders(): Promise<{
  sent: number;
  skipped: number;
  failed: number;
}> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { sendAppEmail } = await import("@/lib/email-send.server");
  const { contactEmailFor } = await import("@/lib/minors");

  const out = { sent: 0, skipped: 0, failed: 0 };

  const { data: members } = await supabaseAdmin
    .from("members")
    .select(
      "id, dojo_id, name, email, date_of_birth, guardian_email, guardian_name, trial_started_at, free_trial_ends_at, trial_reminder_sent_at",
    )
    .eq("status", "trial")
    .is("trial_reminder_sent_at", null)
    // Either the attendance-based class trial has started, or the member is on a
    // signup free period (per-gym `signup_free_days`), which starts at signup.
    .or("trial_started_at.not.is.null,free_trial_ends_at.not.is.null");

  if (!members?.length) return out;

  const dojoIds = Array.from(new Set(members.map((m: any) => m.dojo_id)));
  const { data: dojos } = await supabaseAdmin
    .from("dojos")
    .select(
      "id, name, slug, timezone, archived_at, trial_length_days, trial_classes_per_day, trial_max_total_classes, signup_free_days, pass_platform_fee_to_members, trial_reminder_enabled",
    )
    .in("id", dojoIds);

  const dojoById = new Map((dojos ?? []).map((d: any) => [d.id, d]));

  // A member who picked a plan at signup already has a payment method captured
  // and a subscription whose deferred `trial_end` WILL charge them. They must
  // be told about that charge, not told to choose a plan. Same rows Stripe and
  // the welcome email use, so the three cannot disagree.
  const { data: subs } = await supabaseAdmin
    .from("member_subscriptions")
    .select(
      "member_id, plan_id, status, trial_end, payment_method, currency, dojo_plans:plan_id(name, price_cents, currency, interval)",
    )
    .in(
      "member_id",
      members.map((m: any) => m.id),
    )
    .in("status", ["trialing", "active"])
    .not("stripe_subscription_id", "is", null);
  const subByMember = new Map<string, any>();
  for (const s of (subs ?? []) as any[]) {
    if (!subByMember.has(s.member_id)) subByMember.set(s.member_id, s);
  }


  for (const m of members as any[]) {
    const dojo = dojoById.get(m.dojo_id);
    if (!dojo) {
      out.skipped++;
      continue;
    }
    // An archived gym is dormant: no trial emails, and no stamping, so nothing
    // is silently consumed if it is ever un-archived.
    if (dojo.archived_at) {
      out.skipped++;
      continue;
    }

    // Per-gym switch: a gym that explains the free period in person doesn't
    // want this email. Skip without stamping `trial_reminder_sent_at`, so
    // turning it back on later still reminds members who are still on trial.
    if (dojo.trial_reminder_enabled === false) {
      out.skipped++;
      continue;
    }
    const policy = trialPolicyFromDojo(dojo);
    // Each gym's trial day is counted in its own timezone.
    const timezone = dojo.timezone || "UTC";
    const fullAccess = freeAccessWindow({
      freeTrialEndsAt: m.free_trial_ends_at,
      timezone,
      days: dojo.signup_free_days,
    });
    if (!fullAccess && (policy.lengthDays == null || policy.lengthDays === 0)) {
      out.skipped++;
      continue;
    }

    const status = computeTrialStatus({
      memberId: m.id,
      policy,
      timezone,
      fullAccess,
      startDate: m.trial_started_at,
      date: dojoTodayIso(timezone),
      usedToday: 0,
      usedTotal: 0,
      upcoming: 0,
    });

    // Nudge on the day before the last day (or on the last day for a 1-day
    // trial), and never after the window has closed.
    const daysLeft = status.daysLeft;
    if (daysLeft == null || daysLeft > 2 || daysLeft < 1) {
      out.skipped++;
      continue;
    }

    const to = contactEmailFor(m);
    if (!to) {
      out.skipped++;
      continue;
    }

    const first = String(m.name ?? "there").split(" ")[0];
    const gymName = dojo.name || "your gym";
    const lastDay = status.endsOn
      ? new Date(status.endsOn + "T00:00:00Z").toLocaleDateString(undefined, {
          weekday: "long",
          day: "numeric",
          month: "long",
          timeZone: "UTC",
        })
      : null;

    const sub = subByMember.get(m.id) ?? null;
    const plan = sub?.dojo_plans ?? null;
    // "Committed" = plan chosen AND a payment method captured, i.e. the charge
    // is already going to happen automatically.
    const committed = !!(sub && plan && sub.payment_method);

    let html: string;
    let subject: string;

    if (committed) {
      const gross = grossChargeCents(
        Number(plan.price_cents ?? 0),
        !!dojo.pass_platform_fee_to_members,
      );
      const amount = gross > 0 ? money(gross, sub.currency || plan.currency || "gbp") : null;
      // Charge date comes from the subscription's own trial_end — the exact
      // value handed to Stripe at checkout — falling back to the trial window.
      const chargeDate = longDate(sub.trial_end) ?? lastDay;
      const when = daysLeft === 1 ? "finishes today" : lastDay ? `finishes on ${escapeHtml(lastDay)}` : "finishes tomorrow";

      subject = `Your membership at ${gymName} starts ${daysLeft === 1 ? "today" : "soon"}`;
      html = `
      <p>Hi ${escapeHtml(first)},</p>
      <p>Good news — your free trial at ${escapeHtml(gymName)} ${when}, and your membership carries straight on from there.${
        daysLeft > 1 ? " There's still time for another class before then." : ""
      }</p>
      <p>You chose <strong>${escapeHtml(String(plan.name ?? "your plan"))}</strong> when you signed up and your payment details are saved, so <strong>your first payment${
        amount ? ` of ${escapeHtml(amount)}` : ""
      } will be taken automatically${chargeDate ? ` on ${escapeHtml(chargeDate)}` : " when your trial finishes"}</strong>${
        dojo.pass_platform_fee_to_members ? " (this includes the platform fee)" : ""
      }. After that it's collected each ${escapeHtml(String(plan.interval ?? "month"))}.</p>
      <p><strong>If you'd like to carry on training, there's nothing for you to do</strong> — just turn up.</p>
      <p>If you'd rather not continue, you can cancel before then in your member portal under <strong>My plan</strong> and nothing will be taken: <a href="${portalUrl}">${portalUrl}</a></p>
      <p>Any questions at all, just reply to this email. See you on the mats.</p>
    `;
    } else {
      subject =
        daysLeft === 1
          ? `Your free trial at ${gymName} finishes today`
          : `Your free trial at ${gymName} finishes soon`;
      html = `
      <p>Hi ${escapeHtml(first)},</p>
      <p>Your free trial at ${escapeHtml(gymName)} ${
        daysLeft === 1 ? "finishes today" : `finishes ${lastDay ? `on ${escapeHtml(lastDay)}` : "tomorrow"}`
      }${daysLeft > 1 ? " — there's still time for another class" : ""}.</p>
      <p>To keep training after that, choose a plan in your member portal under <strong>My plan</strong>. It takes a minute and you can pick the plan that fits how often you train.</p>
      <p>If you've any questions about which plan suits you, just reply to this email.</p>
      <p>See you on the mats.</p>
    `;
    }

    const res = await sendAppEmail({
      dojoId: m.dojo_id,
      to,
      subject,
      html,
      templateName: "trial-ending",
      idempotencyKey: `trial-ending:${m.id}:${status.endsOn ?? status.date}`,
      marketing: false,
      memberId: m.id,
      metadata: { daysLeft, endsOn: status.endsOn, committed },
    });


    if (res.ok || res.pending) {
      await supabaseAdmin
        .from("members")
        .update({ trial_reminder_sent_at: new Date().toISOString() })
        .eq("id", m.id);
      out.sent++;
    } else {
      // Suppressed or no address is not a failure worth retrying nightly.
      console.warn("[trial-ending] not sent", { memberId: m.id, error: res.error });
      out.failed++;
    }
  }

  return out;
}
