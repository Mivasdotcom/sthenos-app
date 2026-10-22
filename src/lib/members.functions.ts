import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * GDPR: permanently delete a member and their personal data from this dojo.
 *
 * - Owner/admin only (verified via dojo_memberships).
 * - Cancels any active Stripe subscription first (best-effort).
 * - Deletes attendances, class bookings, promotions, waiver signatures,
 *   member_subscriptions, member_payment_methods, member_status_history,
 *   cancellation_audit_log, family_groups membership, conversations & messages,
 *   and the members row itself.
 * - Invoices are retained for financial records but anonymised.
 * - The deletion is written to member_deletion_audit_log.
 */
export const deleteMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { dojoId: string; memberId: string; reason?: string }) => data)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { dojoId, memberId } = data;
    if (!dojoId || !memberId) throw new Error("dojoId and memberId are required");

    // 1) Verify caller is owner/admin of this dojo
    const { data: membership, error: mErr } = await supabase
      .from("dojo_memberships")
      .select("role")
      .eq("user_id", userId)
      .eq("dojo_id", dojoId)
      .maybeSingle();
    if (mErr) throw mErr;
    if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
      throw new Error("Only dojo owners or admins can delete members");
    }

    // Use admin client for the cascade so RLS on all satellite tables doesn't
    // block deletion; we've already authorised the caller above.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // 2) Load the member (scoped to this dojo)
    const { data: member, error: memberErr } = await supabaseAdmin
      .from("members")
      .select("id, dojo_id, name, email")
      .eq("id", memberId)
      .eq("dojo_id", dojoId)
      .maybeSingle();
    if (memberErr) throw memberErr;
    if (!member) throw new Error("Member not found in this dojo");

    // 3) Cancel any live Stripe subscription — VERIFIED, and a hard blocker.
    //    We must never erase a member whose subscription is still billing:
    //    without a local record there is nothing left to reconcile against.
    let stripeCanceled = false;
    const stripeWarning: string | null = null;
    const { data: subs } = await supabaseAdmin
      .from("member_subscriptions")
      .select("id, stripe_subscription_id, status")
      .eq("member_id", memberId)
      .eq("dojo_id", dojoId);

    const activeSubs = (subs ?? []).filter(
      (s) =>
        s.stripe_subscription_id &&
        ["active", "trialing", "past_due", "unpaid", "incomplete"].includes(s.status as string),
    );

    if (activeSubs.length > 0) {
      const { hasStripeSecret, getPlatformStripe, cancelDuesSubscription, isDuesSubscriptionEnded } =
        await import("@/lib/stripe-connect.server");
      if (!hasStripeSecret()) {
        throw new Error(
          "This member still has a live subscription and Stripe isn't configured, so it can't be stopped. Nothing was deleted.",
        );
      }
      const stripe = getPlatformStripe();
      // Dues subscriptions live on the PLATFORM account (destination
      // charges), so no { stripeAccount } scoping here.
      for (const s of activeSubs) {
        const subId = s.stripe_subscription_id as string;
        try {
          // Throws unless Stripe verifies the cancellation.
          await cancelDuesSubscription(stripe, subId, "immediate");
          const ended = await isDuesSubscriptionEnded(stripe, subId);
          if (!ended) throw new Error("Stripe still reports it as live");
          stripeCanceled = true;
        } catch (err) {
          console.error("[deleteMember] Stripe cancel failed", { subscriptionId: subId, error: err });
          throw new Error(
            `Deletion aborted: this member's Stripe subscription (${subId}) could not be verified as cancelled, so nothing was deleted. Use "Cancel membership" first, then retry. Stripe said: ${
              (err as Error)?.message ?? "unknown error"
            }`,
          );
        }
      }
    }


    // 4) Anonymise invoices (keep for financial records)
    const { error: invErr } = await supabaseAdmin
      .from("invoices")
      .update({
        member_id: null,
      })
      .eq("member_id", memberId)
      .eq("dojo_id", dojoId);
    if (invErr) console.error("[deleteMember] invoice anonymise failed", invErr);

    // 5) Delete related personal data (order matters for FK chains)
    const delScoped = async (table: string) => {
      const { error } = await supabaseAdmin
        .from(table as any)
        .delete()
        .eq("member_id", memberId)
        .eq("dojo_id", dojoId);
      if (error) console.error(`[deleteMember] delete ${table} failed`, error);
    };
    const delByMember = async (table: string) => {
      const { error } = await supabaseAdmin
        .from(table as any)
        .delete()
        .eq("member_id", memberId);
      if (error) console.error(`[deleteMember] delete ${table} failed`, error);
    };

    // Messages first (FK -> conversations), then conversations
    const { data: convos } = await supabaseAdmin
      .from("conversations")
      .select("id")
      .eq("member_id", memberId)
      .eq("dojo_id", dojoId);
    if (convos && convos.length > 0) {
      const ids = convos.map((c) => c.id);
      const { error: msgErr } = await supabaseAdmin
        .from("messages")
        .delete()
        .in("conversation_id", ids);
      if (msgErr) console.error("[deleteMember] delete messages failed", msgErr);
    }
    await delScoped("conversations");

    await delScoped("attendances");
    await delScoped("class_bookings");
    await delScoped("member_waivers");
    await delScoped("member_subscriptions");
    await delScoped("member_payment_methods");
    await delScoped("member_status_history");
    await delScoped("cancellation_audit_log");
    await delScoped("email_send_log");
    // promotions is scoped by member_id only (no dojo_id column)
    await delByMember("promotions");

    // If this member "covered" others in a family plan, detach them and leave
    // staff an explicit task — those members now need their own plan.
    const { data: coveredRows } = await supabaseAdmin
      .from("members")
      .select("id, name")
      .eq("plan_covered_by", memberId);

    await supabaseAdmin
      .from("members")
      .update({ plan_covered_by: null })
      .eq("plan_covered_by", memberId);

    if ((coveredRows ?? []).length > 0) {
      const names = (coveredRows ?? []).map((c: any) => c.name).join(", ");
      const { error: taskErr } = await supabaseAdmin.from("internal_tasks").insert({
        dojo_id: dojoId,
        member_id: null,
        title: `Family plan needs a new payer (${member.name} deleted)`,
        description: `${member.name} paid for a family plan and has been deleted. These members are no longer covered and need their own plan or a new payer: ${names}.`,
        status: "open",
      });
      if (taskErr) console.error("[deleteMember] family payer task failed", taskErr);
    }

    // 6) Finally, delete the members row
    const { error: delErr } = await supabaseAdmin
      .from("members")
      .delete()
      .eq("id", memberId)
      .eq("dojo_id", dojoId);
    if (delErr) throw delErr;

    // 7) Audit log
    const { error: auditErr } = await supabaseAdmin
      .from("member_deletion_audit_log")
      .insert({
        dojo_id: dojoId,
        member_id: null,
        member_name: member.name,
        member_email: member.email,
        actor_user_id: userId,
        reason: data.reason ?? null,
        stripe_subscription_canceled: stripeCanceled,
        metadata: stripeWarning ? { stripe_warning: stripeWarning } : {},
      });
    if (auditErr) console.error("[deleteMember] audit insert failed", auditErr);

    return { ok: true, stripeCanceled, stripeWarning };
  });
