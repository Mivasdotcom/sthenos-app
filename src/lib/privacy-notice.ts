/**
 * Generates a starting-point member privacy notice for one gym.
 *
 * The gym is the data controller, so the notice must name them and describe
 * only the processing they actually perform. Everything here is derived from
 * that gym's own settings — nothing generic, nothing they don't do.
 *
 * What we generate is illustrative, not legal advice. The gym reviews, edits
 * and publishes it as their own notice (see Settings → Member agreements).
 */

export const PRIVACY_NOTICE_TITLE = "Privacy notice";

export interface PrivacyNoticeSettings {
  gymName: string;
  /** Address members use for data protection questions. */
  contactEmail: string | null;
  /** Optional date of birth is collected at signup unless turned off. */
  collectsDateOfBirth: boolean;
  collectMediaConsent: boolean;
  partnerMatchingEnabled: boolean;
  retentionAutoEnabled: boolean;
  retentionDepartedMonths: number | null;
  retentionWaiverMonths: number | null;
}

function months(n: number): string {
  if (n % 12 === 0) {
    const years = n / 12;
    return years === 1 ? "1 year" : `${years} years`;
  }
  return n === 1 ? "1 month" : `${n} months`;
}

export function buildPrivacyNotice(s: PrivacyNoticeSettings): string {
  const gym = s.gymName.trim() || "the gym";
  const contact = s.contactEmail?.trim();
  const out: string[] = [];

  out.push(
    `## Who is responsible for your data`,
    `${gym} is the data controller for your member information. That means ${gym} decides what is collected and why, and is the organisation you deal with about your membership and about your data.`,
    `${gym} uses Sthenos, a membership management system, to run its membership. Sthenos acts as a data processor: it handles member information only on ${gym}'s instructions and for the purposes described in this notice.`,
    contact
      ? `For any question about your data, or to make a request about it, contact ${gym} at ${contact}.`
      : `For any question about your data, or to make a request about it, contact ${gym} directly.`,
  );

  out.push(
    `## What information is held`,
    `- Your name.`,
    `- Contact details — your email address and phone number.`,
  );
  if (s.collectsDateOfBirth) {
    out.push(
      `- Your date of birth, where you provide it. For members under 18, the parent or guardian's details are held as well.`,
    );
  }
  out.push(
    `- Attendance records — class bookings and check-ins.`,
    `- Belt and grade progression, including promotion history.`,
    `- Membership and payment status — your plan, whether dues are current, due or overdue, and records of any cash payments recorded by staff.`,
    `- Waiver records — the waiver you signed, the name you signed it in, and when.`,
  );
  if (s.collectMediaConsent) {
    out.push(`- Your photo and video consent choice, and the date it was recorded.`);
  }
  out.push(
    `- Messages exchanged between you and ${gym} through the app, and a record of membership emails sent to you.`,
    `- Where you heard about ${gym}, if you told us, and any cancellation request and reason you submit.`,
  );

  out.push(
    `## Why it is held`,
    `- To run your membership — registration, plans, renewals, pauses and cancellations.`,
    `- To manage classes, bookings, attendance and grading.`,
    `- To take and reconcile payments, and to follow up on overdue dues.`,
    `- To keep a record of the waiver${s.collectMediaConsent ? " and consents" : ""} you have given, for safety and insurance purposes.`,
    `- To contact you about your membership, your classes and your account.`,
    `- To help ${gym} understand attendance and retention, and to prompt a member of staff to check in with members who may need support.`,
    `- To send you news and offers where ${gym} has an appropriate basis to do so and you have not opted out. You can opt out of marketing at any time using the link in any marketing email.`,
  );

  out.push(
    `## Analysis of your attendance history`,
    `Your attendance and membership history are analysed to help ${gym} notice when someone appears to have stopped coming, or may be ready for their next grade. This is done by straightforward rules inside the Sthenos system.`,
    `No automatic decision is made about you. The result simply prompts a person at ${gym} to get in touch or to take a closer look.`,
  );

  if (s.partnerMatchingEnabled) {
    out.push(
      `## Training partner matching`,
      `You can choose to be shown to other members as a potential training partner. This is off unless you turn it on.`,
      `- If you opt in, other opted-in members can see your discipline and belt level, so they can find a suitable partner.`,
      `- They cannot see your contact details, your attendance history, or when you train.`,
      `- You can turn it off at any time from your member portal, and you will no longer be shown to anyone.`,
    );
  }

  if (s.collectMediaConsent) {
    out.push(
      `## Photos and video`,
      `Consent to use photos and training footage of you is separate from your waiver and is entirely optional. You can join and train without giving it, and you can change your choice at any time from your member portal. Where the member is under 18, a parent or guardian gives or withdraws this consent on their behalf.`,
    );
  }

  out.push(
    `## Who processes it on ${gym}'s behalf`,
    `These providers act on instructions and may not use member information for their own purposes.`,
    `- Sthenos — the membership system itself, including its database and hosting.`,
    `- Stripe — card payments. Card details are entered directly with Stripe and held by Stripe. ${gym} and Sthenos never hold your card number; only the payment status and a reference.`,
    `- Hetzner — hosting of the Sthenos application, in data centres in Germany.`,
    `- Supabase — the database and sign-in service.`,
    `- Resend — delivery of email.`,
    `- Anthropic, an AI service, used to help ${gym}'s staff make sense of their own figures. It receives anonymous, aggregated statistics about ${gym} as a whole, such as member counts and attendance patterns, from which no member can be identified, together with the questions staff type when asking about them. Members' names are replaced with placeholders first, and no contact details, account identifiers or individual records are sent.`,
  );

  // Article 13(1)(f): members are told where their information goes. The gym
  // warrants to Sthenos that its notice covers this, so the template it starts
  // from has to actually do it.
  out.push(
    `## Where your information is held`,
    `- ${gym}'s records are stored in the European Union (Ireland), and backups are kept in the same place.`,
    `- Sthenos is operated from the United Kingdom, which the European Commission recognises as offering an equivalent standard of protection.`,
    `- The AI service described above processes what is sent to it in the United States, under the standard contractual clauses approved by the European Commission.`,
  );

  const retention: string[] = [`## How long it is kept`];
  retention.push(
    `Personal details are anonymised rather than simply deleted at the end of the retention period, so ${gym} keeps the statistical and financial records it needs without keeping information that identifies you.`,
  );
  if (s.retentionAutoEnabled && s.retentionDepartedMonths) {
    retention.push(
      `- Membership, attendance and grading records — kept while you are a member and for ${months(s.retentionDepartedMonths)} after you leave, then anonymised.`,
    );
  } else {
    retention.push(
      `- Membership, attendance and grading records — kept while you are a member and afterwards for as long as ${gym} needs them for its legal, insurance and accounting obligations. ${gym} reviews departed member records rather than anonymising them on a fixed schedule.`,
    );
  }
  if (s.retentionAutoEnabled && s.retentionWaiverMonths) {
    retention.push(
      `- Signed waivers and safety records — kept for ${months(s.retentionWaiverMonths)} after you leave, because they may be needed if an insurance or legal claim is brought later.`,
    );
  } else {
    retention.push(
      `- Signed waivers and safety records — kept for longer than other records, because they may be needed if an insurance or legal claim is brought later.`,
    );
  }
  retention.push(
    `- Invoices and payment records — kept for the period required by law for accounting and tax, in anonymised form once your member record has been anonymised.`,
  );
  out.push(...retention);

  out.push(
    `## Your rights`,
    `- Access — ask for a copy of the information held about you.`,
    `- Correction — ask for anything inaccurate to be fixed. You can also update your own contact details in your member portal.`,
    `- Erasure — ask for your personal data to be deleted. Some financial records must be retained, and are anonymised where possible.`,
    `- Portability — ask for your data in a portable, machine-readable form.`,
    `- Withdraw consent — including photo and video consent and marketing emails, at any time.`,
    `- Object or complain — you can object to how your data is used, and you can complain to your local data protection authority.`,
  );

  out.push(
    `## How to make a request`,
    contact
      ? `Email ${gym} at ${contact}, or message ${gym} through the app. ${gym} will handle your request as the controller of your data.`
      : `Contact ${gym} directly, or message ${gym} through the app. ${gym} will handle your request as the controller of your data.`,
  );

  return out.join("\n\n");
}

/** Guidance shown to the gym in the editing screen only — never to members. */
export const PRIVACY_NOTICE_OPERATOR_NOTE =
  "This is a starting point generated from your gym's settings — it describes how the software works. It is not legal advice. Review it, add anything specific to your jurisdiction, and have your own adviser check it before you publish it as your gym's notice.";
