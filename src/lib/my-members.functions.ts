import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  listActingMembers,
  resolveActingMember,
  type ActingMember,
} from "@/lib/managed-members.server";

/**
 * The member portal, for whoever the login is currently acting for.
 *
 * A parent reads their child's record, which their own client cannot see, so
 * these run on the admin client behind an explicit authorisation check rather
 * than on the caller's client behind RLS.
 */

/** Everyone this login can switch between: themselves, then their children. */
export const listMyMembers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }): Promise<{ members: ActingMember[] }> => {
    const { userId } = context as any;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const members = await listActingMembers(supabaseAdmin, userId, data.dojoId);
    return { members };
  });

const MEMBER_COLUMNS =
  "*, family_groups:family_group_id(id,name), covered_by_member:plan_covered_by(id,name,dojo_plans:selected_plan_id(name))";

/** Everything the portal shows about one member. */
export const getPortalSnapshot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberId?: string | null }) => d)
  .handler(async ({ data, context }) => {
    const { userId } = context as any;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let member: any;
    try {
      member = await resolveActingMember({
        db: supabaseAdmin,
        userId,
        dojoId: data.dojoId,
        memberId: data.memberId ?? null,
        columns: MEMBER_COLUMNS,
      });
    } catch {
      // A login with no member record of its own is normal for a parent whose
      // children were added from the portal -- the caller falls back to the
      // first member in their list.
      return {
        member: null,
        attendances: [],
        subscription: null,
        plan: null,
        paymentMethod: null,
        monthCount: 0,
      };
    }

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [attRes, subRes, pmRes, monthRes] = await Promise.all([
      supabaseAdmin
        .from("attendances")
        .select("id, checked_in_at, class_id, classes:class_id(name)")
        .eq("member_id", member.id)
        .eq("dojo_id", data.dojoId)
        .order("checked_in_at", { ascending: false })
        .limit(20),
      supabaseAdmin
        .from("member_subscriptions")
        .select("*, dojo_plans:plan_id(name, interval, price_cents, currency)")
        .eq("member_id", member.id)
        .eq("dojo_id", data.dojoId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from("member_payment_methods")
        .select("brand, last4, stripe_payment_method_id")
        .eq("member_id", member.id)
        .eq("dojo_id", data.dojoId)
        .maybeSingle(),
      supabaseAdmin
        .from("attendances")
        .select("id", { count: "exact", head: true })
        .eq("member_id", member.id)
        .eq("dojo_id", data.dojoId)
        .gte("checked_in_at", startOfMonth.toISOString()),
    ]);

    return {
      member,
      attendances: attRes.data ?? [],
      subscription: subRes.data ?? null,
      plan: (subRes.data as any)?.dojo_plans ?? null,
      paymentMethod: pmRes.data ?? null,
      monthCount: monthRes.count ?? 0,
    };
  });

/**
 * A member's billing state, for whoever may act for them.
 *
 * The same reads used to run on the caller's own client, which works for your
 * own record and returns nothing at all for a child's -- so a parent saw "no
 * plan" for a child they were being billed for.
 */
export const getMemberBilling = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberId: string }) => d)
  .handler(async ({ data, context }) => {
    const { userId, supabase } = context as any;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let member: any = null;
    try {
      member = await resolveActingMember({
        db: supabaseAdmin,
        userId,
        dojoId: data.dojoId,
        memberId: data.memberId,
        columns:
          "id, selected_plan_id, stripe_customer_id, dojo_plans:selected_plan_id(id, name, price_cents, currency, interval)",
      });
    } catch {
      // Staff read anyone in their own gym; this is the same rule the rest of
      // the billing pages use.
      const { data: role } = await supabase
        .from("dojo_memberships")
        .select("role")
        .eq("user_id", userId)
        .eq("dojo_id", data.dojoId)
        .maybeSingle();
      if (!role || !["owner", "admin", "coach"].includes(String(role.role))) {
        throw new Error("Not allowed");
      }
      const { data: row } = await supabaseAdmin
        .from("members")
        .select(
          "id, selected_plan_id, stripe_customer_id, dojo_plans:selected_plan_id(id, name, price_cents, currency, interval)",
        )
        .eq("id", data.memberId)
        .eq("dojo_id", data.dojoId)
        .maybeSingle();
      member = row;
    }
    if (!member) throw new Error("Member not found");

    const [{ data: subs }, { data: dojo }] = await Promise.all([
      supabaseAdmin
        .from("member_subscriptions")
        .select(
          "id, status, current_period_end, cancel_at_period_end, plan_id, dojo_plans:plan_id(id, name, price_cents, currency, interval)",
        )
        .eq("member_id", member.id)
        .eq("dojo_id", data.dojoId)
        .order("created_at", { ascending: false }),
      supabaseAdmin
        .from("dojos")
        .select("pass_platform_fee_to_members")
        .eq("id", data.dojoId)
        .maybeSingle(),
    ]);

    const list = (subs ?? []) as any[];
    const active =
      list.find((s) => ["active", "trialing", "past_due"].includes(s.status)) ?? null;
    const latest = active ?? list[0] ?? null;
    const plan = latest?.dojo_plans ?? member?.dojo_plans ?? null;

    return {
      memberId: member.id as string,
      planId: (plan?.id ?? member?.selected_plan_id ?? null) as string | null,
      planName: (plan?.name ?? null) as string | null,
      planPriceCents: (plan?.price_cents ?? null) as number | null,
      planCurrency: (plan?.currency ?? null) as string | null,
      planInterval: (plan?.interval ?? null) as string | null,
      subscription: latest
        ? {
            id: latest.id as string,
            status: latest.status as string,
            current_period_end: latest.current_period_end as string | null,
            cancel_at_period_end: !!latest.cancel_at_period_end,
          }
        : null,
      hasActiveSubscription: !!active,
      hasBillingAccount: !!active || !!member?.stripe_customer_id,
      passPlatformFee: !!(dojo as any)?.pass_platform_fee_to_members,
      planBasePriceCents: (plan?.price_cents ?? null) as number | null,
    };
  });

export type PortalPayment = {
  id: string;
  amount_cents: number;
  currency: string;
  status: string | null;
  when: string | null;
  paid: boolean;
  refunded_amount_cents: number | null;
  hosted_invoice_url: string | null;
  cash: boolean;
};

/** What a member has paid -- card invoices and cash taken at the desk. */
export const getPortalPayments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberId: string }) => d)
  .handler(async ({ data, context }): Promise<{ payments: PortalPayment[] }> => {
    const { userId } = context as any;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const member = await resolveActingMember({
      db: supabaseAdmin,
      userId,
      dojoId: data.dojoId,
      memberId: data.memberId,
      columns: "id",
    });

    const [cardRes, cashRes] = await Promise.all([
      supabaseAdmin
        .from("invoices")
        .select(
          "id, amount_cents, currency, status, due_date, paid_at, refunded_amount_cents, hosted_invoice_url, payment_method",
        )
        .eq("member_id", member.id)
        .eq("dojo_id", data.dojoId)
        .order("paid_at", { ascending: false })
        .limit(24),
      supabaseAdmin
        .from("cash_payments")
        .select("id, amount_cents, currency, paid_on")
        .eq("member_id", member.id)
        .eq("dojo_id", data.dojoId)
        .order("paid_on", { ascending: false })
        .limit(24),
    ]);
    if (cardRes.error) throw cardRes.error;
    if (cashRes.error) throw cashRes.error;

    const payments: PortalPayment[] = [
      ...((cardRes.data ?? []) as any[]).map((row) => ({
        id: row.id,
        amount_cents: row.amount_cents,
        currency: row.currency,
        status: row.status,
        when: row.paid_at ?? (row.due_date ? `${row.due_date}T00:00:00Z` : null),
        paid: !!row.paid_at,
        refunded_amount_cents: row.refunded_amount_cents ?? null,
        hosted_invoice_url: (row.hosted_invoice_url as string | null) ?? null,
        cash: false,
      })),
      ...((cashRes.data ?? []) as any[]).map((row) => ({
        id: row.id,
        amount_cents: row.amount_cents,
        currency: row.currency,
        status: "paid",
        when: row.paid_on ? `${row.paid_on}T00:00:00Z` : null,
        paid: true,
        refunded_amount_cents: null,
        hosted_invoice_url: null,
        cash: true,
      })),
    ];

    payments.sort((a, b) => (b.when ?? "").localeCompare(a.when ?? ""));
    return { payments };
  });
