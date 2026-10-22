import { PUBLIC_SITE_URL } from "@/lib/site";

/**
 * Emails to the people who run a gym, as opposed to its members.
 *
 * A gym owner finds out about a new member when they next open the app, which
 * at a small gym can be days. The signup alert closes that gap: it goes to the
 * owner and every admin the moment someone joins, with enough detail to act on
 * -- who they are, whether a parent signed up a child, and whether money has
 * actually been taken yet.
 *
 * Never let one of these fail a signup: the member is already registered by
 * the time we get here, and an unsent notification is a far smaller problem
 * than a signup that appears to have broken.
 */

const TEMPLATE = "staff-new-signup";
const FAILED_PAYMENT_TEMPLATE = "staff-payment-failed";
const CANCELLATION_TEMPLATE = "staff-cancellation-requested";
const CHARGEBACK_TEMPLATE = "staff-chargeback";

/** The dark green button every one of these emails ends with. */
function actionButton(href: string, label: string): string {
  return `<p style="margin:0 0 22px">
    <a href="${href}" style="background:#C2410C;color:#ffffff;font-size:14px;font-weight:700;border-radius:8px;padding:12px 20px;text-decoration:none;display:inline-block">${escapeHtml(label)}</a>
  </p>`;
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function ageFrom(dob: string | null | undefined): number | null {
  if (!dob) return null;
  const d = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < d.getUTCMonth() ||
    (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 120 ? age : null;
}

/** Owner and admins of a gym, by email address, deduplicated. */
async function staffRecipients(db: any, dojoId: string): Promise<string[]> {
  const emails = new Set<string>();

  const { data: staff } = await db
    .from("dojo_memberships")
    .select("user_id, role")
    .eq("dojo_id", dojoId)
    .in("role", ["owner", "admin"]);

  for (const row of (staff ?? []) as { user_id: string }[]) {
    if (!row.user_id) continue;
    const { data: prof } = await db
      .from("profiles")
      .select("email")
      .eq("user_id", row.user_id)
      .maybeSingle();
    let email = (prof?.email ?? "").trim();
    if (!email) {
      // A staff account that predates the profiles table still has its
      // address on the auth user.
      const { data: authUser } = await db.auth.admin.getUserById(row.user_id);
      email = (authUser?.user?.email ?? "").trim();
    }
    if (email) emails.add(email.toLowerCase());
  }

  if (emails.size === 0) {
    // No staff address on file -- fall back to whatever the gym published.
    const { data: dojo } = await db
      .from("dojos")
      .select("contact_email")
      .eq("id", dojoId)
      .maybeSingle();
    const fallback = (dojo?.contact_email ?? "").trim();
    if (fallback) emails.add(fallback.toLowerCase());
  }

  return [...emails];
}

export async function sendNewSignupAlert(args: {
  dojoId: string;
  memberId: string;
  /** The plan they chose, when the caller knows it. */
  planName?: string | null;
  /**
   * How the signup was paid for, so the gym knows whether to expect money:
   * 'trial' (nothing due yet), 'paid' (charged), 'checkout' (sent to Stripe,
   * not yet confirmed) or 'none'.
   */
  payment?: "trial" | "paid" | "checkout" | "none";
  /** Where they came from: the public signup page, or a parent's portal. */
  via?: "signup" | "portal";
}): Promise<{ ok: boolean; sent: number; error?: string }> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: member } = await supabaseAdmin
      .from("members")
      .select("id, name, email, phone, date_of_birth, plan, guardian_name, guardian_email, trains")
      .eq("id", args.memberId)
      .eq("dojo_id", args.dojoId)
      .maybeSingle();
    if (!member) return { ok: false, sent: 0, error: "Member not found" };

    const to = await staffRecipients(supabaseAdmin, args.dojoId);
    if (to.length === 0) return { ok: false, sent: 0, error: "No staff address on file" };

    const name = (member.name ?? "New member").trim();
    const age = ageFrom(member.date_of_birth);
    const isChild = age != null && age < 18;
    const guardian = (member.guardian_name ?? "").trim();

    const rows: Array<[string, string]> = [];
    rows.push(["Name", name]);
    if (age != null) rows.push(["Age", `${age}${isChild ? " — under 18" : ""}`]);
    if (isChild && guardian) rows.push(["Parent or guardian", guardian]);
    const contact = (member.email ?? member.guardian_email ?? "").trim();
    if (contact) rows.push(["Email", contact]);
    if (member.phone) rows.push(["Phone", String(member.phone)]);
    const plan = (args.planName ?? member.plan ?? "").toString().trim();
    if (plan) rows.push(["Plan", plan]);
    if (member.trains === false) rows.push(["Trains", "No — parent or guardian account"]);

    const paymentLine =
      args.payment === "paid"
        ? "Payment taken."
        : args.payment === "checkout"
          ? "Sent to checkout — you will get a payment confirmation separately if it completes."
          : args.payment === "trial"
            ? "Free trial. Nothing has been charged."
            : "No payment taken.";
    rows.push(["Payment", paymentLine]);

    const memberUrl = `${PUBLIC_SITE_URL}/members/${member.id}`;
    const subject = isChild
      ? `New signup: ${name} (child)`
      : `New signup: ${name}`;
    const lead =
      args.via === "portal"
        ? `${guardian || "A parent"} has added a child to their account.`
        : isChild
          ? `${guardian || "A parent"} has signed ${name} up.`
          : `${name} has just signed up.`;

    const rowsHtml = rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:4px 16px 4px 0;color:#6B7280;font-size:14px">${escapeHtml(k)}</td><td style="padding:4px 0;font-size:14px">${escapeHtml(v)}</td></tr>`,
      )
      .join("");

    const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.55;color:#1b1b1b">
  <h2 style="font-size:19px;margin:0 0 16px">${escapeHtml(subject)}</h2>
  <p style="margin:0 0 14px">${escapeHtml(lead)}</p>
  <table role="presentation" style="margin:4px 0 20px;border-collapse:collapse">${rowsHtml}</table>
  <p style="margin:0 0 22px">
    <a href="${memberUrl}" style="background:#C2410C;color:#ffffff;font-size:14px;font-weight:700;border-radius:8px;padding:12px 20px;text-decoration:none;display:inline-block">Open their profile</a>
  </p>
  <p style="margin:0;font-size:13px;color:#6B7280">You are receiving this because you run this gym on Sthenos.</p>
</div>`;

    const { sendAppEmail } = await import("@/lib/email-send.server");
    let sent = 0;
    let firstError: string | null = null;
    for (const address of to) {
      const res = await sendAppEmail({
        dojoId: args.dojoId,
        to: address,
        subject,
        html,
        templateName: TEMPLATE,
        // Per recipient, so a retry can never double-send to anyone, and
        // adding an admin later does not resend the old ones.
        idempotencyKey: `staff-new-signup:${member.id}:${address}`,
        marketing: false,
        memberId: member.id,
        metadata: { via: args.via ?? "signup", payment: args.payment ?? "none" },
      });
      if ((res as any)?.ok) sent += 1;
      else if (!firstError) firstError = String((res as any)?.error ?? "send failed");
    }

    return sent > 0
      ? { ok: true, sent }
      : { ok: false, sent: 0, error: firstError ?? "No email sent" };
  } catch (e: any) {
    return { ok: false, sent: 0, error: e?.message ?? String(e) };
  }
}

/**
 * Tell the gym a member's payment has failed.
 *
 * The member already gets an email with a link to fix their card, and a staff
 * task is raised -- but nothing in the app displays those tasks, so the gym
 * learned about a failed payment by noticing "overdue" beside a name, or not
 * at all. One FTBJJ member trained for four days on a payment nobody knew had
 * bounced.
 *
 * Deliberately not alarming: the member has been asked to fix it and Stripe
 * will retry. What the gym needs is to know, and to be able to have a quiet
 * word at the door.
 */
export async function sendPaymentFailedAlert(args: {
  dojoId: string;
  memberId: string;
  amountCents: number;
  currency: string;
  /** Stripe's hosted invoice, where the member can pay right away. */
  hostedInvoiceUrl?: string | null;
  /** Which attempt this is, so a retry failing reads differently from the first. */
  attempt?: "first" | "retry" | "final";
}): Promise<{ ok: boolean; sent: number; error?: string }> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: member } = await supabaseAdmin
      .from("members")
      .select("id, name, email, guardian_email, guardian_name, phone")
      .eq("id", args.memberId)
      .eq("dojo_id", args.dojoId)
      .maybeSingle();
    if (!member) return { ok: false, sent: 0, error: "Member not found" };

    const to = await staffRecipients(supabaseAdmin, args.dojoId);
    if (to.length === 0) return { ok: false, sent: 0, error: "No staff address on file" };

    const name = (member.name ?? "A member").trim();
    const amount = (() => {
      try {
        return new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: (args.currency || "eur").toUpperCase(),
        }).format(args.amountCents / 100);
      } catch {
        return `${(args.currency || "eur").toUpperCase()} ${(args.amountCents / 100).toFixed(2)}`;
      }
    })();

    const lead =
      args.attempt === "final"
        ? `${name}'s payment of ${amount} has failed for the last time — Stripe has stopped retrying.`
        : args.attempt === "retry"
          ? `${name}'s payment of ${amount} failed again on a retry.`
          : `${name}'s payment of ${amount} has failed.`;

    const contact = (member.email ?? member.guardian_email ?? "").trim();
    const rows: Array<[string, string]> = [["Member", name], ["Amount", amount]];
    if (member.guardian_name) rows.push(["Parent or guardian", String(member.guardian_name)]);
    if (contact) rows.push(["Email", contact]);
    if (member.phone) rows.push(["Phone", String(member.phone)]);

    const rowsHtml = rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:4px 16px 4px 0;color:#6B7280;font-size:14px">${escapeHtml(k)}</td><td style="padding:4px 0;font-size:14px">${escapeHtml(v)}</td></tr>`,
      )
      .join("");

    const memberUrl = `${PUBLIC_SITE_URL}/members/${member.id}`;
    const subject = `Payment failed: ${name} (${amount})`;
    const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.55;color:#1b1b1b">
  <h2 style="font-size:19px;margin:0 0 16px">${escapeHtml(subject)}</h2>
  <p style="margin:0 0 14px">${escapeHtml(lead)}</p>
  <table role="presentation" style="margin:4px 0 20px;border-collapse:collapse">${rowsHtml}</table>
  <p style="margin:0 0 14px">They have been emailed a link to update their card${
    args.attempt === "final" ? "" : ", and Stripe will keep retrying for a few days"
  }. Nothing is needed from you unless it stays unpaid.</p>
  ${
    args.hostedInvoiceUrl
      ? // The member has this link already, in their own email. It is repeated
        // here so the gym can hand it over in person or forward it in the
        // thread they are already in, rather than telling them to go and find
        // an email they may have deleted.
        `<div style="margin:0 0 18px;padding:12px 14px;border:1px solid #e5e7eb;border-radius:8px;background:#f9fafb">
    <div style="font-size:13px;color:#374151">Their payment link — the same one they were sent, safe to forward:</div>
    <div style="margin-top:6px;font-size:13px;word-break:break-all"><a href="${args.hostedInvoiceUrl}" style="color:#C2410C">${escapeHtml(args.hostedInvoiceUrl)}</a></div>
  </div>`
      : ""
  }
  ${actionButton(memberUrl, "Open their profile")}
  <p style="margin:0;font-size:13px;color:#6B7280">You are receiving this because you run this gym on Sthenos.</p>
</div>`;

    const { sendAppEmail } = await import("@/lib/email-send.server");
    let sent = 0;
    let firstError: string | null = null;
    for (const address of to) {
      const res = await sendAppEmail({
        dojoId: args.dojoId,
        to: address,
        subject,
        html,
        templateName: FAILED_PAYMENT_TEMPLATE,
        // Per member, per attempt, per recipient: a redelivered webhook must
        // not send twice, but a genuine second failure must still get through.
        idempotencyKey: `staff-payment-failed:${member.id}:${args.attempt ?? "first"}:${args.amountCents}:${address}`,
        marketing: false,
        memberId: member.id,
        metadata: { attempt: args.attempt ?? "first" },
      });
      if ((res as any)?.ok) sent += 1;
      else if (!firstError) firstError = String((res as any)?.error ?? "send failed");
    }

    return sent > 0
      ? { ok: true, sent }
      : { ok: false, sent: 0, error: firstError ?? "No email sent" };
  } catch (e: any) {
    return { ok: false, sent: 0, error: e?.message ?? String(e) };
  }
}

/**
 * A member has given notice.
 *
 * The most time-critical thing that happens at a gym, and the only trace was a
 * badge on a menu item: the member's own confirmation went out, the request
 * landed in the database, and the owner found out whenever he next opened the
 * app. The window to ring someone and keep them is days.
 *
 * The reason they gave is included. It is usually the whole story -- price,
 * schedule, an injury -- and it decides whether the call is worth making.
 */
export async function sendCancellationRequestAlert(args: {
  dojoId: string;
  memberId: string;
  reason?: string | null;
}): Promise<{ ok: boolean; sent: number; error?: string }> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: member } = await supabaseAdmin
      .from("members")
      .select(
        "id, name, email, phone, guardian_name, guardian_email, plan, joined_at, cancellation_reason",
      )
      .eq("id", args.memberId)
      .eq("dojo_id", args.dojoId)
      .maybeSingle();
    if (!member) return { ok: false, sent: 0, error: "Member not found" };

    const to = await staffRecipients(supabaseAdmin, args.dojoId);
    if (to.length === 0) return { ok: false, sent: 0, error: "No staff address on file" };

    const name = (member.name ?? "A member").trim();
    const reason = (args.reason ?? member.cancellation_reason ?? "").trim();

    const rows: Array<[string, string]> = [["Member", name]];
    if (member.plan) rows.push(["Plan", String(member.plan)]);
    if (member.joined_at) {
      rows.push([
        "Member since",
        new Date(member.joined_at).toLocaleDateString(undefined, {
          day: "numeric",
          month: "long",
          year: "numeric",
        }),
      ]);
    }
    if (member.guardian_name) rows.push(["Parent or guardian", String(member.guardian_name)]);
    const contact = (member.email ?? member.guardian_email ?? "").trim();
    if (contact) rows.push(["Email", contact]);
    if (member.phone) rows.push(["Phone", String(member.phone)]);

    const rowsHtml = rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:4px 16px 4px 0;color:#6B7280;font-size:14px">${escapeHtml(k)}</td><td style="padding:4px 0;font-size:14px">${escapeHtml(v)}</td></tr>`,
      )
      .join("");

    const subject = `${name} has asked to cancel`;
    const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.55;color:#1b1b1b">
  <h2 style="font-size:19px;margin:0 0 16px">${escapeHtml(subject)}</h2>
  <p style="margin:0 0 14px">${escapeHtml(name)} has given notice through their member portal. Nothing has been cancelled yet — you decide when their membership ends.</p>
  <table role="presentation" style="margin:4px 0 20px;border-collapse:collapse">${rowsHtml}</table>
  ${
    reason
      ? `<div style="margin:0 0 18px;padding:12px 14px;border-left:3px solid #C2410C;background:#f9fafb">
    <div style="font-size:13px;color:#6B7280">Reason they gave</div>
    <div style="margin-top:4px">${escapeHtml(reason)}</div>
  </div>`
      : `<p style="margin:0 0 18px;font-size:13px;color:#6B7280">They didn't give a reason.</p>`
  }
  ${actionButton(`${PUBLIC_SITE_URL}/cancellations`, "Review cancellations")}
  <p style="margin:0 0 14px;font-size:13px">Or go straight to <a href="${PUBLIC_SITE_URL}/members/${member.id}" style="color:#C2410C">${escapeHtml(name)}'s profile</a>.</p>
  <p style="margin:0;font-size:13px;color:#6B7280">You are receiving this because you run this gym on Sthenos.</p>
</div>`;

    const { sendAppEmail } = await import("@/lib/email-send.server");
    let sent = 0;
    let firstError: string | null = null;
    for (const address of to) {
      const res = await sendAppEmail({
        dojoId: args.dojoId,
        to: address,
        subject,
        html,
        templateName: CANCELLATION_TEMPLATE,
        // A member who withdraws and gives notice again is a new event worth
        // hearing about, so the day forms part of the key.
        idempotencyKey: `staff-cancellation:${member.id}:${new Date().toISOString().slice(0, 10)}:${address}`,
        marketing: false,
        memberId: member.id,
      });
      if ((res as any)?.ok) sent += 1;
      else if (!firstError) firstError = String((res as any)?.error ?? "send failed");
    }

    return sent > 0
      ? { ok: true, sent }
      : { ok: false, sent: 0, error: firstError ?? "No email sent" };
  } catch (e: any) {
    return { ok: false, sent: 0, error: e?.message ?? String(e) };
  }
}

/**
 * A member has charged a payment back.
 *
 * Rare, urgent and on a clock: the money has already left the platform
 * balance, Stripe adds its dispute fee whichever way it goes, and evidence is
 * due by a date that passes quietly. A dashboard panel only helps someone who
 * opens the dashboard, so this goes out by email with the deadline in it and a
 * link straight to the dispute in Stripe, which is the only place it can be
 * answered.
 */
export async function sendChargebackAlert(args: {
  dojoId: string;
  memberId: string | null;
  disputeId: string;
  amountCents: number;
  currency: string;
  reason?: string | null;
  evidenceDueBy?: string | null;
  /** Stripe's dispute status, so an already-decided one doesn't ask for evidence. */
  status?: string | null;
}): Promise<{ ok: boolean; sent: number; error?: string }> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const to = await staffRecipients(supabaseAdmin, args.dojoId);
    if (to.length === 0) return { ok: false, sent: 0, error: "No staff address on file" };

    let memberName = "A member";
    if (args.memberId) {
      const { data: m } = await supabaseAdmin
        .from("members")
        .select("name")
        .eq("id", args.memberId)
        .maybeSingle();
      if (m?.name) memberName = String(m.name);
    }

    const amount = (() => {
      try {
        return new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: (args.currency || "eur").toUpperCase(),
        }).format(args.amountCents / 100);
      } catch {
        return `${(args.currency || "eur").toUpperCase()} ${(args.amountCents / 100).toFixed(2)}`;
      }
    })();

    const due = args.evidenceDueBy
      ? new Date(args.evidenceDueBy).toLocaleDateString(undefined, {
          weekday: "long",
          day: "numeric",
          month: "long",
        })
      : null;

    // Some card networks open and close a dispute in one go, so the alert must
    // not tell a gym to gather evidence for something already decided.
    const decided = args.status === "won" || args.status === "lost";

    const { disputeDashboardUrl } = await import("@/lib/refunds.server");
    const disputeUrl = disputeDashboardUrl(args.disputeId);

    const subject = `Chargeback: ${memberName} (${amount})`;
    const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.55;color:#1b1b1b">
  <h2 style="font-size:19px;margin:0 0 16px">${escapeHtml(subject)}</h2>
  <p style="margin:0 0 14px">${escapeHtml(memberName)} has disputed a payment of ${escapeHtml(amount)} with their bank${
    args.reason ? ` (reason given: ${escapeHtml(String(args.reason).replace(/_/g, " "))})` : ""
  }. The money has already been taken back, and Stripe charges a dispute fee whichever way it goes.</p>
  ${
    decided
      ? `<p style="margin:0 0 14px">This one is already closed${
          args.status === "won"
            ? " in your favour — the money comes back"
            : args.status === "lost"
              ? " against you — the payment stays reversed"
              : ""
        }, so there is nothing to submit. It is here so you know it happened.</p>`
      : due
        ? `<p style="margin:0 0 14px"><strong>Evidence is due by ${escapeHtml(due)}.</strong> If nothing is submitted, the dispute is lost by default.</p>`
        : `<p style="margin:0 0 14px">Stripe will give you a deadline for submitting evidence. If nothing is submitted, the dispute is lost by default.</p>`
  }
  ${
    decided
      ? ""
      : `<p style="margin:0 0 14px">Disputes are answered in Stripe rather than in Sthenos — attendance records, their signed waiver and your messages with them are the usual evidence.</p>`
  }
  ${actionButton(disputeUrl, decided ? "See it in Stripe" : "Open the dispute in Stripe")}
  ${
    args.memberId
      ? `<p style="margin:0 0 14px;font-size:13px">Their record in Sthenos: <a href="${PUBLIC_SITE_URL}/members/${args.memberId}" style="color:#C2410C">${escapeHtml(memberName)}'s profile</a>.</p>`
      : ""
  }
  <p style="margin:0;font-size:13px;color:#6B7280">You are receiving this because you run this gym on Sthenos.</p>
</div>`;

    const { sendAppEmail } = await import("@/lib/email-send.server");
    let sent = 0;
    let firstError: string | null = null;
    for (const address of to) {
      const res = await sendAppEmail({
        dojoId: args.dojoId,
        to: address,
        subject,
        html,
        templateName: CHARGEBACK_TEMPLATE,
        // One per dispute per recipient: Stripe sends several events for the
        // same dispute and none of them should send this twice.
        idempotencyKey: `staff-chargeback:${args.disputeId}:${address}`,
        marketing: false,
        memberId: args.memberId,
      });
      if ((res as any)?.ok) sent += 1;
      else if (!firstError) firstError = String((res as any)?.error ?? "send failed");
    }

    return sent > 0
      ? { ok: true, sent }
      : { ok: false, sent: 0, error: firstError ?? "No email sent" };
  } catch (e: any) {
    return { ok: false, sent: 0, error: e?.message ?? String(e) };
  }
}
