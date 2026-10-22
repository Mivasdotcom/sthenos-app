// Server-only: resolve the amount a family payer should actually be charged
// under tiered family pricing. Returns null when tiered pricing doesn't apply,
// in which case callers charge the plan price as before.
//
// The payer is ALWAYS the explicitly designated payer on the family group
// (family_groups.payer_member_id). It is never inferred from who happens to
// hold a plan, and only that member is ever charged.

import {
  DEFAULT_FAMILY_TIERS,
  computeFamilyQuote,
  type FamilyQuote,
} from "@/lib/family-pricing";

/** The designated payer for a family group, or null when none is chosen yet. */
export async function designatedPayerId(
  db: any,
  dojoId: string,
  groupId: string,
): Promise<string | null> {
  const { data } = await db
    .from("family_groups")
    .select("payer_member_id")
    .eq("id", groupId)
    .eq("dojo_id", dojoId)
    .maybeSingle();
  return (data?.payer_member_id as string | null) ?? null;
}

export type FamilyBillingRole =
  | { inFamily: false }
  | { inFamily: true; groupId: string; payerId: string | null; isPayer: boolean };

/** Whether this member is the one and only member the family bills. */
export async function familyBillingRole(
  db: any,
  dojoId: string,
  memberId: string,
): Promise<FamilyBillingRole> {
  const { data: me } = await db
    .from("members")
    .select("id, family_group_id")
    .eq("id", memberId)
    .eq("dojo_id", dojoId)
    .maybeSingle();
  if (!me?.family_group_id) return { inFamily: false };
  const payerId = await designatedPayerId(db, dojoId, me.family_group_id);
  return {
    inFamily: true,
    groupId: me.family_group_id as string,
    payerId,
    isPayer: payerId === memberId,
  };
}

export async function familyTotalForPayer(
  supabaseAdmin: any,
  dojoId: string,
  memberId: string,
  /**
   * `countPending` is for the signup checkout only. Everywhere else "pending"
   * means "has not paid", so a pending member is not billed. At signup it means
   * "is paying right now, through the checkout this quote is building" -- and
   * since every member of a brand-new family is pending in that instant, the
   * quote would otherwise total zero and create a subscription that bills
   * nothing for as long as it lives.
   */
  opts?: { countPending?: boolean },
): Promise<FamilyQuote | null> {
  const { data: dojo } = await supabaseAdmin
    .from("dojos")
    .select("family_pricing_mode, default_currency")
    .eq("id", dojoId)
    .maybeSingle();
  if ((dojo?.family_pricing_mode ?? "tiered") !== "tiered") return null;

  const { data: me } = await supabaseAdmin
    .from("members")
    .select("id, family_group_id")
    .eq("id", memberId)
    .eq("dojo_id", dojoId)
    .maybeSingle();
  if (!me?.family_group_id) return null;

  // Only the designated payer is ever charged the family total.
  const payerId = await designatedPayerId(supabaseAdmin, dojoId, me.family_group_id);
  if (payerId && payerId !== memberId) return null;

  const { data: rows } = await supabaseAdmin
    .from("members")
    .select(
      "id, name, status, trains, plan_price_cents, selected_plan_id, plan_covered_by, dojo_plans:selected_plan_id(id, name, price_cents, currency, interval, plan_type, dojo_id)",
    )
    .eq("dojo_id", dojoId)
    .eq("family_group_id", me.family_group_id)
    .order("name");
  const all = (rows ?? []) as any[];
  // Defensive: never price a family off a plan that belongs to another gym.
  for (const m of all) {
    if (m.dojo_plans && m.dojo_plans.dojo_id !== dojoId) {
      console.warn(
        `[family-pricing] member ${m.id} references plan ${m.dojo_plans.id} from another dojo — ignoring`,
      );
      m.dojo_plans = null;
    }
  }
  if (all.length < 2) return null;


  const { data: tierRows } = await supabaseAdmin
    .from("family_discount_tiers")
    .select("min_members, discount_percent")
    .eq("dojo_id", dojoId);
  const tiers = ((tierRows ?? []) as any[]).map((t) => ({
    min_members: Number(t.min_members),
    discount_percent: Number(t.discount_percent),
  }));

  const payerRow = all.find((m) => m.id === memberId) ?? null;
  const payerPlan = payerRow?.dojo_plans ?? null;
  const anyPlan = payerPlan ?? all.find((m) => m.dojo_plans)?.dojo_plans ?? null;
  const payerFallbackPrice =
    payerRow?.plan_price_cents ?? payerPlan?.price_cents ?? 0;
  // The family bills on ONE interval — the payer's. Members on a different
  // interval are normalised into it by computeFamilyQuote.
  const familyInterval = payerPlan?.interval ?? anyPlan?.interval ?? "month";

  // Members who are not paying (trial, paused, lapsed, pending…) are not
  // billed: computeFamilyQuote drops them from the total and the tier count
  // from their status, while they stay listed in the group.
  return computeFamilyQuote({
    members: all.map((m) => ({
      id: m.id,
      name: m.name,
      // "Pending" means two different things in a family. For the payer and
      // for anyone COVERED by them it means "being set up right now, through
      // this very checkout" -- those must be counted, or a new family prices
      // to nothing. For anyone else in the group it means "started joining
      // and never finished", and billing the payer for them would charge a
      // real card for a relative who never actually joined.
      status:
        opts?.countPending &&
        String(m.status) === "pending" &&
        (m.id === memberId || m.plan_covered_by === memberId)
          ? "active"
          : m.status,
      // A guardian who pays but doesn't train stays in the group and on the
      // breakdown, but buys nothing: no price, and no head for the tier.
      // This one is never relaxed -- they are not buying, at signup or later.
      trains: m.trains,
      planName: m.dojo_plans?.name ?? null,
      // Locked-in (grandfathered) prices win over the plan's current price.
      // Members with no plan of their own fall back to the payer's price so a
      // brand-new family signup is priced sensibly.
      priceCents:
        m.plan_price_cents ?? m.dojo_plans?.price_cents ?? payerFallbackPrice,
      interval: m.dojo_plans?.interval ?? familyInterval,
    })),
    tiers: tiers.length ? tiers : DEFAULT_FAMILY_TIERS,
    currency: anyPlan?.currency ?? dojo?.default_currency ?? "usd",
    interval: familyInterval,
  });
}


