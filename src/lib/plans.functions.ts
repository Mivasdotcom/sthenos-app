import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const STAFF_ROLES = ["owner", "manager", "admin"] as const;

async function assertManager(supabase: any, dojoId: string, userId: string) {
  const { data } = await supabase
    .from("dojo_memberships")
    .select("role")
    .eq("dojo_id", dojoId)
    .eq("user_id", userId)
    .single();
  if (!data || !STAFF_ROLES.includes(data.role)) {
    throw new Error("Unauthorized");
  }
}

export type DojoPlan = {
  id: string;
  dojo_id: string;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  interval: string; // "month" | "year" | "one_time"
  is_active: boolean;
  sort_order: number;
  stripe_price_id: string | null;
  plan_type: "individual" | "family";
  max_family_members: number | null;
};


export type PaymentStatus = "current" | "due" | "overdue" | "none";

export const listDojoPlans = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; includeArchived?: boolean }) => d)
  .handler(async ({ data, context }) => {
    const { supabase } = context as any;
    let q = supabase
      .from("dojo_plans")
      .select("*")
      .eq("dojo_id", data.dojoId)
      .order("sort_order", { ascending: true })
      .order("price_cents", { ascending: true });
    if (!data.includeArchived) q = q.eq("is_active", true);
    const { data: rows, error } = await q;
    if (error) throw error;
    return { plans: (rows ?? []) as DojoPlan[] };
  });

/**
 * How many people each plan is actually carrying, so nobody archives their main
 * plan without seeing that 40 members are on it. Counts the members a change
 * would affect: active, trial and paused (lapsed members are not being billed),
 * including family members whose payer holds the plan.
 */
export const getPlanMemberCounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertManager(supabase, data.dojoId, userId);
    const { data: rows, error } = await supabase
      .from("members")
      .select("id, selected_plan_id, plan_covered_by, status")
      .eq("dojo_id", data.dojoId)
      .in("status", ["active", "trial", "paused"]);
    if (error) throw error;

    const all = (rows ?? []) as any[];
    // A family member's own row carries no plan — their payer's plan covers
    // them, so they count against that plan as someone the change affects.
    const planByMemberId = new Map<string, string>();
    for (const r of all) if (r.selected_plan_id) planByMemberId.set(r.id, r.selected_plan_id);

    const counts: Record<string, number> = {};
    for (const r of all) {
      const planId =
        r.selected_plan_id ??
        (r.plan_covered_by ? planByMemberId.get(r.plan_covered_by) ?? null : null);
      if (!planId) continue;
      counts[planId] = (counts[planId] ?? 0) + 1;
    }

    return { counts };
  });


export const upsertPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      id?: string;
      dojoId: string;
      name: string;
      description?: string | null;
      priceCents: number;
      currency?: string;
      interval: "month" | "year" | "one_time";
      isActive?: boolean;
      sortOrder?: number;
      planType?: "individual" | "family";
      maxFamilyMembers?: number | null;
    }) => d,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertManager(supabase, data.dojoId, userId);
    const fallbackCurrency =
      data.currency ??
      (
        await supabase
          .from("dojos")
          .select("default_currency")
          .eq("id", data.dojoId)
          .single()
      ).data?.default_currency ??
      "usd";
    const planType = data.planType ?? "individual";
    let maxFamily: number | null = null;
    if (planType === "family") {
      const raw = data.maxFamilyMembers;
      if (raw != null) {
        const n = Math.floor(Number(raw));
        if (!Number.isFinite(n) || n < 2) {
          throw new Error("Family plans need a max of at least 2 members.");
        }
        maxFamily = n;
      }
    }
    const payload = {
      dojo_id: data.dojoId,
      name: data.name.trim(),
      description: data.description?.trim() || null,
      price_cents: Math.max(0, Math.round(data.priceCents)),
      currency: fallbackCurrency.toLowerCase(),
      interval: data.interval,
      is_active: data.isActive ?? true,
      sort_order: data.sortOrder ?? 0,
      plan_type: planType,
      max_family_members: maxFamily,
    };


    if (data.id) {
      const { data: row, error } = await supabase
        .from("dojo_plans")
        .update(payload)
        .eq("id", data.id)
        .select("*")
        .single();
      if (error) throw error;
      return { plan: row as DojoPlan };
    } else {
      const { data: row, error } = await supabase
        .from("dojo_plans")
        .insert(payload)
        .select("*")
        .single();
      if (error) throw error;
      return { plan: row as DojoPlan };
    }
  });

export const archivePlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; archived: boolean }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    const plan = await supabase
      .from("dojo_plans")
      .select("dojo_id")
      .eq("id", data.id)
      .single();
    if (plan.error || !plan.data) throw new Error("Plan not found");
    const membership = await supabase
      .from("dojo_memberships")
      .select("role")
      .eq("dojo_id", plan.data.dojo_id)
      .eq("user_id", userId)
      .in("role", STAFF_ROLES as unknown as string[])
      .maybeSingle();
    if (!membership.data) throw new Error("Not authorised");
    const { error } = await supabase
      .from("dojo_plans")
      .update({ is_active: !data.archived })
      .eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });

export const setMemberPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { memberId: string; dojoId: string; planId: string | null }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    // Explicit, rather than leaning on row-level security alone: this now
    // changes what a member is charged, in Stripe.
    await assertManager(supabase, data.dojoId, userId);

    // Reject family plans through this endpoint — they must go through
    // setMemberFamilyPlan so coverage propagates correctly.
    if (data.planId) {
      const { data: plan } = await supabase
        .from("dojo_plans")
        .select("plan_type")
        .eq("id", data.planId)
        .eq("dojo_id", data.dojoId)
        .maybeSingle();
      if (plan?.plan_type === "family") {
        throw new Error(
          "Assign family plans from the Family section — they need a group with at least 2 members.",
        );
      }
    }

    // STRIPE FIRST. Until now this function rewrote the plan in the database
    // and never told Stripe, so the member kept paying their old price with
    // every screen showing the new one. Moving the subscription before the
    // database means a refusal from Stripe throws here and changes nothing --
    // the two can never be left disagreeing.
    let billing: Awaited<
      ReturnType<typeof import("@/lib/member-plan-change.server").moveMemberSubscriptionToPlan>
    > | null = null;
    if (data.planId) {
      const { moveMemberSubscriptionToPlan } = await import("@/lib/member-plan-change.server");
      billing = await moveMemberSubscriptionToPlan({
        dojoId: data.dojoId,
        memberId: data.memberId,
        planId: data.planId,
      });
    }

    const { error } = await supabase
      .from("members")
      .update({
        selected_plan_id: data.planId,
        // Clearing/changing to individual removes any family coverage of others by this member
        plan_covered_by: null,
      })
      .eq("id", data.memberId)
      .eq("dojo_id", data.dojoId);
    if (error) throw error;

    // If this member was a family payer, uncover the rest of the group.
    await supabase
      .from("members")
      .update({ plan_covered_by: null })
      .eq("plan_covered_by", data.memberId);

    return { ok: true, billing };
  });


export const setMemberPaymentStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { memberId: string; dojoId: string; status: PaymentStatus }) => d,
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context as any;
    // TODO(stripe): payment status should be driven by webhook events
    // once live billing is enabled. For now, managers flip this manually.
    const { error } = await supabase
      .from("members")
      .update({
        payment_status: data.status,
        payment_status_updated_at: new Date().toISOString(),
      })
      .eq("id", data.memberId)
      .eq("dojo_id", data.dojoId);
    if (error) throw error;
    return { ok: true };
  });
