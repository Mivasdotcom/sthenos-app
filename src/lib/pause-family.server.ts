/**
 * Family helpers for pause previews.
 *
 * Kept out of pause.functions.ts because server-function splitting removes
 * runtime module-scope siblings from files that declare createServerFn.
 */

export async function familyContext(supabaseAdmin: any, dojoId: string, groupId: string | null) {
  if (!groupId) return { payerId: null as string | null, members: [] as any[] };
  const [{ data: group }, { data: members }] = await Promise.all([
    supabaseAdmin
      .from("family_groups")
      .select("payer_member_id")
      .eq("id", groupId)
      .eq("dojo_id", dojoId)
      .maybeSingle(),
    supabaseAdmin
      .from("members")
      .select(
        "id, name, status, plan_price_cents, selected_plan_id, dojo_plans:selected_plan_id(name, price_cents, currency, interval)",
      )
      .eq("dojo_id", dojoId)
      .eq("family_group_id", groupId)
      .order("name"),
  ]);
  return {
    payerId: (group?.payer_member_id as string | null) ?? null,
    members: (members ?? []) as any[],
  };
}

export async function quoteFamily(
  supabaseAdmin: any,
  dojoId: string,
  members: any[],
  excludeIds: string[],
  currency: string,
  interval: string,
) {
  const { computeFamilyQuote, DEFAULT_FAMILY_TIERS } = await import("@/lib/family-pricing");
  const { data: tierRows } = await supabaseAdmin
    .from("family_discount_tiers")
    .select("min_members, discount_percent")
    .eq("dojo_id", dojoId);
  const tiers = ((tierRows ?? []) as any[]).length
    ? ((tierRows ?? []) as any[]).map((t) => ({
        min_members: Number(t.min_members),
        discount_percent: Number(t.discount_percent),
      }))
    : DEFAULT_FAMILY_TIERS;
  // Non-paying members (trial, paused, lapsed…) are excluded by
  // computeFamilyQuote from the member's status — the single shared rule.
  const billable = members.filter((m) => !excludeIds.includes(m.id));
  return computeFamilyQuote({
    members: billable.map((m) => ({
      id: m.id,
      name: m.name,
      status: m.status,
      priceCents: Number(m.plan_price_cents ?? m.dojo_plans?.price_cents ?? 0),
      // Own plan interval, normalised into the family's interval below.
      interval: (m.dojo_plans?.interval as string) ?? interval,
    })),
    tiers,
    currency,
    interval,
  });
}

/** The family bills on ONE interval: the designated payer's plan interval. */
export function familyIntervalOf(members: any[], payerId: string | null): string {
  const payer = payerId ? members.find((m) => m.id === payerId) : null;
  return (
    (payer?.dojo_plans?.interval as string) ??
    (members.find((m) => m.dojo_plans)?.dojo_plans?.interval as string) ??
    "month"
  );
}

