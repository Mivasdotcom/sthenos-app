// Ending a membership. Every path that lapses/cancels a member goes through
// `endMembership` so Stripe billing is ALWAYS stopped first. We never write the
// local status when the Stripe cancellation failed — staff see the error
// instead, so the app can never claim "cancelled" while Stripe keeps charging.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertDojoStaff } from "@/lib/dojo-access";

const LIVE_SUB_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
] as const;

export type CancelMode = "period_end" | "immediate";

export type EndMembershipPreview = {
  memberId: string;
  memberName: string;
  paymentMethod: "card" | "cash";
  subscription: {
    id: string;
    stripeSubscriptionId: string | null;
    status: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  isFamilyPayer: boolean;
  dependents: { id: string; name: string }[];
  stripeConfigured: boolean;
};

export type EndMembershipResult = {
  ok: true;
  mode: CancelMode;
  stripeCanceled: boolean;
  accessUntil: string | null;
  localStatus: "lapsed" | "active";
  dependents: { id: string; name: string }[];
};

export type ReconciliationRow = {
  memberId: string;
  name: string;
  email: string | null;
  localStatus: string;
  stripeSubscriptionId: string | null;
  localSubStatus: string;
  stripeStatus: string | null;
  currentPeriodEnd: string | null;
};

function subPeriodEnd(sub: any): string | null {
  const raw =
    sub?.items?.data?.[0]?.current_period_end ?? sub?.current_period_end ?? null;
  return raw ? new Date(raw * 1000).toISOString() : null;
}

/** What staff need to see before they end a membership. */
export const getEndMembershipPreview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberId: string }) => d)
  .handler(async ({ data, context }): Promise<EndMembershipPreview> => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "getEndMembershipPreview");

    const { data: member, error } = await supabase
      .from("members")
      .select("id, name, payment_method")
      .eq("id", data.memberId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (error) throw error;
    if (!member) throw new Error("Member not found in this gym");

    const [{ data: subs }, { data: deps }] = await Promise.all([
      supabase
        .from("member_subscriptions")
        .select("id, stripe_subscription_id, status, current_period_end, cancel_at_period_end")
        .eq("dojo_id", data.dojoId)
        .eq("member_id", data.memberId)
        .in("status", LIVE_SUB_STATUSES)
        .order("created_at", { ascending: false })
        .limit(1),
      supabase
        .from("members")
        .select("id, name")
        .eq("dojo_id", data.dojoId)
        .eq("plan_covered_by", data.memberId),
    ]);

    const sub = subs?.[0] ?? null;
    const { hasStripeSecret } = await import("@/lib/stripe-connect.server");

    return {
      memberId: member.id,
      memberName: member.name,
      paymentMethod: (member.payment_method ?? "card") as "card" | "cash",
      subscription: sub
        ? {
            id: sub.id,
            stripeSubscriptionId: sub.stripe_subscription_id ?? null,
            status: sub.status,
            currentPeriodEnd: sub.current_period_end ?? null,
            cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          }
        : null,
      isFamilyPayer: (deps ?? []).length > 0,
      dependents: (deps ?? []) as { id: string; name: string }[],
      stripeConfigured: hasStripeSecret(),
    };
  });

/**
 * Single source of truth for ending a membership.
 *
 * mode = "period_end" (default): Stripe subscription is set to cancel at the
 * end of the paid period. The member keeps access until then, so we deliberately
 * leave the local status untouched — the Stripe webhook lapses them when the
 * subscription actually ends. Nothing is ever charged again.
 *
 * mode = "immediate": the Stripe subscription is cancelled now and the member
 * is marked lapsed straight away.
 */
export const endMembership = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      dojoId: string;
      memberId: string;
      mode?: CancelMode;
      reason?: string | null;
      source?: string | null;
    }) => d,
  )
  .handler(async ({ data, context }): Promise<EndMembershipResult> => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "endMembership");
    const mode: CancelMode = data.mode ?? "period_end";

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: member, error: mErr } = await supabaseAdmin
      .from("members")
      .select("id, name, email, payment_method, cancellation_reason")
      .eq("id", data.memberId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (mErr) throw mErr;
    if (!member) throw new Error("Member not found in this gym");

    const { data: subs, error: sErr } = await supabaseAdmin
      .from("member_subscriptions")
      .select("id, stripe_subscription_id, status, current_period_end")
      .eq("dojo_id", data.dojoId)
      .eq("member_id", data.memberId)
      .in("status", LIVE_SUB_STATUSES);
    if (sErr) throw sErr;

    const liveSubs = (subs ?? []).filter((s: any) => s.stripe_subscription_id);
    const orphanSubs = (subs ?? []).filter((s: any) => !s.stripe_subscription_id);

    let stripeCanceled = false;
    let accessUntil: string | null = null;
    let stripeSubscriptionId: string | null = null;

    if (liveSubs.length > 0) {
      const { hasStripeSecret, getPlatformStripe, cancelDuesSubscription } =
        await import("@/lib/stripe-connect.server");
      if (!hasStripeSecret()) {
        throw new Error(
          "Stripe isn't configured, so this member's subscription can't be stopped. Nothing was changed — resolve Stripe setup first.",
        );
      }
      // Dues subscriptions live on the PLATFORM account (destination charges),
      // so no { stripeAccount } scoping here — see duesRequestOptions().
      const stripe = getPlatformStripe();

      for (const s of liveSubs as any[]) {
        stripeSubscriptionId = s.stripe_subscription_id;
        // Throws (leaving local state untouched) unless Stripe verifies the
        // subscription is cancelled / cancelling or genuinely absent.
        const outcome = await cancelDuesSubscription(
          stripe,
          s.stripe_subscription_id,
          mode === "immediate" ? "immediate" : "period_end",
        );

        if (!outcome.existed) {
          await supabaseAdmin
            .from("member_subscriptions")
            .update({ status: "canceled", canceled_at: new Date().toISOString() })
            .eq("id", s.id);
          continue;
        }

        stripeCanceled = true;
        const periodEnd = outcome.currentPeriodEnd ?? s.current_period_end ?? null;
        if (mode === "period_end" && outcome.status !== "canceled") {
          accessUntil = periodEnd;
          await supabaseAdmin
            .from("member_subscriptions")
            .update({
              cancel_at_period_end: true,
              cancel_at: periodEnd,
              current_period_end: periodEnd,
            })
            .eq("id", s.id);
        } else {
          await supabaseAdmin
            .from("member_subscriptions")
            .update({
              status: "canceled",
              cancel_at_period_end: false,
              canceled_at: new Date().toISOString(),
            })
            .eq("id", s.id);
        }
      }
    }


    // Subscription rows with no Stripe reference can never charge anyone.
    for (const s of orphanSubs as any[]) {
      await supabaseAdmin
        .from("member_subscriptions")
        .update({ status: "canceled", canceled_at: new Date().toISOString() })
        .eq("id", s.id);
    }

    // Only keep the member active when a real Stripe subscription is still
    // running out its paid period. Cash members and members with no live
    // subscription lapse immediately (and drop off "owed this month").
    const keepActive = mode === "period_end" && stripeCanceled && !!accessUntil;
    const localStatus: "lapsed" | "active" = keepActive ? "active" : "lapsed";

    const { error: upErr } = await supabaseAdmin
      .from("members")
      .update({
        ...(keepActive ? {} : { status: "lapsed", payment_status: "none" }),
        cancellation_requested_at: null,
        cancellation_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.memberId)
      .eq("dojo_id", data.dojoId);
    if (upErr) throw upErr;

    const reason = data.reason ?? member.cancellation_reason ?? null;

    await supabaseAdmin.from("cancellation_audit_log").insert({
      member_id: data.memberId,
      dojo_id: data.dojoId,
      action: "confirmed",
      reason: data.source ? `${reason ?? ""}${reason ? " · " : ""}via ${data.source}` : reason,
      actor_user_id: userId,
      cancel_mode: mode,
      stripe_subscription_canceled: stripeCanceled,
      stripe_subscription_id: stripeSubscriptionId,
      access_until: accessUntil,
    });

    // Family payer: their dependents lose coverage — leave a staff task.
    const { data: deps } = await supabaseAdmin
      .from("members")
      .select("id, name")
      .eq("dojo_id", data.dojoId)
      .eq("plan_covered_by", data.memberId);
    const dependents = (deps ?? []) as { id: string; name: string }[];

    if (dependents.length > 0) {
      await supabaseAdmin.from("internal_tasks").insert({
        dojo_id: data.dojoId,
        member_id: data.memberId,
        title: `Reassign family plan payer for ${dependents.length} member${dependents.length === 1 ? "" : "s"}`,
        description: `${member.name} cancelled and was paying for: ${dependents
          .map((d) => d.name)
          .join(", ")}. Assign a new payer or move them onto their own plan.`,
        status: "open",
        created_by: userId,
      });
    }

    try {
      await supabaseAdmin.rpc("recompute_member_payment_statuses", {
        _dojo_id: data.dojoId,
      });
    } catch {
      // Status recomputation is a convenience, never a blocker.
    }

    return { ok: true, mode, stripeCanceled, accessUntil, localStatus, dependents };
  });

/**
 * Safety net: members marked lapsed locally who still have a live Stripe
 * subscription. Owner/admin only.
 */
export const reconcileCancelledSubscriptions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }): Promise<{ rows: ReconciliationRow[] }> => {
    const { supabase, userId } = context as any;
    const role = await assertDojoStaff(
      supabase,
      userId,
      data.dojoId,
      "reconcileCancelledSubscriptions",
    );
    if (role !== "owner" && role !== "admin") {
      throw new Error("Only gym owners or admins can run this check");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: subs, error } = await supabaseAdmin
      .from("member_subscriptions")
      .select(
        "id, member_id, stripe_subscription_id, status, current_period_end, members!inner(id, name, email, status, dojo_id)",
      )
      .eq("dojo_id", data.dojoId)
      .in("status", LIVE_SUB_STATUSES);
    if (error) throw error;

    const suspects = (subs ?? []).filter(
      (s: any) => s.members && s.members.status === "lapsed",
    );
    if (suspects.length === 0) return { rows: [] };

    // Confirm against Stripe where we can, so we don't report stale local rows.
    // Dues subscriptions live on the platform account — no stripeAccount scoping.
    let stripe: any = null;
    try {
      const { hasStripeSecret, getPlatformStripe } = await import(
        "@/lib/stripe-connect.server"
      );
      if (hasStripeSecret()) stripe = getPlatformStripe();
    } catch {
      stripe = null;
    }

    const rows: ReconciliationRow[] = [];
    for (const s of suspects as any[]) {
      let stripeStatus: string | null = null;
      if (stripe && s.stripe_subscription_id) {
        try {
          const { duesRequestOptions } = await import("@/lib/stripe-connect.server");
          const sub = await stripe.subscriptions.retrieve(
            s.stripe_subscription_id,
            undefined,
            duesRequestOptions(),
          );
          stripeStatus = sub.status;
          if (!(LIVE_SUB_STATUSES as readonly string[]).includes(sub.status)) {
            // Stripe already ended it — heal the local row and skip.
            await supabaseAdmin
              .from("member_subscriptions")
              .update({ status: "canceled" })
              .eq("id", s.id);
            continue;
          }
        } catch {
          stripeStatus = null;
        }
      }

      rows.push({
        memberId: s.member_id,
        name: s.members.name,
        email: s.members.email ?? null,
        localStatus: s.members.status,
        stripeSubscriptionId: s.stripe_subscription_id ?? null,
        localSubStatus: s.status,
        stripeStatus,
        currentPeriodEnd: s.current_period_end ?? null,
      });
    }

    return { rows };
  });

/**
 * Tell the gym a member has given notice.
 *
 * The request itself is written by the `request_my_cancellation` database
 * function, so there is no server code in that path to hang an email on. The
 * member's portal calls this straight afterwards.
 *
 * Member-callable by design, and it trusts nothing from the caller: it sends
 * only if the member really is the caller's own record and the request is
 * actually recorded against it. Anyone else asking gets nothing.
 */
export const notifyCancellationRequested = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberId: string }) => d)
  .handler(async ({ data, context }) => {
    const { userId } = context as any;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: member } = await supabaseAdmin
      .from("members")
      .select("id, user_id, cancellation_requested_at, cancellation_reason")
      .eq("id", data.memberId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (!member) return { ok: false as const, reason: "not found" };

    // Their own record, or one they manage -- a parent gives notice for a child.
    let permitted = member.user_id === userId;
    if (!permitted) {
      const { data: link } = await supabaseAdmin
        .from("member_managers")
        .select("id")
        .eq("member_id", data.memberId)
        .eq("user_id", userId)
        .eq("dojo_id", data.dojoId)
        .maybeSingle();
      permitted = !!link;
    }
    if (!permitted) return { ok: false as const, reason: "not yours" };

    // No request on file means nothing happened; never email on a bare call.
    if (!member.cancellation_requested_at) return { ok: false as const, reason: "no request" };

    const { sendCancellationRequestAlert } = await import("@/lib/staff-notify.server");
    const res = await sendCancellationRequestAlert({
      dojoId: data.dojoId,
      memberId: data.memberId,
      reason: member.cancellation_reason ?? null,
    });
    if (!res.ok) console.error("[cancellation] staff alert not sent:", res.error);
    return { ok: res.ok };
  });
