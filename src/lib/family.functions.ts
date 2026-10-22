import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertStaff(supabase: any, dojoId: string, userId: string) {
  const { data } = await supabase
    .from("dojo_memberships")
    .select("role")
    .eq("dojo_id", dojoId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data || !["owner", "admin", "coach"].includes(data.role)) {
    throw new Error("Not authorised");
  }
}

export type FamilyGroup = {
  id: string;
  dojo_id: string;
  name: string;
  created_at: string;
  member_count?: number;
};

export const listFamilyGroups = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase } = context as any;
    const { data: rows, error } = await supabase
      .from("family_groups")
      .select(
        "id, dojo_id, name, created_at, members:members!members_family_group_id_fkey(count)",
      )
      .eq("dojo_id", data.dojoId)
      .order("name");
    if (error) throw error;
    const groups: FamilyGroup[] = (rows ?? []).map((g: any) => ({
      id: g.id,
      dojo_id: g.dojo_id,
      name: g.name,
      created_at: g.created_at,
      member_count: g.members?.[0]?.count ?? 0,
    }));
    return { groups };
  });

/**
 * Groups in this dojo whose name matches (case-insensitively) — used to stop
 * staff quietly creating a second "Kapsalis family".
 */
async function sameNameGroups(
  supabase: any,
  dojoId: string,
  name: string,
): Promise<{ id: string; name: string; member_count: number }[]> {
  const { data: rows } = await supabase
    .from("family_groups")
    .select("id, name, members:members!members_family_group_id_fkey(count)")
    .eq("dojo_id", dojoId)
    .ilike("name", name.trim());
  return ((rows ?? []) as any[]).map((g) => ({
    id: g.id as string,
    name: g.name as string,
    member_count: g.members?.[0]?.count ?? 0,
  }));
}

export const findFamilyGroupsByName = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; name: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertStaff(supabase, data.dojoId, userId);
    const name = (data.name ?? "").trim();
    if (name.length < 2) return { matches: [] };
    return { matches: await sameNameGroups(supabase, data.dojoId, name) };
  });

export const createFamilyGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { dojoId: string; name: string; allowDuplicateName?: boolean }) => d,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertStaff(supabase, data.dojoId, userId);
    const name = data.name.trim();
    if (name.length < 2 || name.length > 120) {
      throw new Error("Family name must be between 2 and 120 characters.");
    }
    if (!data.allowDuplicateName) {
      const dupes = await sameNameGroups(supabase, data.dojoId, name);
      if (dupes.length > 0) {
        throw new Error(
          `A family group called "${dupes[0]!.name}" already exists (${dupes[0]!.member_count} member${dupes[0]!.member_count === 1 ? "" : "s"}). Join that group instead of creating a duplicate.`,
        );
      }
    }
    const { data: row, error } = await supabase
      .from("family_groups")
      .insert({ dojo_id: data.dojoId, name })
      .select("*")
      .single();
    if (error) throw error;
    return { group: row };
  });


export const renameFamilyGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; dojoId: string; name: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertStaff(supabase, data.dojoId, userId);
    const { error } = await supabase
      .from("family_groups")
      .update({ name: data.name.trim() })
      .eq("id", data.id)
      .eq("dojo_id", data.dojoId);
    if (error) throw error;
    return { ok: true };
  });

export const deleteEmptyFamilyGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; groupId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertStaff(supabase, data.dojoId, userId);

    const { count, error: countError } = await supabase
      .from("members")
      .select("id", { count: "exact", head: true })
      .eq("dojo_id", data.dojoId)
      .eq("family_group_id", data.groupId);
    if (countError) throw countError;
    if ((count ?? 0) > 0) {
      throw new Error("This family group still has members and cannot be deleted.");
    }

    const { error } = await supabase
      .from("family_groups")
      .delete()
      .eq("id", data.groupId)
      .eq("dojo_id", data.dojoId);
    if (error) throw error;
    return { ok: true };
  });

/**
 * Assign a member to a family group (or clear it when groupId is null).
 * Also clears plan_covered_by when leaving a group.
 */
export const setMemberFamilyGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { memberId: string; dojoId: string; groupId: string | null }) => d,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertStaff(supabase, data.dojoId, userId);

    if (data.groupId) {
      // Verify the group belongs to this dojo
      const { data: g } = await supabase
        .from("family_groups")
        .select("id")
        .eq("id", data.groupId)
        .eq("dojo_id", data.dojoId)
        .maybeSingle();
      if (!g) throw new Error("Family group not found");

      // Enforce max_family_members if a payer in the group is on a family plan
      const { data: payer } = await supabase
        .from("members")
        .select("id, selected_plan_id, dojo_plans:selected_plan_id(plan_type, max_family_members)")
        .eq("family_group_id", data.groupId)
        .eq("dojo_id", data.dojoId)
        .not("selected_plan_id", "is", null)
        .maybeSingle();

      if (payer?.dojo_plans?.plan_type === "family" && payer?.dojo_plans?.max_family_members) {
        const { count } = await supabase
          .from("members")
          .select("id", { count: "exact", head: true })
          .eq("family_group_id", data.groupId);
        const currentCount = count ?? 0;
        // Only enforce if this member is not already in the group
        const { data: existing } = await supabase
          .from("members")
          .select("family_group_id")
          .eq("id", data.memberId)
          .maybeSingle();
        const alreadyIn = existing?.family_group_id === data.groupId;
        if (!alreadyIn && currentCount + 1 > payer.dojo_plans.max_family_members) {
          throw new Error(
            `This family plan is limited to ${payer.dojo_plans.max_family_members} members.`,
          );
        }
      }
    }

    const updates: Record<string, unknown> = { family_group_id: data.groupId };
    if (!data.groupId) {
      // Leaving a group clears any coverage
      updates.plan_covered_by = null;
    }
    const { error } = await supabase
      .from("members")
      .update(updates)
      .eq("id", data.memberId)
      .eq("dojo_id", data.dojoId);
    if (error) throw error;

    // If joining a group with a family-plan payer, auto-cover this member.
    if (data.groupId) {
      const { data: payer } = await supabase
        .from("members")
        .select("id, selected_plan_id, dojo_plans:selected_plan_id(plan_type)")
        .eq("family_group_id", data.groupId)
        .eq("dojo_id", data.dojoId)
        .not("selected_plan_id", "is", null)
        .maybeSingle();
      if (payer?.dojo_plans?.plan_type === "family" && payer.id !== data.memberId) {
        await supabase
          .from("members")
          .update({
            plan_covered_by: payer.id,
            payment_status: undefined,
          })
          .eq("id", data.memberId);
        // Sync payment_status from payer
        const { data: payerRow } = await supabase
          .from("members")
          .select("payment_status")
          .eq("id", payer.id)
          .maybeSingle();
        if (payerRow) {
          await supabase
            .from("members")
            .update({
              plan_covered_by: payer.id,
              payment_status: payerRow.payment_status,
              payment_status_updated_at: new Date().toISOString(),
            })
            .eq("id", data.memberId);
        }
      }
    }

    return { ok: true };
  });

/**
 * Assign a family plan to a member. Requires the member to be in a family
 * group with >= 2 members. Marks all other members in the group as covered_by
 * this payer and clears their selected_plan_id.
 */
export const setMemberFamilyPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { memberId: string; dojoId: string; planId: string }) => d,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertStaff(supabase, data.dojoId, userId);

    const { data: plan } = await supabase
      .from("dojo_plans")
      .select("id, plan_type, max_family_members")
      .eq("id", data.planId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (!plan) throw new Error("Plan not found");
    if (plan.plan_type !== "family") {
      throw new Error("This is not a family plan.");
    }

    const { data: member } = await supabase
      .from("members")
      .select("id, family_group_id")
      .eq("id", data.memberId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (!member?.family_group_id) {
      throw new Error("Add this member to a family group first.");
    }

    const { data: groupMembers, error: gErr } = await supabase
      .from("members")
      .select("id, payment_status")
      .eq("family_group_id", member.family_group_id);
    if (gErr) throw gErr;
    if (!groupMembers || groupMembers.length < 2) {
      throw new Error("A family plan requires at least 2 members in the group.");
    }
    if (plan.max_family_members && groupMembers.length > plan.max_family_members) {
      throw new Error(
        `This family plan allows up to ${plan.max_family_members} members; the group has ${groupMembers.length}.`,
      );
    }

    // Set payer
    const { data: payerRow, error: payerErr } = await supabase
      .from("members")
      .update({
        selected_plan_id: data.planId,
        plan_covered_by: null,
      })
      .eq("id", data.memberId)
      .eq("dojo_id", data.dojoId)
      .select("payment_status")
      .single();
    if (payerErr) throw payerErr;

    // Record the designated payer explicitly on the group — never inferred.
    const { error: gPayerErr } = await supabase
      .from("family_groups")
      .update({ payer_member_id: data.memberId })
      .eq("id", member.family_group_id)
      .eq("dojo_id", data.dojoId);
    if (gPayerErr) throw gPayerErr;

    // Cover the rest
    const otherIds = groupMembers.filter((m: any) => m.id !== data.memberId).map((m: any) => m.id);
    if (otherIds.length > 0) {
      // Under tiered family pricing every member keeps their own plan — the
      // payer is charged the discounted sum of them all.
      const { data: dojoRow } = await supabase
        .from("dojos")
        .select("family_pricing_mode")
        .eq("id", data.dojoId)
        .maybeSingle();
      const tiered = (dojoRow?.family_pricing_mode ?? "tiered") === "tiered";
      const { error: cErr } = await supabase
        .from("members")
        .update({
          plan_covered_by: data.memberId,
          ...(tiered ? {} : { selected_plan_id: null }),
          payment_status: payerRow?.payment_status ?? "none",
          payment_status_updated_at: new Date().toISOString(),
        })
        .in("id", otherIds);
      if (cErr) throw cErr;
    }


    return { ok: true };
  });

/**
 * Add one or more members to a family group — creating the group when a name
 * is supplied — and optionally nominate the payer whose plan covers the rest.
 */
export const addMembersToFamily = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      dojoId: string;
      memberIds: string[];
      groupId?: string | null;
      newGroupName?: string | null;
      payerId?: string | null;
      /** Explicitly create a second group with an existing name. */
      allowDuplicateName?: boolean;
    }) => d,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertStaff(supabase, data.dojoId, userId);

    const ids = Array.from(new Set(data.memberIds)).filter(Boolean);
    if (ids.length === 0) throw new Error("Select at least one member");

    let groupId = data.groupId ?? null;
    if (!groupId) {
      const name = (data.newGroupName ?? "").trim();
      if (name.length < 2 || name.length > 120) {
        throw new Error("Family name must be between 2 and 120 characters.");
      }
      if (!data.allowDuplicateName) {
        const dupes = await sameNameGroups(supabase, data.dojoId, name);
        if (dupes.length > 0) {
          throw new Error(
            `A family group called "${dupes[0]!.name}" already exists (${dupes[0]!.member_count} member${dupes[0]!.member_count === 1 ? "" : "s"}). Join that group instead of creating a duplicate.`,
          );
        }
      }
      const { data: created, error } = await supabase
        .from("family_groups")
        .insert({ dojo_id: data.dojoId, name })
        .select("id")
        .single();
      if (error) throw error;
      groupId = created.id as string;
    } else {
      const { data: g } = await supabase
        .from("family_groups")
        .select("id")
        .eq("id", groupId)
        .eq("dojo_id", data.dojoId)
        .maybeSingle();
      if (!g) throw new Error("Family group not found");
    }

    const { error: assignErr } = await supabase
      .from("members")
      .update({ family_group_id: groupId })
      .eq("dojo_id", data.dojoId)
      .in("id", ids);
    if (assignErr) throw assignErr;

    const payerId = data.payerId ?? null;
    if (!payerId) {
      throw new Error(
        "Choose the designated payer for this family. Only that member is charged; everyone else is covered by their plan.",
      );
    }
    let cashSwitched: string[] = [];
    {
      const { data: existingPayer } = await supabase
        .from("family_groups")
        .select("payer_member_id")
        .eq("id", groupId)
        .eq("dojo_id", data.dojoId)
        .maybeSingle();
      if (
        existingPayer?.payer_member_id &&
        existingPayer.payer_member_id !== payerId
      ) {
        throw new Error(
          "This family already has a designated payer. Use \"Change payer\" in the family section so the old subscription is cancelled first.",
        );
      }

      const { data: payer } = await supabase
        .from("members")
        .select("id, payment_status, selected_plan_id, payment_method")
        .eq("id", payerId)
        .eq("dojo_id", data.dojoId)
        .maybeSingle();
      if (!payer) throw new Error("Payer not found in this gym");
      if (!payer.selected_plan_id) {
        throw new Error("Assign a plan to the payer before making them cover the family.");
      }

      await supabase
        .from("members")
        .update({ plan_covered_by: null })
        .eq("id", payerId)
        .eq("dojo_id", data.dojoId);

      const { data: groupMembers } = await supabase
        .from("members")
        .select("id, name, payment_method")
        .eq("dojo_id", data.dojoId)
        .eq("family_group_id", groupId);
      const rows = (groupMembers ?? []) as any[];
      const others = rows.map((m) => m.id).filter((id: string) => id !== payerId);
      if (others.length > 0) {
        // Tiered family pricing sums each member's OWN plan price, so covered
        // members keep their plan. Flat pricing clears it, as before.
        const { data: dojoRow } = await supabase
          .from("dojos")
          .select("family_pricing_mode")
          .eq("id", data.dojoId)
          .maybeSingle();
        const tiered = (dojoRow?.family_pricing_mode ?? "tiered") === "tiered";
        // A family discount assumes ONE payer covers everyone, so covered
        // members follow the payer's payment method. Nobody is ever both
        // covered by the payer and expected to pay their own cash.
        const payerMethod = (payer.payment_method ?? "card") as "card" | "cash";
        cashSwitched = rows
          .filter(
            (m) => m.id !== payerId && (m.payment_method ?? "card") !== payerMethod,
          )
          .map((m) => m.name as string);
        const { error } = await supabase
          .from("members")
          .update({
            plan_covered_by: payerId,
            ...(tiered ? {} : { selected_plan_id: null }),
            payment_method: payerMethod,
            payment_status: payer.payment_status ?? "none",
            payment_status_updated_at: new Date().toISOString(),
          })
          .in("id", others);
        if (error) throw error;
      }

      const { error: setPayerErr } = await supabase
        .from("family_groups")
        .update({ payer_member_id: payerId })
        .eq("id", groupId)
        .eq("dojo_id", data.dojoId);
      if (setPayerErr) throw setPayerErr;
    }

    // Joining a family is one payment arrangement: cancel any subscription a
    // newly covered member still holds, and any at all if the payer pays cash.
    const { enforceFamilyBillingInvariants } = await import(
      "@/lib/family-invariants.server"
    );
    const invariants = await enforceFamilyBillingInvariants({
      dojoId: data.dojoId,
      groupIds: [groupId],
      memberIds: ids,
    });

    return {
      ok: true,
      groupId,
      count: ids.length,
      cashSwitched,
      canceledSubscriptions: invariants.canceled.length,
    };

  });


export type FamilyMemberRole = "payer" | "covered" | "unassigned";

export type FamilyOverviewMember = {
  id: string;
  name: string;
  role: FamilyMemberRole;
  status: string;
  paymentStatus: string | null;
  planName: string | null;
};

export type FamilyOverview = {
  group: { id: string; name: string } | null;
  members: FamilyOverviewMember[];
  payer: { id: string; name: string; paymentStatus: string | null } | null;
  plan: {
    id: string;
    name: string;
    price_cents: number;
    currency: string | null;
    interval: string | null;
    max_family_members: number | null;
  } | null;
  seatsLeft: number | null;
  /** A one-person "family" earns no discount and is almost always a mistake. */
  singleMember: boolean;
  /** Payment method the whole family is billed through. */
  payerPaymentMethod: "card" | "cash" | null;

  /** Plain-English problems staff should fix, e.g. a payer who left. */
  warnings: string[];
};

/**
 * Everything the staff-side "Family" section needs in one call: the group, who
 * pays, who is covered, the shared plan, seats left and any coverage gaps.
 */
export const getFamilyOverview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberId: string }) => d)
  .handler(async ({ data, context }): Promise<FamilyOverview> => {
    const { supabase, userId } = context as any;
    await assertStaff(supabase, data.dojoId, userId);

    const { data: me, error: meErr } = await supabase
      .from("members")
      .select("id, family_group_id, family_groups:family_group_id(id, name)")
      .eq("id", data.memberId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (meErr) throw meErr;
    if (!me) throw new Error("Member not found in this gym");

    const empty: FamilyOverview = {
      group: null,
      members: [],
      payer: null,
      plan: null,
      seatsLeft: null,
      singleMember: false,
      payerPaymentMethod: null,
      warnings: [],
    };

    if (!me.family_group_id) return empty;

    const { data: rows, error } = await supabase
      .from("members")
      .select(
        "id, name, status, payment_status, payment_method, selected_plan_id, plan_covered_by, dojo_plans:selected_plan_id(id, name, price_cents, currency, interval, plan_type, max_family_members)",
      )

      .eq("dojo_id", data.dojoId)
      .eq("family_group_id", me.family_group_id)
      .order("name");
    if (error) throw error;

    const all = (rows ?? []) as any[];
    const { data: groupRow } = await supabase
      .from("family_groups")
      .select("payer_member_id")
      .eq("id", me.family_group_id)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    const designatedPayerId = (groupRow?.payer_member_id as string | null) ?? null;
    const payerRow = all.find((m) => m.id === designatedPayerId) ?? null;

    const members: FamilyOverviewMember[] = all.map((m) => ({
      id: m.id,
      name: m.name,
      role: payerRow && m.id === payerRow.id ? "payer" : m.plan_covered_by ? "covered" : "unassigned",
      status: m.status,
      paymentStatus: m.payment_status ?? null,
      planName: m.dojo_plans?.name ?? null,
    }));

    const plan = payerRow?.dojo_plans
      ? {
          id: payerRow.dojo_plans.id,
          name: payerRow.dojo_plans.name,
          price_cents: payerRow.dojo_plans.price_cents,
          currency: payerRow.dojo_plans.currency ?? null,
          interval: payerRow.dojo_plans.interval ?? null,
          max_family_members: payerRow.dojo_plans.max_family_members ?? null,
        }
      : null;

    const warnings: string[] = [];
    const covered = members.filter((m) => m.role === "covered");
    if (!payerRow && covered.length > 0) {
      warnings.push(
        `${covered.length} member${covered.length === 1 ? "" : "s"} are marked as covered but nobody in this family is on a family plan. Choose a payer or move them onto their own plan.`,
      );
    }
    if (payerRow && ["lapsed", "pending"].includes(payerRow.status)) {
      warnings.push(
        `${payerRow.name} pays for this family but their membership is ${payerRow.status}. The covered members need a new payer or their own plan.`,
      );
    }
    if (payerRow && payerRow.payment_status === "overdue" && covered.length > 0) {
      warnings.push(
        `${payerRow.name}'s payment is overdue, so everyone covered by this family plan shows as overdue too.`,
      );
    }
    if (!payerRow && members.length > 1) {
      warnings.push(
        // The old wording said nobody was being billed, which read as harmless.
        // Everyone IS being billed -- separately, at full price -- so the gym
        // thinks it has given a family discount that nobody is receiving.
        "No payer chosen yet, so each member is billed separately at full price and the family discount isn't being applied. Choose the payer below.",
      );
    }
    const singleMember = members.length === 1;
    if (singleMember) {
      warnings.push(
        "This family group has only one member, so no family discount applies. Add the rest of the family, or dissolve the group and put this member on their own plan. If another group already exists for this family, merge them.",
      );
    }
    const payerPaymentMethod = payerRow
      ? ((payerRow.payment_method ?? "card") as "card" | "cash")
      : null;
    if (payerRow && payerPaymentMethod === "cash") {
      warnings.push(
        `${payerRow.name} pays by cash, so this whole family is a cash arrangement — the discounted family total is what ${payerRow.name} owes each period. Nobody else in the family is billed.`,
      );
    }

    const cap = plan?.max_family_members ?? null;

    return {
      group: me.family_groups ? { id: me.family_groups.id, name: me.family_groups.name } : null,
      members,
      payer: payerRow
        ? { id: payerRow.id, name: payerRow.name, paymentStatus: payerRow.payment_status ?? null }
        : null,
      plan,
      seatsLeft: cap ? Math.max(0, cap - members.length) : null,
      singleMember,
      payerPaymentMethod,
      warnings,
    };
  });


export type FamilyCoverageIssue = {
  groupId: string | null;
  groupName: string | null;
  payerName: string | null;
  payerStatus: string | null;
  members: { id: string; name: string }[];
  reason: "no_payer" | "payer_inactive";
};

/**
 * Gym-wide family coverage gaps: covered members whose payer has left,
 * cancelled, or was never chosen. Surfaced to staff instead of quietly
 * leaving those members unpaid.
 */
export type SingleMemberFamily = {
  groupId: string;
  groupName: string;
  member: { id: string; name: string } | null;
  /** Other groups in this dojo with the same name — likely duplicates. */
  duplicateOf: { id: string; name: string }[];
};

export const getFamilyCoverageIssues = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(
    async ({
      data,
      context,
    }): Promise<{
      issues: FamilyCoverageIssue[];
      singleMemberFamilies: SingleMemberFamily[];
      duplicateNames: { name: string; groups: { id: string; name: string }[] }[];
    }> => {
      const { supabase, userId } = context as any;
      await assertStaff(supabase, data.dojoId, userId);

      const { data: rows, error } = await supabase
        .from("members")
        .select(
          "id, name, status, family_group_id, plan_covered_by, selected_plan_id, family_groups:family_group_id(id, name), covered_by_member:plan_covered_by(id, name, status, selected_plan_id)",
        )
        .eq("dojo_id", data.dojoId)
        .in("status", ["active", "trial"])
        .order("name");
      if (error) throw error;

      // Members in a family group with no plan of their own and no live payer.
      const buckets = new Map<string, FamilyCoverageIssue>();
      for (const m of (rows ?? []) as any[]) {
        if (m.selected_plan_id) continue;
        const payer = m.covered_by_member;
        const payerBroken =
          !payer || !payer.selected_plan_id || ["lapsed", "pending"].includes(payer.status);
        if (!m.plan_covered_by && !m.family_group_id) continue;
        if (!payerBroken) continue;

        const key = m.family_group_id ?? `orphan:${m.id}`;
        const existing = buckets.get(key);
        if (existing) {
          existing.members.push({ id: m.id, name: m.name });
          continue;
        }
        buckets.set(key, {
          groupId: m.family_group_id ?? null,
          groupName: m.family_groups?.name ?? null,
          payerName: payer?.name ?? null,
          payerStatus: payer?.status ?? null,
          members: [{ id: m.id, name: m.name }],
          reason: payer ? "payer_inactive" : "no_payer",
        });
      }

      // One-person "families" earn no discount and duplicate-named groups are
      // almost always the same family entered twice.
      const { data: groupRows } = await supabase
        .from("family_groups")
        .select(
          "id, name, members:members!members_family_group_id_fkey(id, name)",
        )
        .eq("dojo_id", data.dojoId)
        .order("name");
      const groups = ((groupRows ?? []) as any[]).map((g) => ({
        id: g.id as string,
        name: g.name as string,
        members: ((g.members ?? []) as any[]).map((m) => ({
          id: m.id as string,
          name: m.name as string,
        })),
      }));

      const byName = new Map<string, { id: string; name: string }[]>();
      for (const g of groups) {
        const key = g.name.trim().toLowerCase();
        byName.set(key, [...(byName.get(key) ?? []), { id: g.id, name: g.name }]);
      }
      const duplicateNames = Array.from(byName.values())
        .filter((gs) => gs.length > 1)
        .map((gs) => ({ name: gs[0]!.name, groups: gs }));

      const singleMemberFamilies: SingleMemberFamily[] = groups
        .filter((g) => g.members.length <= 1)
        .map((g) => ({
          groupId: g.id,
          groupName: g.name,
          member: g.members[0] ?? null,
          duplicateOf: (byName.get(g.name.trim().toLowerCase()) ?? []).filter(
            (o) => o.id !== g.id,
          ),
        }));

      return {
        issues: Array.from(buckets.values()),
        singleMemberFamilies,
        duplicateNames,
      };
    },
  );


export type FamilyPayerCandidate = {
  id: string;
  name: string;
  planName: string | null;
  /** Their current payment method — as payer it governs the whole family. */
  paymentMethod: string | null;
  /** Already in the group, as opposed to being added now. */
  inGroup: boolean;
  isCurrentPayer: boolean;
};

/**
 * Everyone who could be the designated payer of the resulting family: the
 * members already in the group plus the ones about to be added.
 */
export const listFamilyPayerCandidates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { dojoId: string; groupId?: string | null; addMemberIds?: string[] }) => d,
  )
  .handler(async ({ data, context }): Promise<{
    candidates: FamilyPayerCandidate[];
    currentPayerId: string | null;
  }> => {
    const { supabase, userId } = context as any;
    await assertStaff(supabase, data.dojoId, userId);

    const groupId = data.groupId ?? null;
    const adds = Array.from(new Set(data.addMemberIds ?? [])).filter(Boolean);

    let currentPayerId: string | null = null;
    const groupIds: string[] = [];
    if (groupId) {
      const { data: g } = await supabase
        .from("family_groups")
        .select("id, payer_member_id")
        .eq("id", groupId)
        .eq("dojo_id", data.dojoId)
        .maybeSingle();
      if (!g) throw new Error("Family group not found");
      currentPayerId = (g.payer_member_id as string | null) ?? null;

      const { data: rows } = await supabase
        .from("members")
        .select("id")
        .eq("dojo_id", data.dojoId)
        .eq("family_group_id", groupId);
      for (const m of (rows ?? []) as any[]) groupIds.push(m.id);
    }

    const ids = Array.from(new Set([...groupIds, ...adds]));
    if (ids.length === 0) return { candidates: [], currentPayerId };

    const { data: rows, error } = await supabase
      .from("members")
      .select("id, name, payment_method, dojo_plans:selected_plan_id(name)")
      .eq("dojo_id", data.dojoId)
      .in("id", ids)
      .order("name");
    if (error) throw error;

    const inGroup = new Set(groupIds);
    const candidates: FamilyPayerCandidate[] = ((rows ?? []) as any[]).map((m) => ({
      id: m.id,
      name: m.name,
      planName: m.dojo_plans?.name ?? null,
      paymentMethod: m.payment_method ?? null,
      inGroup: inGroup.has(m.id),
      isCurrentPayer: m.id === currentPayerId,
    }));
    return { candidates, currentPayerId };
  });
