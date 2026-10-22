/**
 * An existing adult member adding their own children, as their guardian.
 *
 * A child added here is an ordinary member: their own plan, their own
 * subscription, and the parent recorded as their guardian. They arrive with a
 * date of birth and a signed waiver, and sit as `pending` until Stripe
 * confirms the first payment -- exactly as a signup does.
 *
 * There is deliberately NO family plan and NO sibling discount in this path.
 * The gym asked to let parents add children, not for family pricing, and an
 * earlier version that tied the two together required a parent to already be
 * the designated payer of a family group before they could name their own
 * child -- a billing concept standing in front of a safeguarding one. If
 * family pricing is ever wanted, it belongs in the gym's own admin, where the
 * commercial decision lives.
 *
 * Member-facing, so every entry point resolves the caller's own member row
 * first and never trusts an id from the client.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isUnder18 } from "@/lib/minors";

export type AddChildContext =
  | { canAdd: false; reason: string }
  | {
      canAdd: true;
      myName: string;
      childCount: number;
      waiver: { title: string; body: string } | null;
      /** The gym's terms, when it publishes any. Agreed to on the child's behalf. */
      terms: { title: string; body: string } | null;
      /** What the gym currently sells. The parent picks one and agrees to it. */
      plans: {
        id: string;
        name: string;
        description: string | null;
        priceCents: number;
        currency: string;
        interval: string;
      }[];
    };

async function resolveMe(supabase: any, userId: string, dojoId: string) {
  const { data } = await supabase
    .from("members")
    .select("id, name, phone, date_of_birth, discipline, dojo_id, family_group_id, guardian_name")
    .eq("user_id", userId)
    .eq("dojo_id", dojoId)
    .maybeSingle();
  return data ?? null;
}

/** The discipline a sibling already trains in, for a parent who doesn't. */
async function siblingDiscipline(db: any, acting: { id: string }[]): Promise<string> {
  for (const a of acting) {
    const { data } = await db.from("members").select("discipline").eq("id", a.id).maybeSingle();
    if (data?.discipline) return data.discipline as string;
  }
  return "BJJ";
}

/** The gym's current terms, if it publishes any with content. */
async function currentTerms(db: any, dojoId: string) {
  const { data } = await db
    .from("dojo_terms")
    .select("id, version, title, body_markdown")
    .eq("dojo_id", dojoId)
    .eq("is_current", true)
    .maybeSingle();
  if (!data || !(data.body_markdown ?? "").trim()) return null;
  return data;
}

async function currentWaiver(db: any, dojoId: string, audience: "minor" | "adult") {
  const { data } = await db
    .from("dojo_waivers")
    .select("id, version, title, body_markdown, audience")
    .eq("dojo_id", dojoId)
    .eq("is_current", true);
  const list = (data ?? []) as any[];
  return (
    list.find((w) => w.audience === audience) ??
    list.find((w) => (w.audience ?? "adult") === "adult") ??
    null
  );
}

/**
 * Who is adding the child.
 *
 * Two kinds of login end up here. An adult member adding their own children,
 * which is what this started as. And a parent whose login sits on a CHILD's
 * record, because that is what signing a child up creates -- the parent has no
 * record of their own, so the second child had nowhere to go. That parent is
 * the guardian named on the record they hold, and may add siblings.
 *
 * A genuine minor with their own login is neither, and is refused.
 */
async function resolveGuardian(db: any, userId: string, dojoId: string) {
  const me = await resolveMe(db, userId, dojoId);
  const { listActingMembers } = await import("@/lib/managed-members.server");
  const acting = await listActingMembers(db, userId, dojoId);

  if (!me) {
    // A login with no record of its own: valid only if it already manages
    // somebody, which is the case once a child has been added to it.
    if (acting.length === 0) return { ok: false as const, reason: "No membership here." };
    return { ok: true as const, me: null, acting, guardianName: null as string | null };
  }

  if (isUnder18(me.date_of_birth)) {
    if (!me.guardian_name) {
      return {
        ok: false as const,
        reason: "Only a parent or guardian can add a child. Ask your gym for help.",
      };
    }
    // The login belongs to the guardian named on this child's record.
    return { ok: true as const, me, acting, guardianName: String(me.guardian_name) };
  }

  return { ok: true as const, me, acting, guardianName: me.name as string };
}

export const getAddChildContext = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }): Promise<AddChildContext> => {
    const { userId } = context as any;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const guardian = await resolveGuardian(supabaseAdmin, userId, data.dojoId);
    if (!guardian.ok) return { canAdd: false, reason: guardian.reason };
    const me = guardian.me;

    // Everyone this login already acts for, minus themselves: the children.
    const childCount = guardian.acting.filter((a) => !a.isSelf).length;

    const waiver = await currentWaiver(supabaseAdmin, data.dojoId, "minor");
    const terms = await currentTerms(supabaseAdmin, data.dojoId);

    // Individual plans only. A family plan is a container the gym assembles,
    // not something a parent picks for one child.
    const { data: planRows } = await supabaseAdmin
      .from("dojo_plans")
      .select("id, name, description, price_cents, currency, interval, plan_type")
      .eq("dojo_id", data.dojoId)
      .eq("is_active", true)
      .neq("plan_type", "family")
      .order("sort_order", { ascending: true })
      .order("price_cents", { ascending: true });

    return {
      canAdd: true,
      myName: guardian.guardianName ?? me?.name ?? "",
      childCount,
      waiver: waiver ? { title: waiver.title, body: waiver.body_markdown } : null,
      terms: terms ? { title: terms.title, body: terms.body_markdown } : null,
      plans: ((planRows ?? []) as any[]).map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description ?? null,
        priceCents: p.price_cents,
        currency: p.currency ?? "eur",
        interval: p.interval,
      })),
    };
  });

export const addMyChild = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      dojoId: string;
      name: string;
      dateOfBirth: string;
      relationship: string;
      phone?: string | null;
      /** The membership the parent is agreeing to for this child. */
      planId: string;
      waiverAgreed: boolean;
      /** The gym's terms, where it publishes any, agreed on the child's behalf. */
      termsAgreed?: boolean;
      signedName: string;
    }) => d,
  )
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { userId, claims } = context as any;
    const { supabaseAdmin: adminForGuardian } = await import(
      "@/integrations/supabase/client.server"
    );
    const guardian = await resolveGuardian(adminForGuardian, userId, data.dojoId);
    if (!guardian.ok) throw new Error(guardian.reason);
    const me = guardian.me;
    // An adult member is the child's guardian of record. A parent whose login
    // sits on a sibling's record is not a member at all, so the child is
    // linked to the login instead, below.
    const guardianMemberId = me && !isUnder18(me.date_of_birth) ? me.id : null;

    const name = (data.name ?? "").trim();
    if (name.length < 2 || name.length > 100) {
      throw new Error("Please give your child's full name.");
    }

    const dob = (data.dateOfBirth ?? "").trim();
    if (!dob || Number.isNaN(Date.parse(dob))) {
      throw new Error("Please give your child's date of birth.");
    }
    if (Date.parse(dob) > Date.now()) throw new Error("That date of birth is in the future.");
    if (!isUnder18(dob)) {
      throw new Error(
        "That date of birth is 18 or over, so they'll need to join in their own name.",
      );
    }

    const relationship = (data.relationship ?? "").trim();
    if (relationship.length < 2) {
      throw new Error("Please tell us how you're related to them.");
    }

    const signedName = (data.signedName ?? "").trim();
    if (!data.waiverAgreed || signedName.length < 2) {
      throw new Error("Please read and agree to the waiver, and sign it with your full name.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Always the verified plan row, never the id the client sent: plan ids are
    // public on signup pages, so one could belong to another gym entirely.
    const { data: plan } = await supabaseAdmin
      .from("dojo_plans")
      .select("id, name, price_cents, interval, plan_type, is_active")
      .eq("id", data.planId)
      .eq("dojo_id", data.dojoId)
      .eq("is_active", true)
      .maybeSingle();
    if (!plan) {
      throw new Error("That membership is no longer available — please pick another.");
    }
    if (plan.plan_type === "family") {
      throw new Error("A family plan is set up by your gym, not chosen for one child.");
    }

    const planLabel =
      plan.interval === "year" ? "Annual" : plan.interval === "one_time" ? "Drop-in" : "Monthly";

    // WHICH versions were agreed to, recorded on the child's own row. Without
    // these the portal reads "not yet accepted" and asks the parent to sign
    // again seconds after they did -- and the gym has no record of what was
    // actually agreed.
    const waiverAtAdd = await currentWaiver(supabaseAdmin, data.dojoId, "minor");
    const termsAtAdd = await currentTerms(supabaseAdmin, data.dojoId);
    if (termsAtAdd && data.termsAgreed !== true) {
      throw new Error("Please read and agree to the gym's terms & conditions.");
    }

    const now = new Date().toISOString();

    // ADDING THE SAME CHILD TWICE.
    //
    // The child is created first and checkout opened second, so anything that
    // stops the payment -- a declined card, a closed tab, Stripe having a bad
    // minute -- leaves a child on the roster who hasn't paid. A parent's
    // instinct is to try again, and without this each attempt minted another
    // half-finished record for the gym to clean up.
    //
    // Same name, same date of birth, same guardian, still unpaid: that is the
    // earlier attempt, not a sibling. Reuse it, move it onto whichever plan
    // they have just chosen, and let the caller open checkout again.
    const existingIds = guardian.acting.filter((a) => !a.isSelf).map((a) => a.id);
    if (existingIds.length) {
      const { data: prior } = await supabaseAdmin
        .from("members")
        .select("id, name, date_of_birth, status, payment_status")
        .in("id", existingIds)
        .eq("dojo_id", data.dojoId)
        .eq("date_of_birth", dob)
        .eq("status", "pending")
        .eq("payment_status", "none");
      const match = ((prior ?? []) as any[]).find(
        (p) => String(p.name ?? "").trim().toLowerCase() === name.toLowerCase(),
      );
      if (match) {
        const { data: subs } = await supabaseAdmin
          .from("member_subscriptions")
          .select("id")
          .eq("member_id", match.id)
          .in("status", ["active", "trialing", "past_due", "unpaid", "incomplete"]);
        if ((subs ?? []).length === 0) {
          await supabaseAdmin
            .from("members")
            .update({
              selected_plan_id: plan.id,
              plan: planLabel as any,
              updated_at: now,
            })
            .eq("id", match.id);
          return { ok: true, childId: match.id, childName: match.name, reused: true };
        }
      }
    }

    // No plan and no family group: `pending` says plainly that the gym has
    // not decided what this child costs yet, which is true and is the gym's
    // call. Everything safeguarding needs is present from the first moment.
    const { data: child, error: childErr } = await supabaseAdmin
      .from("members")
      .insert({
        dojo_id: data.dojoId,
        name,
        email: null,
        phone: (data.phone ?? "").trim() || null,
        date_of_birth: dob,
        // Inherited from whoever this login already stands for -- the parent
        // if they train, otherwise a sibling. It is NOT NULL, so it cannot
        // simply be omitted, and staff can move them if it is ever wrong.
        discipline: me?.discipline ?? (await siblingDiscipline(adminForGuardian, guardian.acting)),
        plan: planLabel as any,
        selected_plan_id: plan.id,
        // Pending until Stripe confirms the first payment, exactly as a
        // signup is: the parent has agreed to the plan, not yet paid for it.
        status: "pending" as any,
        payment_status: "none" as any,
        belt_color: "beginner" as any,
        belt_label: "Beginner",
        stripes: 0,
        joined_at: now,
        trains: true,
        signup_source: "portal_guardian_add",
        guardian_member_id: guardianMemberId,
        guardian_name: guardian.guardianName ?? me?.name ?? null,
        guardian_email: claims?.email ?? null,
        guardian_phone: me?.phone ?? null,
        // Siblings belong to the same family, which is what family pricing
        // and the gym's own reading of the roster both rely on.
        family_group_id: me?.family_group_id ?? null,
        guardian_relationship: relationship,
        waiver_signed_at: now,
        waiver_version_accepted: waiverAtAdd?.version ?? null,
        waiver_audience_accepted: "minor",
        waiver_signed_by: "guardian",
        terms_version_accepted: termsAtAdd?.version ?? null,
        terms_accepted_at: termsAtAdd ? now : null,
      })
      .select("id, name")
      .single();
    if (childErr) throw childErr;

    const { error: waiverErr } = await supabaseAdmin.from("member_waivers").insert({
      member_id: child.id,
      dojo_id: data.dojoId,
      waiver_id: waiverAtAdd?.id ?? null,
      waiver_version: waiverAtAdd?.version ?? null,
      signed_name: signedName,
      signature_text: signedName,
      guardian_name: me.name,
      waiver_audience: "minor",
      signed_by: "guardian",
      signed_at: now,
    });
    if (waiverErr) throw waiverErr;

    // The link that makes this child theirs to act for: book classes, see what
    // was charged, pay. Without it the child would exist and be invisible.
    const { linkManager } = await import("@/lib/managed-members.server");
    await linkManager({
      db: supabaseAdmin,
      dojoId: data.dojoId,
      memberId: child.id,
      userId,
      relationship,
    });

    // A child added from a parent's portal is as new to the gym as one who
    // signed up on the public page, so the same alert applies.
    try {
      const { sendNewSignupAlert } = await import("@/lib/staff-notify.server");
      await sendNewSignupAlert({
        dojoId: data.dojoId,
        memberId: child.id,
        via: "portal",
        payment: "checkout",
      });
    } catch (e) {
      console.error("[addMyChild] staff alert failed", e);
    }

    return { ok: true, childId: child.id, childName: child.name };
  });

export type MyChild = {
  id: string;
  name: string;
  dateOfBirth: string | null;
  planId: string | null;
  planName: string | null;
  priceCents: number | null;
  currency: string | null;
  interval: string | null;
  status: string;
  paymentStatus: string;
  /** False when nobody is being billed for them -- the case that needs a nudge. */
  hasLiveSubscription: boolean;
};

/**
 * The caller's own children. Without this a child whose checkout didn't
 * complete is invisible to the parent: recorded, waivered, and with no way
 * back to paying for them short of ringing the gym.
 */
export const listMyChildren = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }): Promise<MyChild[]> => {
    const { userId } = context as any;

    // Reading someone else's rows -- the caller's own client can only ever see
    // itself, so this is the admin client, scoped to the members this login is
    // linked to and nobody else.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { listActingMembers } = await import("@/lib/managed-members.server");
    const acting = await listActingMembers(supabaseAdmin, userId, data.dojoId);
    const childIds = acting.filter((a) => !a.isSelf).map((a) => a.id);

    // Children recorded the older way, against an adult member rather than a
    // login, are theirs just the same.
    const me = await resolveMe(supabaseAdmin, userId, data.dojoId);
    if (me) {
      const { data: byGuardian } = await supabaseAdmin
        .from("members")
        .select("id")
        .eq("dojo_id", data.dojoId)
        .eq("guardian_member_id", me.id);
      for (const row of (byGuardian ?? []) as { id: string }[]) {
        if (!childIds.includes(row.id)) childIds.push(row.id);
      }
    }
    if (childIds.length === 0) return [];

    const { data: rows } = await supabaseAdmin
      .from("members")
      .select(
        "id, name, date_of_birth, status, payment_status, selected_plan_id, dojo_plans:selected_plan_id(name, price_cents, currency, interval)",
      )
      .eq("dojo_id", data.dojoId)
      .in("id", childIds)
      .order("created_at", { ascending: true });

    const children = (rows ?? []) as any[];
    if (children.length === 0) return [];

    const { data: subs } = await supabaseAdmin
      .from("member_subscriptions")
      .select("member_id, status")
      .in(
        "member_id",
        children.map((c) => c.id),
      )
      .in("status", ["active", "trialing", "past_due", "unpaid", "incomplete"]);
    const live = new Set(((subs ?? []) as any[]).map((s) => s.member_id));

    return children.map((c) => ({
      id: c.id,
      name: c.name,
      dateOfBirth: c.date_of_birth ?? null,
      planId: c.selected_plan_id ?? null,
      planName: c.dojo_plans?.name ?? null,
      priceCents: c.dojo_plans?.price_cents ?? null,
      currency: c.dojo_plans?.currency ?? null,
      interval: c.dojo_plans?.interval ?? null,
      status: c.status,
      paymentStatus: c.payment_status,
      hasLiveSubscription: live.has(c.id),
    }));
  });
