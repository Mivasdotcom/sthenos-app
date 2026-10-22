import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  getConnectErrorMessage,
  getPlatformStripe,
  hasStripeSecret,
} from "@/lib/stripe-connect.server";

const STAFF_ROLES = new Set(["owner", "admin"]);

async function assertOwnerOrAdmin(supabase: any, userId: string, dojoId: string) {
  const { data } = await supabase
    .from("dojo_memberships")
    .select("role")
    .eq("user_id", userId)
    .eq("dojo_id", dojoId)
    .maybeSingle();
  if (!data || !STAFF_ROLES.has(data.role)) throw new Error("Not allowed");
}

/**
 * Newer Stripe API versions moved the subscription off the invoice's top
 * level into `invoice.parent.subscription_details`.
 */
function invoiceSubscriptionId(invoice: any): string | null {
  const top = invoice?.subscription;
  if (typeof top === "string") return top;
  if (top?.id) return top.id;
  const parent = invoice?.parent?.subscription_details?.subscription;
  if (typeof parent === "string") return parent;
  if (parent?.id) return parent.id;
  return null;
}

function invoiceSubscriptionMetadata(invoice: any): any {
  return invoice?.parent?.subscription_details?.metadata ?? invoice?.metadata ?? {};
}

/**
 * Owner-only backfill: this platform uses DESTINATION charges, so all
 * customers, subscriptions and invoices live on the PLATFORM Stripe account
 * (funds are transferred to each gym's connected account). We therefore list
 * invoices on the platform account and keep only those belonging to this dojo.
 * Idempotent — upserts on `stripe_invoice_id`.
 */
export const backfillInvoicesFromStripe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; limit?: number }) =>
    z.object({ dojoId: z.string().uuid(), limit: z.number().int().min(1).max(2000).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    if (!hasStripeSecret()) return { inserted: 0, scanned: 0, error: "Stripe not configured" as string | null };
    await assertOwnerOrAdmin(context.supabase, context.userId, data.dojoId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Local maps for this dojo, so we can attribute platform invoices.
    const { data: subs } = await supabaseAdmin
      .from("member_subscriptions")
      .select("id, member_id, dojo_id, plan_id, stripe_subscription_id, stripe_customer_id")
      .eq("dojo_id", data.dojoId);
    const bySubId = new Map<string, any>();
    const byCustId = new Map<string, any>();
    for (const s of subs ?? []) {
      if (s.stripe_subscription_id) bySubId.set(s.stripe_subscription_id, s);
      if (s.stripe_customer_id) byCustId.set(s.stripe_customer_id, s);
    }

    // Plan labels resolved from the actual plan rows behind each subscription,
    // so an annual member is never backfilled as "Monthly".
    const { data: planRows } = await supabaseAdmin
      .from("dojo_plans")
      .select("id, interval, plan_type")
      .eq("dojo_id", data.dojoId);
    const planLabelById = new Map<string, string>();
    for (const p of planRows ?? []) {
      const label =
        (p.plan_type ?? "").toLowerCase() === "family"
          ? "Family"
          : p.interval === "year"
            ? "Annual"
            : p.interval === "one_time"
              ? "Drop-in"
              : p.interval === "month"
                ? "Monthly"
                : null;
      if (label) planLabelById.set(p.id, label);
    }

    const { data: members } = await supabaseAdmin
      .from("members")
      .select("id, dojo_id, plan, stripe_customer_id")
      .eq("dojo_id", data.dojoId);
    const memberById = new Map<string, any>();
    for (const m of members ?? []) {
      memberById.set(m.id, m);
      if (m.stripe_customer_id) byCustId.set(m.stripe_customer_id, { member_id: m.id, dojo_id: m.dojo_id, id: null, plan_id: null });
    }

    const stripe = getPlatformStripe();
    let inserted = 0;
    let scanned = 0;
    const cap = data.limit ?? 1000;

    try {
      // Platform account listing (no stripeAccount header).
      const iter = stripe.invoices.list({ status: "paid", limit: 100 });

      for await (const invoice of iter as any) {
        scanned++;
        if (scanned > cap) break;

        const subId = invoiceSubscriptionId(invoice);
        const custId =
          typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id ?? null;
        const md = invoiceSubscriptionMetadata(invoice);

        let memberId: string | null = null;
        let subscriptionRowId: string | null = null;
        let planId: string | null = null;

        const subRow = subId ? bySubId.get(subId) : undefined;
        if (subRow) {
          memberId = subRow.member_id;
          subscriptionRowId = subRow.id ?? null;
          planId = subRow.plan_id ?? null;
        } else if (custId && byCustId.has(custId)) {
          const row = byCustId.get(custId);
          memberId = row.member_id;
          subscriptionRowId = row.id ?? null;
          planId = row.plan_id ?? null;
        } else if (md?.type === "member_dues" && md?.dojoId === data.dojoId && md?.memberId) {
          memberId = md.memberId;
        }

        if (!memberId || !memberById.has(memberId)) continue;

        const paidAtSec =
          invoice.status_transitions?.paid_at ?? invoice.created ?? Math.floor(Date.now() / 1000);
        const paidAt = new Date(paidAtSec * 1000).toISOString();

        const { error: upErr } = await supabaseAdmin.from("invoices").upsert(
          {
            member_id: memberId,
            dojo_id: data.dojoId,
            subscription_id: subscriptionRowId,
            plan: ((planId ? planLabelById.get(planId) : null) ??
              memberById.get(memberId)?.plan ??
              "Unknown") as any,
            amount_cents: invoice.amount_paid ?? invoice.amount_due ?? 0,
            currency: (invoice.currency ?? "usd").toLowerCase(),
            status: "paid" as any,
            due_date: paidAt.slice(0, 10),
            paid_at: paidAt,
            period_start: invoice.period_start
              ? new Date(invoice.period_start * 1000).toISOString()
              : null,
            period_end: invoice.period_end
              ? new Date(invoice.period_end * 1000).toISOString()
              : null,
            stripe_invoice_id: invoice.id,
            hosted_invoice_url: invoice.hosted_invoice_url ?? null,
            invoice_number: invoice.number ?? null,
          },
          { onConflict: "stripe_invoice_id", ignoreDuplicates: false },
        );
        if (!upErr) inserted++;
        else console.error("backfill upsert failed", invoice.id, upErr);

        // Cache the customer id and mark the member as current.
        if (custId) {
          await supabaseAdmin
            .from("members")
            .update({ stripe_customer_id: custId })
            .eq("id", memberId)
            .is("stripe_customer_id", null);
        }
        await supabaseAdmin
          .from("members")
          .update({
            payment_status: "current",
            payment_status_updated_at: new Date().toISOString(),
          })
          .eq("id", memberId)
          .in("payment_status", ["none", "overdue", "due"]);
      }

      return { inserted, scanned, error: null as string | null };
    } catch (e) {
      console.error("backfillInvoicesFromStripe failed", e);
      return { inserted, scanned, error: getConnectErrorMessage(e) };
    }
  });

/**
 * Owner/admin only: fetch every non-canceled subscription for the dojo from
 * Stripe and write the TRUE status + current_period_start/end back to
 * member_subscriptions, repairing stale rows. Then recompute payment_status
 * (evidence-based) and retention scores, which depend on payment_status.
 */
export const reconcileSubscriptionPeriods = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => z.object({ dojoId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    if (!hasStripeSecret()) {
      return { repaired: 0, checked: 0, statusChanges: 0, error: "Stripe not configured" as string | null };
    }
    await assertOwnerOrAdmin(context.supabase, context.userId, data.dojoId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: subs, error } = await supabaseAdmin
      .from("member_subscriptions")
      .select("id, stripe_subscription_id, status, current_period_start, current_period_end")
      .eq("dojo_id", data.dojoId)
      .not("stripe_subscription_id", "is", null);
    if (error) throw error;

    const stripe = getPlatformStripe();
    let checked = 0;
    let repaired = 0;
    let firstError: string | null = null;

    for (const row of subs ?? []) {
      checked++;
      try {
        const sub: any = await stripe.subscriptions.retrieve(row.stripe_subscription_id as string);
        const item = sub.items?.data?.[0];
        const startSec = item?.current_period_start ?? sub.current_period_start ?? null;
        const endSec = item?.current_period_end ?? sub.current_period_end ?? null;
        const start = startSec ? new Date(startSec * 1000).toISOString() : null;
        const end = endSec ? new Date(endSec * 1000).toISOString() : null;
        const changed =
          sub.status !== row.status ||
          start !== row.current_period_start ||
          end !== row.current_period_end;
        if (!changed) continue;
        const { error: upErr } = await supabaseAdmin
          .from("member_subscriptions")
          .update({
            status: sub.status,
            current_period_start: start,
            current_period_end: end,
            cancel_at_period_end: !!sub.cancel_at_period_end,
            canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
          })
          .eq("id", row.id);
        if (upErr) throw upErr;
        repaired++;
      } catch (e) {
        console.error("reconcileSubscriptionPeriods: failed", row.stripe_subscription_id, e);
        firstError = firstError ?? getConnectErrorMessage(e);
      }
    }

    // Evidence-based payment status recompute, then retention (it reads payment_status).
    let statusChanges = 0;
    const { data: rpcData, error: rpcErr } = await (supabaseAdmin as any).rpc(
      "recompute_member_payment_statuses",
      { _dojo_id: data.dojoId },
    );
    if (rpcErr) {
      console.error("recompute_member_payment_statuses failed", rpcErr);
      firstError = firstError ?? rpcErr.message;
    } else {
      statusChanges = Number(rpcData ?? 0);
    }

    try {
      const { recomputeRetentionForDojo } = await import("./retention.functions");
      await recomputeRetentionForDojo(supabaseAdmin, data.dojoId);
    } catch (e: any) {
      console.error("retention recompute after reconcile failed", e);
    }

    return { repaired, checked, statusChanges, error: firstError };
  });
