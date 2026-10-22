/**
 * Server-only: bring the APPLICATION FEE on live Stripe subscriptions up to
 * the amount that actually covers Stripe's cost as well as the platform's
 * margin.
 *
 * Subscriptions created before this carried an application fee of the
 * platform's 1% alone. These are destination charges, so Stripe debits its own
 * fee from the PLATFORM's balance and transfers the rest to the gym -- meaning
 * the platform paid the gym's card fees and went roughly 58 cents down on every
 * €65.65 payment, while the gym received the full list price.
 *
 * This is NOT a price change. The member is charged exactly the same amount
 * before and after; only the split between platform and gym moves, to what was
 * agreed. So it needs no notice period and no pending-price machinery, unlike
 * fee-drift.server.ts which changes what members actually pay.
 *
 * Nothing is ever clawed back: Stripe applies an application fee to FUTURE
 * invoices only, so past payments are untouched by design.
 */
import { LIVE_STATUSES } from "./subscription-statuses";
import { PLATFORM_FEE_PERCENT, subscriptionAppFeePercent } from "./platform-fee";

export type RealignResult = {
  checked: number;
  updated: number;
  skipped: number;
  details: Array<{
    subscriptionId: string;
    from: number | null;
    to: number;
    grossCents: number;
  }>;
};

/**
 * @param dojoId scope to one gym, or omit for every gym on the platform.
 */
export async function realignApplicationFees(args: {
  dojoId?: string;
  dryRun?: boolean;
}): Promise<RealignResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { hasStripeSecret, getPlatformStripe, duesRequestOptions, getConnectErrorMessage } =
    await import("./stripe-connect.server");

  const out: RealignResult = { checked: 0, updated: 0, skipped: 0, details: [] };
  if (!hasStripeSecret()) return out;

  let q = supabaseAdmin
    .from("member_subscriptions")
    .select("id, dojo_id, stripe_subscription_id, status")
    .in("status", [...LIVE_STATUSES]);
  if (args.dojoId) q = q.eq("dojo_id", args.dojoId);
  const { data: subs, error } = await q;
  if (error) throw error;

  const candidates = ((subs ?? []) as any[]).filter((s) => s.stripe_subscription_id);
  if (candidates.length === 0) return out;

  // Which gyms pass the platform's 1% on to members: that decides how much of
  // the charge is the gym's listed price and how much is the platform's fee.
  const dojoIds = Array.from(new Set(candidates.map((s) => s.dojo_id)));
  const { data: dojos } = await supabaseAdmin
    .from("dojos")
    .select("id, pass_platform_fee_to_members, archived_at")
    .in("id", dojoIds);
  const passFeeBy = new Map<string, boolean>(
    ((dojos ?? []) as any[]).map((d) => [d.id, !!d.pass_platform_fee_to_members]),
  );
  // Archived gyms are skipped, as every other nightly sweep already does. An
  // archived test gym still listed subscriptions created in Stripe's TEST mode,
  // which don't exist in live mode -- so this asked Stripe to update twenty
  // subscriptions it had never heard of, every night, drowning out any real
  // failure in the noise.
  const archived = new Set(
    ((dojos ?? []) as any[]).filter((d) => d.archived_at).map((d) => d.id),
  );
  const live = candidates.filter((s) => !archived.has(s.dojo_id));
  out.skipped += candidates.length - live.length;

  const stripe = getPlatformStripe();
  const opts = duesRequestOptions();

  for (const s of live) {
    try {
      const sub: any = await stripe.subscriptions.retrieve(
        s.stripe_subscription_id,
        undefined,
        opts,
      );
      out.checked += 1;

      const item = sub?.items?.data?.[0];
      const grossCents = Number(item?.price?.unit_amount ?? 0);
      if (!grossCents) {
        out.skipped += 1;
        continue;
      }

      // Taken from what Stripe actually charges rather than from the plan, so
      // family payers and grandfathered prices are handled without a special
      // case: whatever the member pays IS the gross.
      const passFee = passFeeBy.get(s.dojo_id) ?? false;
      const originalCents = passFee
        ? Math.round(grossCents / (1 + PLATFORM_FEE_PERCENT / 100))
        : grossCents;

      const target = subscriptionAppFeePercent(originalCents, grossCents, passFee);
      const current = sub?.application_fee_percent ?? null;
      if (current != null && Math.abs(Number(current) - target) < 0.005) {
        out.skipped += 1;
        continue;
      }

      if (!args.dryRun) {
        await stripe.subscriptions.update(
          s.stripe_subscription_id,
          { application_fee_percent: target } as any,
          opts,
        );
        // Trust Stripe's own read-back, not the write's return value.
        const check: any = await stripe.subscriptions.retrieve(
          s.stripe_subscription_id,
          undefined,
          opts,
        );
        if (Math.abs(Number(check?.application_fee_percent ?? 0) - target) >= 0.005) {
          throw new Error("the new application fee is not active on the subscription");
        }
      }

      out.updated += 1;
      out.details.push({
        subscriptionId: s.stripe_subscription_id,
        from: current == null ? null : Number(current),
        to: target,
        grossCents,
      });
    } catch (e) {
      // One stubborn subscription must never stop the rest being corrected.
      out.skipped += 1;
      console.error(
        "[fee-realign] could not realign",
        s.stripe_subscription_id,
        getConnectErrorMessage(e),
      );
    }
  }

  return out;
}
