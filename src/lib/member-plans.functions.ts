import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { DojoPlan } from "@/lib/plans.functions";

/**
 * Member-facing plan selection.
 *
 * A member who signed up without a plan previously had no way to ever start
 * paying — checkout was gated on already having `selected_plan_id`. These two
 * functions let the member pick one of THEIR OWN gym's active plans from the
 * portal and go straight to Stripe Checkout.
 *
 * Rules enforced server-side (never trust the client):
 *  - the member row must belong to the signed-in user and the given dojo
 *  - a member covered by a family payer is never offered checkout
 *  - the plan must be active, belong to the same dojo, and not be a family plan
 *    (family plans need a group and a designated payer — staff assign those)
 */

export type MyPlanOptions = {
  memberId: string | null;
  status: string | null;
  paymentMethod: string | null;
  selectedPlanId: string | null;
  /** Set when this member is paid for by a family payer. */
  coveredBy: { name: string | null; planName: string | null } | null;
  /** The gym can actually take card payments today. */
  onlinePaymentsEnabled: boolean;
  passPlatformFee: boolean;
  /** How the gym anchors billing — used for member-facing timing copy only. */
  billingMode: "fixed_day" | "anniversary";
  billingDayOfMonth: number | null;
  hasActiveSubscription: boolean;
  plans: DojoPlan[];
};

export const getMyPlanOptions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ dojoId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<MyPlanOptions> => {
    const { supabase, userId } = context as any;

    const { data: member, error } = await supabase
      .from("members")
      .select(
        "id, status, payment_method, selected_plan_id, plan_covered_by, covered_by_member:plan_covered_by(name, dojo_plans:selected_plan_id(name))",
      )
      .eq("user_id", userId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (error) throw new Error(error.message);

    const empty: MyPlanOptions = {
      memberId: null,
      status: null,
      paymentMethod: null,
      selectedPlanId: null,
      coveredBy: null,
      onlinePaymentsEnabled: false,
      passPlatformFee: false,
      billingMode: "fixed_day",
      billingDayOfMonth: null,
      hasActiveSubscription: false,
      plans: [],
    };
    if (!member) return empty;

    const [{ data: dojo }, { data: planRows }, { data: subs }] = await Promise.all([
      supabase
        .from("dojos")
        .select("stripe_charges_enabled, pass_platform_fee_to_members, billing_mode, billing_day_of_month")
        .eq("id", data.dojoId)
        .maybeSingle(),
      supabase
        .from("dojo_plans")
        .select(
          "id, dojo_id, name, description, price_cents, currency, interval, is_active, sort_order, plan_type, max_family_members",
        )
        .eq("dojo_id", data.dojoId)
        .eq("is_active", true)
        .neq("plan_type", "family")
        .order("sort_order", { ascending: true })
        .order("price_cents", { ascending: true }),
      supabase
        .from("member_subscriptions")
        .select("id, status")
        .eq("member_id", (member as any).id)
        .eq("dojo_id", data.dojoId),
    ]);

    return {
      memberId: (member as any).id,
      status: (member as any).status ?? null,
      paymentMethod: (member as any).payment_method ?? null,
      selectedPlanId: (member as any).selected_plan_id ?? null,
      coveredBy: (member as any).plan_covered_by
        ? {
            name: (member as any).covered_by_member?.name ?? null,
            planName: (member as any).covered_by_member?.dojo_plans?.name ?? null,
          }
        : null,
      onlinePaymentsEnabled: !!(dojo as any)?.stripe_charges_enabled,
      passPlatformFee: !!(dojo as any)?.pass_platform_fee_to_members,
      billingMode: (dojo as any)?.billing_mode === "anniversary" ? "anniversary" : "fixed_day",
      billingDayOfMonth: (dojo as any)?.billing_day_of_month ?? null,
      hasActiveSubscription: ((subs ?? []) as any[]).some((s) =>
        ["active", "trialing", "past_due"].includes(s.status),
      ),
      plans: ((planRows ?? []) as any[]).map((p) => ({
        ...p,
        stripe_price_id: null,
      })) as DojoPlan[],
    };
  });

/**
 * Validate and persist the member's own plan choice, returning the memberId so
 * the caller can immediately open Checkout via createCheckoutSession (which
 * re-validates ownership and dojo scope independently).
 */
export const selectMyPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ dojoId: z.string().uuid(), planId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;

    const { data: member, error } = await supabase
      .from("members")
      .select("id, plan_covered_by, payment_method")
      .eq("user_id", userId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!member) return { ok: false as const, memberId: null, error: "Member record not found." };
    if ((member as any).plan_covered_by) {
      return {
        ok: false as const,
        memberId: null,
        error: "Your membership is already paid for by your family's payer.",
      };
    }

    const { data: plan } = await supabase
      .from("dojo_plans")
      .select("id, is_active, plan_type")
      .eq("id", data.planId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (!plan || !(plan as any).is_active) {
      return { ok: false as const, memberId: null, error: "That plan isn't available." };
    }
    if ((plan as any).plan_type === "family") {
      return {
        ok: false as const,
        memberId: null,
        error: "Family plans are set up by your gym — please contact them.",
      };
    }

    // The members self-update trigger deliberately blocks members from
    // changing selected_plan_id directly; go through the admin client after
    // the ownership + plan checks above.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error: upErr } = await supabaseAdmin
      .from("members")
      .update({ selected_plan_id: data.planId })
      .eq("id", (member as any).id)
      .eq("dojo_id", data.dojoId);
    if (upErr) throw new Error(upErr.message);

    return { ok: true as const, memberId: (member as any).id as string, error: null };
  });
