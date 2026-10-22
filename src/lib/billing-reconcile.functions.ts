import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Owner-only reconciliation sweep for member-dues subscriptions.
 *
 * Report-only: it never cancels anything by itself. It surfaces every drift
 * state where Stripe and the local arrangement disagree, including orphaned
 * subscriptions held by covered family members or cash payers.
 *
 * `cancelOrphanedSubscription` below is the one-click, per-row resolution using
 * the verified platform-account cancellation path.
 */

const DEAD_LOCAL_STATUSES = ["canceled", "lapsed", "ended", "incomplete_expired"];
const LIVE_STRIPE_STATUSES = ["active", "trialing", "past_due", "unpaid", "incomplete"];
const LIVE_LOCAL_STATUSES = ["active", "trialing", "past_due", "unpaid", "incomplete"];

export type StillBillingRow = {
  memberId: string;
  memberName: string;
  email: string | null;
  localSubStatus: string;
  stripeSubscriptionId: string;
  stripeStatus: string;
  amountCents: number | null;
  currency: string | null;
};

export type OrphanRow = {
  memberId: string;
  memberName: string;
  email: string | null;
  stripeSubscriptionId: string;
  stripeStatus: string;
  amountCents: number | null;
  currency: string | null;
  /** Why this subscription should not exist. */
  reason: string;
};

/** A live dues subscription found on Stripe that has no valid local counterpart. */
export type StripeOrphanRow = {
  stripeSubscriptionId: string;
  stripeStatus: string;
  customerEmail: string | null;
  memberId: string | null;
  memberName: string | null;
  amountCents: number | null;
  currency: string | null;
  metadata: Record<string, string>;
  reason: string;
  hasLocalRecord: boolean;
};

export type ReverseDriftRow = {

  memberId: string;
  memberName: string;
  localSubStatus: string;
  stripeSubscriptionId: string;
  stripeStatus: string;
};

/**
 * The date the member was promised and the date Stripe will actually charge,
 * where those two disagree. They are computed in different places — one at
 * signup onto the member row, one sent to Stripe at checkout — so nothing
 * kept them honest until this check existed.
 */
export type TrialDateDriftRow = {
  memberId: string;
  memberName: string;
  stripeSubscriptionId: string;
  /** What the member was told: members.free_trial_ends_at */
  promisedOn: string | null;
  /** What Stripe will act on: subscription.trial_end */
  stripeChargesOn: string | null;
  daysApart: number | null;
};

/**
 * One member holding more than one live subscription — almost always a
 * duplicate checkout, where someone thought the first attempt hadn't worked
 * and went round again. Both subscriptions bill.
 */
export type DoubleBilledMember = {
  memberId: string;
  memberName: string;
  subscriptions: {
    stripeSubscriptionId: string;
    stripeStatus: string;
    amountCents: number | null;
  }[];
};

export type DoubleBilledFamily = {
  groupId: string;
  groupName: string | null;
  payerName: string | null;
  subscriptions: {
    memberId: string;
    memberName: string;
    stripeSubscriptionId: string;
    stripeStatus: string;
    amountCents: number | null;
  }[];
};

async function assertOwner(supabase: any, userId: string, dojoId: string) {
  const { data: membership } = await supabase
    .from("dojo_memberships")
    .select("role")
    .eq("user_id", userId)
    .eq("dojo_id", dojoId)
    .maybeSingle();
  if (!membership || membership.role !== "owner") {
    throw new Error("Only the gym owner can manage billing reconciliation");
  }
}

export const reconcileDuesSubscriptions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertOwner(supabase, userId, data.dojoId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { hasStripeSecret, getPlatformStripe, getDuesSubscription } = await import(
      "@/lib/stripe-connect.server"
    );
    if (!hasStripeSecret()) {
      throw new Error("Stripe isn't configured, so nothing can be reconciled.");
    }
    const stripe = getPlatformStripe();

    const { data: rows, error } = await supabaseAdmin
      .from("member_subscriptions")
      .select(
        "id, member_id, status, stripe_subscription_id, members!inner(id, name, email, status, family_group_id, plan_covered_by, payment_method, free_trial_ends_at)",
      )
      .eq("dojo_id", data.dojoId);
    if (error) throw error;

    // Designated payer + payer method for every family in play.
    const groupIds = Array.from(
      new Set(
        ((rows ?? []) as any[])
          .map((r) => r.members?.family_group_id)
          .filter((g: string | null) => !!g),
      ),
    ) as string[];
    const payerByGroup = new Map<string, string | null>();
    const groupNames = new Map<string, string | null>();
    if (groupIds.length > 0) {
      const { data: groups } = await supabaseAdmin
        .from("family_groups")
        .select("id, name, payer_member_id")
        .eq("dojo_id", data.dojoId)
        .in("id", groupIds);
      for (const g of (groups ?? []) as any[]) {
        payerByGroup.set(g.id, g.payer_member_id ?? null);
        groupNames.set(g.id, g.name ?? null);
      }
    }
    const payerIds = Array.from(payerByGroup.values()).filter((p): p is string => !!p);
    const payerInfo = new Map<string, { name: string; method: string }>();
    if (payerIds.length > 0) {
      const { data: payers } = await supabaseAdmin
        .from("members")
        .select("id, name, payment_method")
        .eq("dojo_id", data.dojoId)
        .in("id", payerIds);
      for (const p of (payers ?? []) as any[]) {
        payerInfo.set(p.id, { name: p.name, method: p.payment_method ?? "card" });
      }
    }

    const stillBilling: StillBillingRow[] = [];
    const orphans: OrphanRow[] = [];
    const reverseDrift: ReverseDriftRow[] = [];
    const trialDateDrift: TrialDateDriftRow[] = [];
    // A member can hold MORE THAN ONE live subscription, so this holds every
    // one of them. It used to keep a single value per member, which meant a
    // second subscription silently overwrote the first and a member billed
    // twice was invisible to every check below.
    const liveByMember = new Map<
      string,
      {
        subId: string;
        status: string;
        amountCents: number | null;
        name: string;
        familyGroupId: string | null;
      }[]
    >();

    for (const r of (rows ?? []) as any[]) {
      if (!r.stripe_subscription_id) continue;
      let state: any;
      try {
        state = await getDuesSubscription(stripe, r.stripe_subscription_id);
      } catch {
        continue;
      }

      const m = r.members ?? {};
      const stripeLive = state.present && LIVE_STRIPE_STATUSES.includes(state.status);

      // Reverse drift: local row says live, Stripe says gone.
      if (!stripeLive && LIVE_LOCAL_STATUSES.includes(r.status)) {
        reverseDrift.push({
          memberId: r.member_id,
          memberName: m.name ?? "Unknown",
          localSubStatus: r.status,
          stripeSubscriptionId: r.stripe_subscription_id,
          stripeStatus: state.present ? state.status : "missing",
        });
      }
      if (!stripeLive) continue;

      let amountCents: number | null = null;
      let currency: string | null = null;
      let stripeTrialEnd: number | null = null;
      try {
        const sub: any = await stripe.subscriptions.retrieve(r.stripe_subscription_id);
        const price = sub?.items?.data?.[0]?.price;
        amountCents = price?.unit_amount ?? null;
        currency = price?.currency ?? null;
        stripeTrialEnd = typeof sub?.trial_end === "number" ? sub.trial_end : null;
      } catch {
        /* amount is informational only */
      }

      // THE DATE THE MEMBER WAS TOLD, AGAINST THE DATE STRIPE WILL CHARGE.
      // Read from Stripe rather than the local mirror on purpose: the mirror
      // only fills when a webhook next fires, which for a trialing member is
      // when the trial ends -- far too late to be worth knowing.
      // Only meaningful while the trial is still running; afterwards the
      // promise has already been kept or broken and this is just history.
      if (stripeTrialEnd != null && state.status === "trialing") {
        const promisedIso = (m.free_trial_ends_at as string | null) ?? null;
        const stripeMs = stripeTrialEnd * 1000;
        const promisedMs = promisedIso ? Date.parse(promisedIso) : NaN;
        if (!Number.isFinite(promisedMs)) {
          // Stripe holds a charge date and the member row holds none, so
          // nobody can say what this member was actually promised.
          trialDateDrift.push({
            memberId: r.member_id,
            memberName: m.name ?? "Unknown",
            stripeSubscriptionId: r.stripe_subscription_id,
            promisedOn: null,
            stripeChargesOn: new Date(stripeMs).toISOString(),
            daysApart: null,
          });
        } else if (Math.abs(stripeMs - promisedMs) >= 12 * 3600_000) {
          // Hours apart is timezone noise. Half a day or more means the
          // member is charged on a day they were not told to expect.
          trialDateDrift.push({
            memberId: r.member_id,
            memberName: m.name ?? "Unknown",
            stripeSubscriptionId: r.stripe_subscription_id,
            promisedOn: promisedIso,
            stripeChargesOn: new Date(stripeMs).toISOString(),
            daysApart: Math.round((stripeMs - promisedMs) / 86400000),
          });
        }
      }

      liveByMember.set(r.member_id, [
        ...(liveByMember.get(r.member_id) ?? []),
        {
          subId: r.stripe_subscription_id,
          status: state.status,
          amountCents,
          name: m.name ?? "Unknown",
          familyGroupId: m.family_group_id ?? null,
        },
      ]);

      const localDead =
        DEAD_LOCAL_STATUSES.includes(r.status) || DEAD_LOCAL_STATUSES.includes(m.status);
      if (localDead) {
        stillBilling.push({
          memberId: r.member_id,
          memberName: m.name ?? "Unknown",
          email: m.email ?? null,
          localSubStatus: `${r.status} (member: ${m.status})`,
          stripeSubscriptionId: r.stripe_subscription_id,
          stripeStatus: state.status,
          amountCents,
          currency,
        });
      }

      // Orphan checks — a live subscription that must not exist.
      const groupId: string | null = m.family_group_id ?? null;
      const payerId = groupId ? (payerByGroup.get(groupId) ?? null) : null;
      const isPayer = !!payerId && payerId === r.member_id;
      const payer = payerId ? payerInfo.get(payerId) : undefined;
      const reasons: string[] = [];

      if (groupId && payerId && !isPayer) {
        reasons.push(
          `covered family member — ${payer?.name ?? "the designated payer"} is the payer`,
        );
      } else if (m.plan_covered_by && m.plan_covered_by !== r.member_id) {
        reasons.push("covered by another member's plan");
      }
      if (groupId && payer?.method === "cash") {
        reasons.push(`family payer ${payer.name} pays cash, so the family has no subscription`);
      }
      if ((m.payment_method ?? "card") === "cash") {
        reasons.push("member pays by cash");
      }

      if (reasons.length > 0) {
        orphans.push({
          memberId: r.member_id,
          memberName: m.name ?? "Unknown",
          email: m.email ?? null,
          stripeSubscriptionId: r.stripe_subscription_id,
          stripeStatus: state.status,
          amountCents,
          currency,
          reason: reasons.join("; "),
        });
      }
    }

    // ONE MEMBER, TWO SUBSCRIPTIONS. Checked before the family pass and
    // separately from it: a single member billed twice is not a family
    // problem, has no family group to be found under, and so was never
    // reported at all.
    const doubleBilledMembers: DoubleBilledMember[] = [];
    for (const [memberId, subs] of liveByMember.entries()) {
      if (subs.length < 2) continue;
      doubleBilledMembers.push({
        memberId,
        memberName: subs[0].name,
        subscriptions: subs.map((s) => ({
          stripeSubscriptionId: s.subId,
          stripeStatus: s.status,
          amountCents: s.amountCents,
        })),
      });
    }

    // Families with more than one live subscription.
    const byGroup = new Map<string, any[]>();
    for (const [memberId, subs] of liveByMember.entries()) {
      for (const v of subs) {
        if (!v.familyGroupId) continue;
        const arr = byGroup.get(v.familyGroupId) ?? [];
        arr.push({ ...v, memberId });
        byGroup.set(v.familyGroupId, arr);
      }
    }

    const doubleBilled: DoubleBilledFamily[] = [];
    for (const [groupId, list] of byGroup.entries()) {
      if (list.length < 2) continue;
      const payerId = payerByGroup.get(groupId) ?? null;
      doubleBilled.push({
        groupId,
        groupName: groupNames.get(groupId) ?? null,
        payerName: payerId ? (payerInfo.get(payerId)?.name ?? null) : null,
        subscriptions: list.map((s) => ({
          memberId: s.memberId,
          memberName: s.name,
          stripeSubscriptionId: s.subId,
          stripeStatus: s.status,
          amountCents: s.amountCents,
        })),
      });
    }

    // ---------------------------------------------------------------
    // Stripe-first pass: walk live dues subscriptions ON STRIPE so we can see
    // subscriptions whose member row no longer exists locally (deleted member,
    // orphaned billing). The member-table walk above is structurally blind to
    // these.
    // ---------------------------------------------------------------
    const stripeOrphans: StripeOrphanRow[] = [];
    const knownSubIds = new Set(
      ((rows ?? []) as any[]).map((r) => r.stripe_subscription_id).filter(Boolean),
    );
    const localByStripeId = new Map<string, any>();
    for (const r of (rows ?? []) as any[]) {
      if (r.stripe_subscription_id) localByStripeId.set(r.stripe_subscription_id, r);
    }

    for (const status of LIVE_STRIPE_STATUSES) {
      try {
        for await (const sub of stripe.subscriptions.list({
          status: status as any,
          limit: 100,
          expand: ["data.customer"],
        })) {
          const md: Record<string, string> = (sub.metadata ?? {}) as any;
          if (md['type'] !== "member_dues") continue;
          if (md['dojoId'] && md['dojoId'] !== data.dojoId) continue;
          if (!md['dojoId']) continue; // can't attribute it to this gym safely

          const memberId = md['memberId'] ?? null;
          const local = localByStripeId.get(sub.id);
          let member: any = null;
          if (memberId) {
            const { data: m } = await supabaseAdmin
              .from("members")
              .select("id, name, email, status")
              .eq("id", memberId)
              .eq("dojo_id", data.dojoId)
              .maybeSingle();
            member = m ?? null;
          }

          let reason: string | null = null;
          if (!memberId) reason = "subscription carries no member reference";
          else if (!member) reason = "the member record no longer exists (deleted member)";
          else if (DEAD_LOCAL_STATUSES.includes(member.status))
            reason = `member is locally ${member.status}`;
          else if (!local) reason = "no local subscription record for this Stripe subscription";
          else if (DEAD_LOCAL_STATUSES.includes(local.status))
            reason = `local subscription record is ${local.status}`;
          if (!reason) continue;

          const price: any = (sub as any)?.items?.data?.[0]?.price;
          const customer: any = sub.customer;
          stripeOrphans.push({
            stripeSubscriptionId: sub.id,
            stripeStatus: sub.status,
            customerEmail:
              (customer && typeof customer === "object" ? customer.email : null) ||
              member?.email ||
              null,

            memberId,
            memberName: member?.name ?? null,
            amountCents: price?.unit_amount ?? null,
            currency: price?.currency ?? null,
            metadata: md,
            reason,
            hasLocalRecord: knownSubIds.has(sub.id),
          });
        }
      } catch (err) {
        console.error("[reconcile] stripe-first pass failed", { status, err });
      }
    }

    return {
      ok: true as const,
      checkedAt: new Date().toISOString(),
      stillBilling,
      orphans,
      reverseDrift,
      trialDateDrift,
      doubleBilledMembers,
      doubleBilled,
      stripeOrphans,
    };
  });

/**
 * Cancel a dues subscription identified on Stripe, even when no local member
 * record exists (deleted member). Ownership is proven by the subscription's
 * own `metadata.dojoId`. Verified — throws unless Stripe confirms.
 */
export const cancelStripeDuesSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; stripeSubscriptionId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertOwner(supabase, userId, data.dojoId);

    const { hasStripeSecret, getPlatformStripe, cancelDuesSubscription } = await import(
      "@/lib/stripe-connect.server"
    );
    if (!hasStripeSecret()) throw new Error("Stripe isn't configured, so nothing was changed.");
    const stripe = getPlatformStripe();

    const sub: any = await stripe.subscriptions.retrieve(data.stripeSubscriptionId);
    const md: Record<string, string> = sub?.metadata ?? {};
    if (md['type'] !== "member_dues" || md['dojoId'] !== data.dojoId) {
      throw new Error("That subscription does not belong to this gym.");
    }

    const outcome = await cancelDuesSubscription(
      stripe,
      data.stripeSubscriptionId,
      "immediate",
    );

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin
      .from("member_subscriptions")
      .update({ status: "canceled", canceled_at: new Date().toISOString() })
      .eq("dojo_id", data.dojoId)
      .eq("stripe_subscription_id", data.stripeSubscriptionId);

    return { ok: true as const, existed: outcome.existed, status: outcome.status };
  });


/**
 * One-click resolution for a single flagged row: cancel the subscription on the
 * platform account, verified, then close the local row. Owner-only.
 */
export const cancelOrphanedSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; stripeSubscriptionId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertOwner(supabase, userId, data.dojoId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { hasStripeSecret, getPlatformStripe, cancelDuesSubscription } = await import(
      "@/lib/stripe-connect.server"
    );
    if (!hasStripeSecret()) {
      throw new Error("Stripe isn't configured, so nothing was changed.");
    }

    // The subscription must belong to this gym.
    const { data: row } = await supabaseAdmin
      .from("member_subscriptions")
      .select("id, member_id")
      .eq("dojo_id", data.dojoId)
      .eq("stripe_subscription_id", data.stripeSubscriptionId)
      .maybeSingle();
    if (!row) {
      throw new Error("That subscription does not belong to this gym.");
    }

    // Throws unless Stripe confirms the cancellation (or genuine absence).
    const outcome = await cancelDuesSubscription(
      getPlatformStripe(),
      data.stripeSubscriptionId,
      "immediate",
    );

    await supabaseAdmin
      .from("member_subscriptions")
      .update({ status: "canceled", canceled_at: new Date().toISOString() })
      .eq("id", (row as any).id);

    return { ok: true as const, existed: outcome.existed, status: outcome.status };
  });
