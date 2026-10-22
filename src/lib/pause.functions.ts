import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertDojoStaff } from "./dojo-access";
import { LIVE_STATUSES } from "./subscription-statuses";

/**
 * Pause / freeze a membership.
 *
 * GOVERNING RULES
 *  - A pause stops collection; it never leaves a debt to catch up on, and
 *    resuming returns the member to exactly the amount they paid before.
 *  - Stripe is always verified before local state changes.
 *  - A paused member leaves the family total and the family-size tier, so the
 *    payer's total drops — but only at the next renewal, never as a mid-cycle
 *    charge or credit.
 *  - The member is always told what happens to their billing and their access.
 */


export type PauseReason = "travel" | "personal" | "other";
export type PauseScope = "member" | "family";

export type PausePreview = {
  memberId: string;
  name: string;
  status: string;
  paymentMethod: string;
  canPause: boolean;
  /** Why pausing is not offered, in plain English. */
  blockedReason: string | null;
  isFamilyPayer: boolean;
  familyGroupId: string | null;
  familySize: number;
  /** Payer whose bill drops while this member is paused. */
  payer: { id: string; name: string } | null;
  currency: string;
  interval: string;
  /** This member's own charge today (0 when covered by a family payer). */
  ownChargeCents: number;
  /** Family total before and after this pause, including the platform fee. */
  familyBeforeCents: number | null;
  familyAfterCents: number | null;
  familyDiscountBefore: number | null;
  familyDiscountAfter: number | null;
  hasLiveSubscription: boolean;
  nextRenewalAt: string | null;
  pausedMembersCanBook: boolean;
  futureBookings: number;
};


export const getPausePreview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberId: string }) => d)
  .handler(async ({ data, context }): Promise<PausePreview> => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "getPausePreview");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { grossChargeCents } = await import("@/lib/platform-fee");

    const [{ data: member }, { data: dojo }] = await Promise.all([
      supabaseAdmin
        .from("members")
        .select(
          "id, name, status, payment_method, family_group_id, plan_price_cents, selected_plan_id, dojo_plans:selected_plan_id(name, price_cents, currency, interval)",
        )
        .eq("id", data.memberId)
        .eq("dojo_id", data.dojoId)
        .maybeSingle(),
      supabaseAdmin
        .from("dojos")
        .select("default_currency, pass_platform_fee_to_members, paused_members_can_book, family_pricing_mode")
        .eq("id", data.dojoId)
        .maybeSingle(),
    ]);
    if (!member) throw new Error("Member not found");

    const passFee = !!dojo?.pass_platform_fee_to_members;
    const currency = (
      (member as any).dojo_plans?.currency ?? dojo?.default_currency ?? "usd"
    ).toLowerCase();
    const interval = ((member as any).dojo_plans?.interval as string) ?? "month";
    const groupId = ((member as any).family_group_id as string | null) ?? null;
    const { familyContext, quoteFamily, familyIntervalOf } = await import(
      "./pause-family.server"
    );
    const { payerId, members: fam } = await familyContext(supabaseAdmin, data.dojoId, groupId);
    // Family totals are billed on the payer's interval, not this member's.
    const famInterval = familyIntervalOf(fam, payerId);
    const isFamilyPayer = !!groupId && payerId === data.memberId;
    const tieredFamilies = (dojo?.family_pricing_mode ?? "tiered") === "tiered";

    const { data: subs } = await supabaseAdmin
      .from("member_subscriptions")
      .select("stripe_subscription_id, current_period_end, status")
      .eq("dojo_id", data.dojoId)
      .eq("member_id", data.memberId)
      .in("status", [...LIVE_STATUSES]);
    const live = ((subs ?? []) as any[]).filter((s) => s.stripe_subscription_id);

    const today = new Date().toISOString().slice(0, 10);
    const { count: futureBookings } = await supabaseAdmin
      .from("class_bookings")
      .select("id", { count: "exact", head: true })
      .eq("dojo_id", data.dojoId)
      .eq("member_id", data.memberId)
      .eq("status", "booked")
      .gte("booked_for_date", today);

    let familyBefore: number | null = null;
    let familyAfter: number | null = null;
    let discountBefore: number | null = null;
    let discountAfter: number | null = null;
    let payer: { id: string; name: string } | null = null;
    if (groupId && tieredFamilies && fam.length >= 2) {
      const before = await quoteFamily(
        supabaseAdmin,
        data.dojoId,
        fam,
        [],
        currency,
        famInterval,
      );
      const after = await quoteFamily(
        supabaseAdmin,
        data.dojoId,
        fam,
        [data.memberId],
        currency,
        famInterval,
      );
      familyBefore = grossChargeCents(before.totalCents, passFee);
      familyAfter = grossChargeCents(after.totalCents, passFee);
      discountBefore = before.discountPercent;
      discountAfter = after.discountPercent;
      const p = fam.find((m) => m.id === payerId);
      if (p) payer = { id: p.id as string, name: p.name as string };
    }

    let blockedReason: string | null = null;
    if ((member as any).status === "paused") {
      blockedReason = "This membership is already paused.";
    } else if (!["active", "trial"].includes((member as any).status)) {
      blockedReason = `Only active or trial memberships can be paused (this one is ${(member as any).status}).`;
    } else if (isFamilyPayer && fam.filter((m) => m.status !== "paused").length > 1) {
      blockedReason =
        "This member pays for the whole family, so pausing them alone would stop everyone's billing. Change the family payer first, or pause the whole family.";
    }

    return {
      memberId: data.memberId,
      name: (member as any).name as string,
      status: (member as any).status as string,
      paymentMethod: ((member as any).payment_method as string) ?? "card",
      canPause: !blockedReason,
      blockedReason,
      isFamilyPayer,
      familyGroupId: groupId,
      familySize: fam.length,
      payer,
      currency,
      interval,
      ownChargeCents: grossChargeCents(
        Number((member as any).plan_price_cents ?? (member as any).dojo_plans?.price_cents ?? 0),
        passFee,
      ),
      familyBeforeCents: familyBefore,
      familyAfterCents: familyAfter,
      familyDiscountBefore: discountBefore,
      familyDiscountAfter: discountAfter,
      hasLiveSubscription: live.length > 0,
      nextRenewalAt: (subs ?? [])[0]?.current_period_end ?? null,
      pausedMembersCanBook: !!dojo?.paused_members_can_book,
      futureBookings: futureBookings ?? 0,
    };
  });

export const pauseMembership = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      dojoId: string;
      memberId: string;
      reason: PauseReason;
      note?: string | null;
      resumeAt?: string | null;
      scope?: PauseScope;
    }) => {
      if (!d?.dojoId || !d?.memberId) throw new Error("dojoId and memberId are required");
      if (!["travel", "personal", "other"].includes(d.reason)) throw new Error("Invalid reason");
      if (d.resumeAt) {
        const t = new Date(d.resumeAt);
        if (Number.isNaN(t.getTime())) throw new Error("Invalid resume date");
        if (t.getTime() < Date.now()) throw new Error("The resume date must be in the future");
      }
      return { ...d, scope: d.scope ?? "member" };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "pauseMembership");
    const { notifyCollector } = await import("@/lib/member-notify.server");
    const notes = notifyCollector();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { formatMoney } = await import("@/lib/family-pricing");

    const { data: member } = await supabaseAdmin
      .from("members")
      .select("id, name, status, payment_status, payment_method, family_group_id")
      .eq("id", data.memberId)
      .eq("dojo_id", data.dojoId)
      .maybeSingle();
    if (!member) throw new Error("Member not found");
    if ((member as any).status === "paused") {
      return { ok: true as const, alreadyPaused: true, pausedIds: [] as string[] };
    }
    if (!["active", "trial"].includes((member as any).status)) {
      throw new Error(
        `Only active or trial memberships can be paused (this one is ${(member as any).status}).`,
      );
    }

    const groupId = ((member as any).family_group_id as string | null) ?? null;
    const { familyContext, quoteFamily, familyIntervalOf } = await import(
      "./pause-family.server"
    );
    const { payerId, members: fam } = await familyContext(supabaseAdmin, data.dojoId, groupId);
    // Family totals are billed on the payer's interval, not this member's.
    const famInterval = familyIntervalOf(fam, payerId);

    const isFamilyPayer = !!groupId && payerId === data.memberId;
    const scope: PauseScope = data.scope ?? "member";

    if (isFamilyPayer && scope !== "family" && fam.filter((m) => m.status !== "paused").length > 1) {
      throw new Error(
        "This member pays for the whole family. Change the family payer first, or pause the whole family.",
      );
    }

    // Who is being paused.
    const targets =
      scope === "family" && groupId
        ? fam.filter((m) => ["active", "trial"].includes(m.status))
        : [member];
    const targetIds = targets.map((m: any) => m.id as string);

    const { hasStripeSecret, getPlatformStripe } = await import("@/lib/stripe-connect.server");
    const stripeReady = hasStripeSecret();

    // 1. Stripe first — pause collection on every affected live subscription.
    const { data: subs } = await supabaseAdmin
      .from("member_subscriptions")
      .select("id, member_id, stripe_subscription_id")
      .eq("dojo_id", data.dojoId)
      .in("member_id", targetIds)
      .in("status", [...LIVE_STATUSES]);
    const live = ((subs ?? []) as any[]).filter((s) => s.stripe_subscription_id);
    if (live.length && !stripeReady) {
      throw new Error(
        "Stripe isn't configured, so billing can't be paused. Nothing was changed.",
      );
    }
    const { pauseDuesSubscription } = await import("@/lib/pause.server");
    let stripePaused = 0;
    for (const s of live) {
      const out = await pauseDuesSubscription(
        getPlatformStripe(),
        s.stripe_subscription_id,
        data.resumeAt ?? null,
      );
      if (out.ok && !out.absent) {
        stripePaused += 1;
        await supabaseAdmin
          .from("member_subscriptions")
          .update({ status: "paused", updated_at: new Date().toISOString() })
          .eq("id", s.id);
      }
    }

    // 2. Local state.
    const nowISO = new Date().toISOString();
    for (const t of targets as any[]) {
      await supabaseAdmin
        .from("members")
        .update({
          status: "paused",
          paused_at: nowISO,
          pause_reason: data.reason,
          pause_note: data.note?.trim() || null,
          pause_resumes_at: data.resumeAt ?? null,
          updated_at: nowISO,
        })
        .eq("id", t.id)
        .eq("dojo_id", data.dojoId);

      await supabaseAdmin.from("membership_pauses").insert({
        dojo_id: data.dojoId,
        member_id: t.id,
        family_group_id: groupId,
        scope,
        reason: data.reason,
        note: data.note?.trim() || null,
        resume_at: data.resumeAt ?? null,
        status: "active",
        status_before: t.status ?? "active",
        payment_status_before: t.payment_status ?? null,
        stripe_paused: stripePaused > 0,
        stripe_subscription_id:
          live.find((s) => s.member_id === t.id)?.stripe_subscription_id ?? null,
        created_by: userId,
      });
    }

    // 3. Future bookings, unless the gym lets paused members keep booking.
    const { data: dojo } = await supabaseAdmin
      .from("dojos")
      .select("paused_members_can_book, pass_platform_fee_to_members")
      .eq("id", data.dojoId)
      .maybeSingle();
    let bookingsReleased = 0;
    if (!dojo?.paused_members_can_book) {
      const today = new Date().toISOString().slice(0, 10);
      const { data: removed } = await supabaseAdmin
        .from("class_bookings")
        .delete()
        .eq("dojo_id", data.dojoId)
        .in("member_id", targetIds)
        .eq("status", "booked")
        .gte("booked_for_date", today)
        .select("id");
      bookingsReleased = (removed ?? []).length;
    }

    // 4. The family total drops at the payer's next renewal.
    let payerNewTotalCents: number | null = null;
    if (groupId && scope === "member" && payerId && payerId !== data.memberId) {
      const { data: freshFam } = await supabaseAdmin
        .from("members")
        .select(
          "id, name, status, plan_price_cents, selected_plan_id, dojo_plans:selected_plan_id(price_cents, currency, interval)",
        )
        .eq("dojo_id", data.dojoId)
        .eq("family_group_id", groupId);
      const rows = (freshFam ?? []) as any[];
      const anyPlan = rows.find((m) => m.dojo_plans)?.dojo_plans;
      const payerPlan = rows.find((m) => m.id === payerId)?.dojo_plans;
      const quote = await quoteFamily(
        supabaseAdmin,
        data.dojoId,
        rows,
        [],
        (payerPlan?.currency as string) ?? (anyPlan?.currency as string) ?? "usd",
        (payerPlan?.interval as string) ?? (anyPlan?.interval as string) ?? "month",
      );
      payerNewTotalCents = quote.totalCents;
      const payerSub = await supabaseAdmin
        .from("member_subscriptions")
        .select("stripe_subscription_id")
        .eq("dojo_id", data.dojoId)
        .eq("member_id", payerId)
        .in("status", [...LIVE_STATUSES])
        .limit(1)
        .maybeSingle();
      if (stripeReady && payerSub.data?.stripe_subscription_id && quote.interval !== "one_time") {
        const { repriceSubscriptionAtRenewal } = await import("@/lib/pricing.server");
        const { grossChargeCents } = await import("@/lib/platform-fee");
        const passFee = !!dojo?.pass_platform_fee_to_members;
        await repriceSubscriptionAtRenewal({
          stripe: getPlatformStripe(),
          subscriptionId: payerSub.data.stripe_subscription_id as string,
          unitAmountCents: grossChargeCents(quote.totalCents, passFee),
          currency: quote.currency,
          interval: quote.interval as "month" | "year",
          productName: `Family plan — ${quote.size} member${quote.size === 1 ? "" : "s"} (${quote.discountPercent}% family discount)`,
          metadata: { dojo_id: data.dojoId, family_group_id: groupId, family_size: String(quote.size) },
        });
      }
      if (rows.some((m) => m.id === payerId)) {
        // Copy comes from the same quote that produced the number: only claim
        // the total changed when the paused member was actually being billed.
        const { countsTowardFamilyTotal, familyExclusionLabel } = await import(
          "@/lib/family-pricing"
        );
        const wasCounted = countsTowardFamilyTotal((member as any).status);
        const why = familyExclusionLabel((member as any).status);
        const pausedName = ((member as any).name as string | null) ?? "Your family member";
        notes.add(
          await (await import("@/lib/member-notify.server")).notifyMember({
          dojoId: data.dojoId,
          memberId: payerId,
          subject: wasCounted
            ? "Your family membership total is changing"
            : "An update to your family membership",
          body: wasCounted
            ? `${pausedName} has paused their membership, so they leave the family total while they are away.\n\n` +
              `From your next payment date, your family total will be ${formatMoney(quote.totalCents, quote.currency)} (${quote.discountPercent}% family discount for ${quote.size} member${quote.size === 1 ? "" : "s"}). Nothing changes on your current payment.`
            : `${pausedName} has paused their membership. They were ${why ?? "not part of the billed total"}, so your family total does not change.\n\n` +
              `Your family total stays at ${formatMoney(quote.totalCents, quote.currency)} (${quote.discountPercent}% family discount for ${quote.size} billed member${quote.size === 1 ? "" : "s"}).`,
            actorUserId: userId,
            idempotencyKey: `family-pause-${groupId}-${data.memberId}-${nowISO}`,
          }),
          { memberId: payerId, name: null },
        );
      }

    }

    // 5. Tell the paused member(s) exactly what happens.
    const resumeText = data.resumeAt
      ? `Your membership is set to restart automatically on ${new Date(data.resumeAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}.`
      : "Your membership stays paused until you ask us to restart it.";
    for (const t of targets as any[]) {
      notes.add(
        await (await import("@/lib/member-notify.server")).notifyMember({
        dojoId: data.dojoId,
        memberId: t.id,
        subject: "Your membership is paused",
        body:
          `Your membership is now paused, so you will not be charged while it is paused and nothing builds up to pay back.\n\n` +
          `${resumeText}\n\n` +
          (dojo?.paused_members_can_book
            ? "You can still book classes while paused."
            : "Class booking is paused too, and any upcoming bookings have been released.") +
          `\n\nWhen you restart, you go back to exactly the same price you were paying before.`,
          actorUserId: userId,
          idempotencyKey: `pause-${t.id}-${nowISO}`,
        }),
        { memberId: t.id, name: t.name ?? null },
      );
    }

    return {
      ok: true as const,
      alreadyPaused: false,
      pausedIds: targetIds,
      stripePaused,
      bookingsReleased,
      payerNewTotalCents,
      // The truth about who was actually reached.
      notifications: notes.summary,
    };
  });

export const resumeMembership = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "resumeMembership");
    const { resumeMembershipInternal } = await import("@/lib/pause-apply.server");
    return resumeMembershipInternal({
      dojoId: data.dojoId,
      memberId: data.memberId,
      actorUserId: userId,
      trigger: "staff",
    });
  });

export const listPausedMembers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "listPausedMembers");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows } = await supabaseAdmin
      .from("members")
      .select(
        "id, name, status, paused_at, pause_reason, pause_note, pause_resumes_at, plan_price_cents, dojo_plans:selected_plan_id(name, price_cents, currency, interval)",
      )
      .eq("dojo_id", data.dojoId)
      .eq("status", "paused")
      .order("paused_at", { ascending: true });
    return {
      members: ((rows ?? []) as any[]).map((m) => ({
        memberId: m.id as string,
        name: m.name as string,
        pausedAt: m.paused_at as string | null,
        reason: (m.pause_reason as string) ?? "other",
        note: (m.pause_note as string | null) ?? null,
        resumesAt: (m.pause_resumes_at as string | null) ?? null,
        planName: (m.dojo_plans?.name as string) ?? "No plan",
        priceCents: Number(m.plan_price_cents ?? m.dojo_plans?.price_cents ?? 0),
        currency: (m.dojo_plans?.currency as string) ?? "usd",
        interval: (m.dojo_plans?.interval as string) ?? "month",
      })),
    };
  });
