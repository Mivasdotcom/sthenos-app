// Hard billing invariants for families and cash members.
//
// These are asserted EXPLICITLY after every family mutation, not assumed as a
// side effect, because a single missed cancellation means Stripe keeps
// charging a member who should never be charged again:
//
//  a) a COVERED (non-payer) family member must never hold a live subscription
//  b) if the family's designated payer pays cash, NO member of that family may
//     hold a live subscription
//  c) a member whose own payment_method is 'cash' (and who is not a card family
//     payer) must never hold a live subscription
//
// Every cancellation goes through the verified platform-account helper, so
// local rows are only closed once Stripe confirms.

import { LIVE_SUB_STATUSES } from "@/lib/family-actions.server";

export type InvariantCancellation = {
  memberId: string;
  memberName: string;
  stripeSubscriptionId: string | null;
  reason: string;
};

type MemberRow = {
  id: string;
  name: string;
  payment_method: string | null;
  plan_covered_by: string | null;
  family_group_id: string | null;
};

/**
 * Cancel any subscription that violates the invariants above for the given
 * members / family groups. Throws if Stripe refuses, so the caller can roll
 * back rather than report a success that leaves a live subscription behind.
 */
export async function enforceFamilyBillingInvariants(params: {
  dojoId: string;
  /** Family groups to sweep (all of their members are checked). */
  groupIds?: (string | null | undefined)[];
  /** Extra individual members to check (e.g. a member just removed). */
  memberIds?: (string | null | undefined)[];
}): Promise<{ canceled: InvariantCancellation[] }> {
  const { dojoId } = params;
  const groupIds = (params.groupIds ?? []).filter((g): g is string => !!g);
  const extraIds = (params.memberIds ?? []).filter((m): m is string => !!m);

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const members = new Map<string, MemberRow>();
  if (groupIds.length > 0) {
    const { data } = await supabaseAdmin
      .from("members")
      .select("id, name, payment_method, plan_covered_by, family_group_id")
      .eq("dojo_id", dojoId)
      .in("family_group_id", groupIds);
    for (const m of ((data ?? []) as any[]) as MemberRow[]) members.set(m.id, m);
  }
  if (extraIds.length > 0) {
    const { data } = await supabaseAdmin
      .from("members")
      .select("id, name, payment_method, plan_covered_by, family_group_id")
      .eq("dojo_id", dojoId)
      .in("id", extraIds);
    for (const m of ((data ?? []) as any[]) as MemberRow[]) members.set(m.id, m);
  }
  if (members.size === 0) return { canceled: [] };

  // Designated payer + payer method per family group in scope.
  const allGroupIds = Array.from(
    new Set([...groupIds, ...Array.from(members.values()).map((m) => m.family_group_id)]),
  ).filter((g): g is string => !!g);

  const payerByGroup = new Map<string, string | null>();
  if (allGroupIds.length > 0) {
    const { data: groups } = await supabaseAdmin
      .from("family_groups")
      .select("id, payer_member_id")
      .eq("dojo_id", dojoId)
      .in("id", allGroupIds);
    for (const g of (groups ?? []) as any[]) {
      payerByGroup.set(g.id as string, (g.payer_member_id as string | null) ?? null);
    }
  }

  const payerIds = Array.from(payerByGroup.values()).filter((p): p is string => !!p);
  const payerMethod = new Map<string, string>();
  if (payerIds.length > 0) {
    const { data: payers } = await supabaseAdmin
      .from("members")
      .select("id, payment_method")
      .eq("dojo_id", dojoId)
      .in("id", payerIds);
    for (const p of (payers ?? []) as any[]) {
      payerMethod.set(p.id as string, (p.payment_method as string) ?? "card");
    }
  }

  const violations: { member: MemberRow; reason: string }[] = [];
  for (const m of members.values()) {
    const groupId = m.family_group_id;
    const payerId = groupId ? (payerByGroup.get(groupId) ?? null) : null;
    const isPayer = !!payerId && payerId === m.id;

    if (groupId && payerId && !isPayer) {
      violations.push({
        member: m,
        reason: "covered family member — only the designated payer is billed",
      });
      continue;
    }
    if (groupId && payerId && isPayer && payerMethod.get(payerId) === "cash") {
      violations.push({
        member: m,
        reason: "the family's designated payer pays cash, so the family has no subscription",
      });
      continue;
    }
    if (m.plan_covered_by && m.plan_covered_by !== m.id) {
      violations.push({ member: m, reason: "covered by another member's plan" });
      continue;
    }
    if ((m.payment_method ?? "card") === "cash") {
      violations.push({ member: m, reason: "pays by cash" });
    }
  }
  if (violations.length === 0) return { canceled: [] };

  const { data: subs } = await supabaseAdmin
    .from("member_subscriptions")
    .select("id, member_id, stripe_subscription_id")
    .eq("dojo_id", dojoId)
    .in(
      "member_id",
      violations.map((v) => v.member.id),
    )
    .in("status", [...LIVE_SUB_STATUSES]);
  const live = (subs ?? []) as any[];
  if (live.length === 0) return { canceled: [] };

  const { hasStripeSecret, getPlatformStripe, cancelDuesSubscription, getConnectErrorMessage } =
    await import("@/lib/stripe-connect.server");

  const reasonFor = new Map(violations.map((v) => [v.member.id, v.reason]));
  const nameFor = new Map(violations.map((v) => [v.member.id, v.member.name]));
  const canceled: InvariantCancellation[] = [];

  for (const s of live) {
    if (s.stripe_subscription_id) {
      if (!hasStripeSecret()) {
        throw new Error(
          `Stripe isn't configured, so ${nameFor.get(s.member_id) ?? "a member"}'s subscription can't be stopped. Nothing was changed.`,
        );
      }
      try {
        await cancelDuesSubscription(
          getPlatformStripe(),
          s.stripe_subscription_id,
          "immediate",
        );
      } catch (err) {
        throw new Error(
          `Stripe would not cancel ${nameFor.get(s.member_id) ?? "a member"}'s subscription (${reasonFor.get(s.member_id)}): ${getConnectErrorMessage(err)}`,
        );
      }
    }
    await supabaseAdmin
      .from("member_subscriptions")
      .update({ status: "canceled", canceled_at: new Date().toISOString() })
      .eq("id", s.id);
    canceled.push({
      memberId: s.member_id as string,
      memberName: nameFor.get(s.member_id) ?? "Member",
      stripeSubscriptionId: (s.stripe_subscription_id as string | null) ?? null,
      reason: reasonFor.get(s.member_id) ?? "family billing invariant",
    });
  }

  return { canceled };
}
