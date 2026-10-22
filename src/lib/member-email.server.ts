// Keeping a member's three email addresses in step.
//
// A member's address lives in three places: `members.email` (all app contact),
// `auth.users.email` (their login and every auth email, including password
// reset), and the Stripe customer (receipts). Historically only the first was
// updated, so a reset could be delivered to an address the member no longer
// controls — an account-takeover risk, not just an inconvenience.
//
// DECISION: email changes are applied as an ADMINISTRATIVE update
// (`auth.admin.updateUserById` with `email_confirm: true`). The new address
// becomes the login immediately, so the UI never shows an address that isn't
// the real login. Both staff-initiated and member-initiated changes take this
// path, and the caller is authorised before we get here.
//
// The three writes are treated as one operation: if a later step fails, the
// earlier ones are rolled back and the error is surfaced.

import { getPlatformStripe, hasStripeSecret } from "@/lib/stripe-connect.server";

export type EmailSyncResult = {
  memberEmail: string;
  loginEmail: string | null;
  stripeUpdated: boolean;
};

export async function applyMemberEmailChange(args: {
  memberId: string;
  userId: string | null;
  stripeCustomerId: string | null;
  currentMemberEmail: string | null;
  newEmail: string;
}): Promise<EmailSyncResult> {
  const { memberId, userId, stripeCustomerId, currentMemberEmail } = args;
  const newEmail = args.newEmail.trim().toLowerCase();
  if (!newEmail) throw new Error("Email is required");

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // 1. Login email (only when the member actually has an account).
  let previousLoginEmail: string | null = null;
  if (userId) {
    const { data: existing, error: getErr } =
      await supabaseAdmin.auth.admin.getUserById(userId);
    if (getErr) throw new Error(`Could not read the login account: ${getErr.message}`);
    previousLoginEmail = existing?.user?.email ?? null;

    if ((previousLoginEmail ?? "").toLowerCase() !== newEmail) {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
        email: newEmail,
        email_confirm: true,
      });
      if (error) {
        throw new Error(`Could not update the login email: ${error.message}`);
      }
    }
  }

  const rollbackLogin = async () => {
    if (userId && previousLoginEmail && previousLoginEmail.toLowerCase() !== newEmail) {
      await supabaseAdmin.auth.admin
        .updateUserById(userId, { email: previousLoginEmail, email_confirm: true })
        .catch(() => undefined);
    }
  };

  // 2. Stripe customer, so receipts follow the member.
  let stripeUpdated = false;
  if (stripeCustomerId && hasStripeSecret()) {
    try {
      await getPlatformStripe().customers.update(stripeCustomerId, { email: newEmail });
      stripeUpdated = true;
    } catch (err) {
      await rollbackLogin();
      throw new Error(
        `Could not update the Stripe customer: ${
          err instanceof Error ? err.message : "unknown error"
        }. Nothing was changed.`,
      );
    }
  }

  const rollbackStripe = async () => {
    if (stripeUpdated && stripeCustomerId) {
      await getPlatformStripe()
        .customers.update(stripeCustomerId, { email: currentMemberEmail ?? "" })
        .catch(() => undefined);
    }
  };

  // 3. Member record (and the profile row that mirrors the login address).
  const { error: mErr } = await supabaseAdmin
    .from("members")
    .update({ email: newEmail, updated_at: new Date().toISOString() })
    .eq("id", memberId);
  if (mErr) {
    await rollbackStripe();
    await rollbackLogin();
    throw new Error(`Could not update the member record: ${mErr.message}. Nothing was changed.`);
  }

  if (userId) {
    await supabaseAdmin.from("profiles").update({ email: newEmail }).eq("user_id", userId);
  }

  return { memberEmail: newEmail, loginEmail: userId ? newEmail : null, stripeUpdated };
}
