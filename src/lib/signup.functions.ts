import { createServerFn } from "@tanstack/react-start";
import { LEAD_SOURCES, REFERRAL_LEAD_SOURCE } from "@/lib/lead-sources";
import { isUnder18 } from "@/lib/minors";

export const getDojoBySlug = createServerFn({ method: "GET" })
  .inputValidator((d: { slug: string }) => d)
  .handler(async ({ data }) => {

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: dojo, error } = await supabaseAdmin
      .from("dojos")
      .select("id, name, slug, tagline, logo_path, public_page_enabled, pass_platform_fee_to_members, default_currency, billing_mode, billing_day_of_month, signup_free_days, trial_length_days, trial_classes_per_day, trial_max_total_classes")
      .eq("slug", data.slug)
      .is("archived_at", null)
      .maybeSingle();
    if (error) throw error;
    return { dojo };
  });


async function assertDojoPublic(dojoId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: dojo } = await supabaseAdmin
    .from("dojos")
    .select("id, public_page_enabled, archived_at")
    .eq("id", dojoId)
    // An archived gym is gone as far as the public is concerned — the storage
    // rule for logos and the slug lookup both treat it that way, so plan and
    // signup reads must not be the one place it stays reachable.
    .is("archived_at", null)
    .maybeSingle();
  if (!dojo?.public_page_enabled) throw new Error("Not found");
}


export const getDojoPlansPublic = createServerFn({ method: "GET" })
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data }) => {
    await assertDojoPublic(data.dojoId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: plans, error } = await supabaseAdmin
      .from("dojo_plans")
      .select(
        "id, dojo_id, name, description, price_cents, currency, interval, is_active, sort_order, plan_type, max_family_members",
      )
      .eq("dojo_id", data.dojoId)
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .order("price_cents", { ascending: true });
    if (error) throw error;
    return { plans: (plans ?? []) as any[] };
  });

/** The gym's family pricing model and discount tiers, for the public signup page. */
export const getFamilyPricingPublic = createServerFn({ method: "GET" })
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data }) => {
    await assertDojoPublic(data.dojoId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: dojo } = await supabaseAdmin
      .from("dojos")
      .select("family_pricing_mode")
      .eq("id", data.dojoId)
      .maybeSingle();
    const { data: rows } = await supabaseAdmin
      .from("family_discount_tiers")
      .select("min_members, discount_percent")
      .eq("dojo_id", data.dojoId)
      .order("min_members");
    return {
      mode: ((dojo as any)?.family_pricing_mode ?? "tiered") as "flat" | "tiered",
      tiers: ((rows ?? []) as any[]).map((t) => ({
        min_members: Number(t.min_members),
        discount_percent: Number(t.discount_percent),
      })),
    };
  });

export const getDojoClassTypes = createServerFn({ method: "GET" })
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data }) => {
    await assertDojoPublic(data.dojoId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: classTypes, error } = await supabaseAdmin
      .from("dojo_class_types")
      .select("*")
      .eq("dojo_id", data.dojoId)
      .order("sort_order", { ascending: true });
    if (error) throw error;
    return { classTypes: (classTypes ?? []) as any[] };
  });

export const getCurrentWaiver = createServerFn({ method: "GET" })
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data }) => {
    await assertDojoPublic(data.dojoId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: waiver, error } = await supabaseAdmin
      .from("dojo_waivers")
      .select("id, version, title, body_markdown")
      .eq("dojo_id", data.dojoId)
      .eq("is_current", true)
      .eq("audience", "adult")
      .maybeSingle();
    if (error) throw error;
    return { waiver };
  });

type FamilyDependent = {
  name: string;
  email: string;
  phone?: string | null;
  /**
   * Required. A family plan is how most parents enrol their children, so a
   * dependent with no date of birth is silently stored as an adult: no minor
   * waiver, no guardian, and media consent taken as though the child gave it.
   */
  dateOfBirth?: string | null;
};

export const submitSignup = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      dojoId: string;
      name: string;
      /** The member's own address. Empty for a child enrolled by a parent. */
      email: string;
      /** The address that owns the login. A parent's, when they enrol a child. */
      accountEmail?: string | null;
      phone?: string | null;
      discipline: string;
      beltColor?: string | null;
      beltLabel?: string | null;
      selectedPlanId?: string | null;
      signedName: string;
      signatureText: string;
      guardianName?: string | null;
      guardianEmail?: string | null;
      guardianPhone?: string | null;
      guardianRelationship?: string | null;
      familyMembers?: FamilyDependent[] | null;
      userId?: string | null;
      leadSource?: string | null;
      referredBy?: string | null;
      mediaConsent?: boolean | null;
      termsAccepted?: boolean | null;
      dateOfBirth?: string | null;
      /**
       * False when the person signing up is a parent or guardian paying for
       * their children without training themselves. Defaults to true.
       */
      trains?: boolean | null;
      turnstileToken?: string | null;
    }) => d,
  )
  .handler(async ({ data }) => {
    const name = typeof data.name === "string" ? data.name.trim() : "";
    if (name.length < 2 || name.length > 100) {
      throw new Error("Name must be between 2 and 100 characters.");
    }

    // The member's OWN address, and it is optional. A child enrolled by a
    // parent normally has none: everything addressed to them goes to the
    // guardian instead (`contactEmailFor`). Leaving it null also keeps a
    // parent's address free, so one parent can enrol more than one child.
    const email = typeof data.email === "string" ? data.email.trim() : "";
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Please enter a valid email address.");
    }

    // The address that owns the login. For an adult signing themselves up this
    // is the same address; when a parent enrols a child it is the PARENT'S.
    // Rate limiting and the auth-user check below both key off this one.
    const accountEmail =
      typeof data.accountEmail === "string" && data.accountEmail.trim().length > 0
        ? data.accountEmail.trim()
        : email;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(accountEmail)) {
      throw new Error("Please enter a valid email address.");
    }

    // Abuse protection on this unauthenticated endpoint: bot check first, then
    // per-IP / per-email / per-gym throttling, all before any record is created.
    const { enforceRateLimit, verifyTurnstile, BOT_CHECK_FAILED } = await import(
      "@/lib/rate-limit.server"
    );
    if (!(await verifyTurnstile(data.turnstileToken))) throw new Error(BOT_CHECK_FAILED);
    await enforceRateLimit({ endpoint: "signup", dojoId: data.dojoId, email: accountEmail });


    const phone = typeof data.phone === "string" ? data.phone.trim() : "";
    if (phone && phone.length > 30) {
      throw new Error("Phone number is too long.");
    }

    const signedName = typeof data.signedName === "string" ? data.signedName.trim() : "";
    if (signedName.length < 2 || signedName.length > 200) {
      throw new Error("Please enter your full name to sign the waiver.");
    }

    const signatureText = typeof data.signatureText === "string" ? data.signatureText.trim() : "";
    if (signatureText.length < 2 || signatureText.length > 500) {
      throw new Error("Please enter your electronic signature.");
    }

    const dateOfBirth =
      typeof data.dateOfBirth === "string" && data.dateOfBirth.trim().length > 0
        ? data.dateOfBirth.trim()
        : null;
    const minor = isUnder18(dateOfBirth);

    const guardianName =
      typeof data.guardianName === "string" ? data.guardianName.trim() : "";
    if (guardianName && guardianName.length >= 200) {
      throw new Error("Guardian name is too long.");
    }
    // A minor's guardian email defaults to whoever owns the login, because on
    // the "my child" path that account belongs to the parent by construction.
    const guardianEmail =
      typeof data.guardianEmail === "string" && data.guardianEmail.trim().length > 0
        ? data.guardianEmail.trim()
        : minor
          ? accountEmail
          : "";
    const guardianPhone =
      typeof data.guardianPhone === "string" ? data.guardianPhone.trim() : "";
    const guardianRelationship =
      typeof data.guardianRelationship === "string" ? data.guardianRelationship.trim() : "";

    if (minor) {
      if (guardianName.length < 2) {
        throw new Error("A parent or guardian must give their full name.");
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guardianEmail)) {
        throw new Error("Please enter a valid parent or guardian email address.");
      }
      if (guardianPhone.length < 5 || guardianPhone.length > 30) {
        throw new Error("Please enter a parent or guardian phone number.");
      }
      if (guardianRelationship.length < 2) {
        throw new Error("Please tell us the guardian's relationship to the member.");
      }
    }

    const rawLeadSource =
      typeof data.leadSource === "string" ? data.leadSource.trim() : "";
    const leadSource = (LEAD_SOURCES as readonly string[]).includes(rawLeadSource)
      ? rawLeadSource
      : null;
    const referredBy =
      leadSource === REFERRAL_LEAD_SOURCE && typeof data.referredBy === "string"
        ? data.referredBy.trim().slice(0, 120) || null
        : null;
    if (leadSource === REFERRAL_LEAD_SOURCE && !referredBy) {
      throw new Error("Please tell us who referred you.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: dojoCheck, error: dojoCheckError } = await supabaseAdmin
      .from("dojos")
      .select("id, public_page_enabled, collect_media_consent")
      .eq("id", data.dojoId)
      .maybeSingle();

    if (dojoCheckError) throw dojoCheckError;
    if (!dojoCheck || !dojoCheck.public_page_enabled) {
      throw new Error("Signups are not enabled for this gym.");
    }

    // Agreements the gym currently publishes. A minor signs the gym's minor
    // waiver when one is published; otherwise they fall back to the adult
    // waiver, still signed by a guardian.
    const { data: publishedWaivers } = await supabaseAdmin
      .from("dojo_waivers")
      .select("id, version, audience")
      .eq("dojo_id", data.dojoId)
      .eq("is_current", true);

    const waiverList = (publishedWaivers ?? []) as Array<{
      id: string;
      version: number;
      audience: string | null;
    }>;
    const adultWaiver = waiverList.find((w) => (w.audience ?? "adult") === "adult") ?? null;
    const minorWaiver = waiverList.find((w) => w.audience === "minor") ?? null;
    const currentWaiver = (minor ? (minorWaiver ?? adultWaiver) : adultWaiver) ?? null;
    const signedAudience: "adult" | "minor" = minor
      ? minorWaiver
        ? "minor"
        : "adult"
      : "adult";


    const { data: currentTerms } = await supabaseAdmin
      .from("dojo_terms")
      .select("id, version, body_markdown")
      .eq("dojo_id", data.dojoId)
      .eq("is_current", true)
      .maybeSingle();

    const termsRequired =
      !!currentTerms && (currentTerms.body_markdown ?? "").trim().length > 0;
    if (termsRequired && data.termsAccepted !== true) {
      throw new Error("Please read and agree to the gym's terms & conditions.");
    }

    const collectMediaConsent = dojoCheck.collect_media_consent !== false;
    const mediaConsentGranted = collectMediaConsent && data.mediaConsent === true;


    // Duplicate signup guard — same email in same dojo
    if (email) {
      const { data: existing } = await supabaseAdmin
        .from("members")
        .select("id")
        .eq("dojo_id", data.dojoId)
        .ilike("email", email)
        .limit(1)
        .maybeSingle();
      if (existing) {
        throw new Error(
          "You're already registered with this gym — log in to view your portal.",
        );
      }
    }

    const discipline =
      typeof data.discipline === "string" && data.discipline.trim().length > 0
        ? data.discipline.trim()
        : "Brazilian Jiu-Jitsu";

    const allowedRanks = new Set([
      "beginner","white","yellow","orange","green","blue","purple","brown","red","black",
      "novice","intermediate","advanced","competitor",
    ]);
    const rawBeltColor = (data.beltColor ?? "").toString().trim().toLowerCase();
    const beltColor = allowedRanks.has(rawBeltColor) ? rawBeltColor : "beginner";
    const beltLabel =
      (data.beltLabel && data.beltLabel.trim().slice(0, 60)) ||
      (beltColor[0].toUpperCase() + beltColor.slice(1));

    // Look up the plan (needed for both plan_type label AND for family enforcement / checkout)
    let planType: "Monthly" | "Annual" | "Drop-in" | "Family" = "Monthly";
    let planRow: {
      id: string;
      name: string;
      interval: string;
      plan_type: "individual" | "family";
      max_family_members: number | null;
      price_cents: number;
    } | null = null;

    if (data.selectedPlanId) {
      const { data: plan, error: planErr } = await supabaseAdmin
        .from("dojo_plans")
        .select("id, name, interval, plan_type, max_family_members, price_cents")
        .eq("id", data.selectedPlanId)
        .eq("dojo_id", data.dojoId)
        .eq("is_active", true)
        .maybeSingle();
      if (planErr) throw planErr;
      if (!plan) {
        // Never store an unverified plan reference: the id could belong to
        // another gym (plan ids are public on signup pages) or be inactive.
        throw new Error("That membership plan is no longer available — please pick a plan again.");
      }
      planRow = plan as any;
      if (plan.interval === "year") planType = "Annual";
      else if (plan.interval === "one_time") planType = "Drop-in";
      else if (plan.plan_type === "family") planType = "Family";
      else planType = "Monthly";

    }

    // Validate & dedupe family dependents up front
    const dependents = (data.familyMembers ?? []).filter(
      (d) => d && typeof d.name === "string" && d.name.trim().length >= 2,
    );
    if (planRow?.plan_type === "family") {
      if (dependents.length < 1) {
        throw new Error("A family plan needs at least one additional member.");
      }
      const groupSize = dependents.length + 1;
      if (planRow.max_family_members && groupSize > planRow.max_family_members) {
        throw new Error(
          `This family plan allows up to ${planRow.max_family_members} members (you added ${groupSize}).`,
        );
      }
      for (const dep of dependents) {
        // Required, because most dependents on a family plan are children and
        // an unknown date of birth is treated as an adult everywhere else.
        const depDob = (dep.dateOfBirth ?? "").trim();
        if (!depDob) {
          throw new Error(`Please give a date of birth for "${dep.name}".`);
        }
        if (Number.isNaN(Date.parse(depDob))) {
          throw new Error(`Invalid date of birth for "${dep.name}".`);
        }
        const depEmail = (dep.email ?? "").trim();
        if (depEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(depEmail)) {
          throw new Error(`Invalid email for family member "${dep.name}".`);
        }
        if (depEmail) {
          const { data: existing } = await supabaseAdmin
            .from("members")
            .select("id")
            .eq("dojo_id", data.dojoId)
            .ilike("email", depEmail)
            .limit(1)
            .maybeSingle();
          if (existing) {
            throw new Error(
              `A member with the email ${depEmail} already exists at this gym.`,
            );
          }
        }
      }
    } else if (dependents.length > 0) {
      // Ignore family members if a non-family plan was chosen
      dependents.length = 0;
    }

    const now = new Date().toISOString();

    // DOES THIS GYM OFFER A TRIAL? A gym that does gives it to members who pick
    // a plan at signup too: they join on trial, the payment method is captured
    // at checkout, and the first charge is deferred to the end of the trial
    // (Stripe `trial_end`). One-off drop-ins and family plans are unchanged --
    // a drop-in is a single purchase, and a family payer's total is set up by
    // the gym -- so those still charge at checkout exactly as today.
    const { data: dojoTrialRow } = await supabaseAdmin
      .from("dojos")
      .select("trial_length_days, trial_classes_per_day, trial_max_total_classes, signup_free_days")
      .eq("id", data.dojoId)
      .maybeSingle();
    const { trialPolicyFromDojo, trialOffered } = await import("@/lib/trial-policy");
    const gymOffersTrial = trialOffered(trialPolicyFromDojo(dojoTrialRow));

    // SIGNUP FREE PERIOD (per-gym `signup_free_days`, 0 = off). Everyone picks a
    // plan and enters a card, gets N free days from signup with FULL access, and
    // is charged automatically at the end. Not the attendance-based class trial.
    const signupFreeDays = Math.round(Number((dojoTrialRow as any)?.signup_free_days ?? 0)) || 0;
    if (signupFreeDays > 0 && !planRow) {
      throw new Error("Please choose a membership plan to sign up at this gym.");
    }

    const deferChargeToTrialEnd =
      !!planRow &&
      (gymOffersTrial || signupFreeDays > 0) &&
      planRow.interval !== "one_time" &&
      planRow.plan_type !== "family";

    // Exact end of the free period, in UTC instants, so the date the member is
    // shown and the date Stripe charges them can never disagree.
    const freeTrialEndsAt =
      signupFreeDays > 0 && deferChargeToTrialEnd
        ? new Date(Date.parse(now) + signupFreeDays * 86400000).toISOString()
        : null;

    // A paid-plan signup is not active until Stripe confirms payment through
    // the webhook. No-plan signups remain trials and need no payment. A member
    // who picks a plan while the gym offers a trial is a TRIAL member: the
    // attendance clock, per-day limits, booking rules and reminders all apply
    // exactly as they would have without a plan.
    const memberStatus: "pending" | "trial" =
      data.selectedPlanId && !deferChargeToTrialEnd ? "pending" : "trial";

    // Create family group first if needed
    let familyGroupId: string | null = null;
    if (planRow?.plan_type === "family") {
      const { data: fg, error: fgErr } = await supabaseAdmin
        .from("family_groups")
        .insert({ dojo_id: data.dojoId, name: `${name.split(" ")[0] || name} family` })
        .select("id")
        .single();
      if (fgErr) throw fgErr;
      familyGroupId = fg.id;
    }

    // Create payer member
    const { data: member, error: memberError } = await supabaseAdmin
      .from("members")
      .insert({
        dojo_id: data.dojoId,
        name: name,
        email: email || null,
        phone: phone || null,
        discipline: discipline as any,
        plan: planType,
        // Always the verified plan row, never the raw client-supplied id.
        selected_plan_id: planRow?.id ?? null,

        status: memberStatus as any,
        free_trial_ends_at: freeTrialEndsAt,
        payment_status: "none" as any,
        belt_color: beltColor as any,
        belt_label: beltLabel,
        stripes: 0,
        joined_at: now,
        waiver_signed_at: now,
        waiver_version_accepted: currentWaiver?.version ?? null,
        terms_version_accepted: termsRequired ? (currentTerms?.version ?? null) : null,
        terms_accepted_at: termsRequired ? now : null,
        signup_source: "public_signup",
        lead_source: leadSource,
        referred_by: referredBy,
        family_group_id: familyGroupId,
        media_consent: mediaConsentGranted,
        media_consent_at: mediaConsentGranted ? now : null,
        date_of_birth: dateOfBirth,
        // A guardian paying for their children without training themselves is
        // still a member row -- it holds the login, the card and the family
        // group -- but must not count as an athlete anywhere.
        trains: data.trains !== false,
        waiver_audience_accepted: signedAudience,
        waiver_signed_by: minor ? "guardian" : "member",
        guardian_name: minor ? guardianName : null,
        guardian_email: minor ? guardianEmail : null,
        guardian_phone: minor ? guardianPhone : null,
        guardian_relationship: minor ? guardianRelationship : null,
      })
      .select("id")
      .single();

    if (memberError) {
      if ((memberError as any).code === "23505") {
        throw new Error(
          "A member with this email already exists at this gym. Please contact the gym directly.",
        );
      }
      throw memberError;
    }

    // Attach the freshly created auth user to this member AND to the gym.
    // The dojo_memberships row is what associates them with the gym so they
    // land in this gym's portal instead of the "Create a dojo" onboarding.
    if (data.userId) {
      let authUser: any = null;
      try {
        const { data: got } = await supabaseAdmin.auth.admin.getUserById(String(data.userId));
        authUser = got?.user ?? null;
      } catch (e) {
        console.error("submitSignup: getUserById failed", e);
      }
      // Only trust the userId when it really is the account for this signup.
      // Compare against the LOGIN address, not the member's own: a child
      // enrolled by a parent has no address of their own to match.
      if (
        authUser &&
        String(authUser.email ?? "").toLowerCase() === accountEmail.toLowerCase()
      ) {
        await supabaseAdmin
          .from("members")
          .update({ user_id: authUser.id, updated_at: now })
          .eq("id", member.id);

        const { data: existingMembership } = await supabaseAdmin
          .from("dojo_memberships")
          .select("id")
          .eq("user_id", authUser.id)
          .eq("dojo_id", data.dojoId)
          .maybeSingle();

        if (!existingMembership) {
          const { error: dmErr } = await supabaseAdmin
            .from("dojo_memberships")
            .insert({ user_id: authUser.id, dojo_id: data.dojoId, role: "member" });
          if (dmErr && (dmErr as any).code !== "23505") {
            console.error("submitSignup: dojo membership insert failed", dmErr);
          }
        }

        // A parent enrolling a child holds the login. Recording that plainly
        // is what lets them add a second child later, and act for both, rather
        // than inventing a second email address to sign up again.
        if (minor) {
          try {
            const { linkManager } = await import("@/lib/managed-members.server");
            await linkManager({
              db: supabaseAdmin,
              dojoId: data.dojoId,
              memberId: member.id,
              userId: authUser.id,
              relationship: guardianRelationship || null,
            });
          } catch (e) {
            console.error("submitSignup: guardian link failed", e);
          }
        }
      }
    }

    // The person signing up is the family's designated payer — recorded
    // explicitly so only they are ever charged.
    if (familyGroupId) {
      await supabaseAdmin
        .from("family_groups")
        .update({ payer_member_id: member.id })
        .eq("id", familyGroupId);
    }

    // Insert dependent members and mark them plan_covered_by the payer
    if (familyGroupId && dependents.length > 0) {
      const depRows = dependents.map((d) => {
        const depDob = (d.dateOfBirth ?? "").trim() || null;
        const depIsMinor = isUnder18(depDob);
        // An under-18 dependent is covered by the adult who signed this form.
        // When that signer is themselves a minor, their own guardian carries
        // over. The relationship is not asked for per dependent, so it stays
        // null rather than being guessed.
        //
        // No waiver fields are set here. Dependents sign nothing at signup --
        // only the payer does -- so recording an audience or a signer against
        // them would assert a signature that was never given.
        return {
          dojo_id: data.dojoId,
          family_group_id: familyGroupId,
          plan_covered_by: member.id,
          name: d.name.trim(),
          email: (d.email ?? "").trim() || null,
          phone: (d.phone ?? "").trim() || null,
          discipline: discipline as any,
          plan: "Family" as any,
          status: memberStatus as any,
          free_trial_ends_at: freeTrialEndsAt,
          payment_status: "none" as any,
          belt_color: "beginner" as any,
          belt_label: "Beginner",
          stripes: 0,
          joined_at: now,
          signup_source: "public_signup_family",
          lead_source: leadSource,
          referred_by: referredBy,
          date_of_birth: depDob,
          // Dependents are the ones actually training -- that is why they were
          // added -- whatever the payer answered for themselves.
          trains: true,
          guardian_name: depIsMinor ? (minor ? guardianName : name) : null,
          guardian_email: depIsMinor ? (minor ? guardianEmail : accountEmail) : null,
          guardian_phone: depIsMinor ? (minor ? guardianPhone : phone || null) : null,
          // Known when a parent enrols children on a family plan, because the
          // form asks how they are related. Still null for an adult adding
          // other adults, where nobody was asked.
          guardian_relationship: depIsMinor ? guardianRelationship || null : null,
        };
      });
      const { data: insertedDeps, error: depErr } = await supabaseAdmin
        .from("members")
        .insert(depRows)
        .select("id, name, date_of_birth");
      if (depErr) throw depErr;

      // The payer signs on behalf of every child they add -- the form names
      // them and asks explicitly -- so that signature is recorded against each
      // one. Without it a minor trains with nothing on file, which is the one
      // thing a waiver exists to prevent.
      //
      // Adult dependants are deliberately left unsigned: nobody may sign for
      // an adult but themselves, and claiming otherwise would be worse than
      // the gap it fills.
      const minorDeps = (insertedDeps ?? []).filter((d: any) =>
        isUnder18(d.date_of_birth),
      );
      if (minorDeps.length > 0) {
        const depWaiver = minorWaiver ?? adultWaiver;
        const depAudience: "adult" | "minor" = minorWaiver ? "minor" : "adult";
        const depIds = minorDeps.map((d: any) => d.id);

        const { error: depMemberErr } = await supabaseAdmin
          .from("members")
          .update({
            waiver_signed_at: now,
            waiver_version_accepted: depWaiver?.version ?? null,
            waiver_audience_accepted: depAudience,
            waiver_signed_by: "guardian",
          })
          .in("id", depIds);
        if (depMemberErr) throw depMemberErr;

        const { error: depWaiverErr } = await supabaseAdmin
          .from("member_waivers")
          .insert(
            minorDeps.map((d: any) => ({
              member_id: d.id,
              dojo_id: data.dojoId,
              waiver_id: depWaiver?.id ?? null,
              waiver_version: depWaiver?.version ?? null,
              signed_name: signedName,
              signature_text: signatureText,
              // The payer is the guardian who signed for them.
              guardian_name: name,
              waiver_audience: depAudience,
              signed_by: "guardian",
              signed_at: now,
            })),
          );
        if (depWaiverErr) throw depWaiverErr;
      }
    }

    // Record waiver signature for payer (against the version they accepted)
    const { error: waiverError } = await supabaseAdmin
      .from("member_waivers")
      .insert({
        member_id: member.id,
        dojo_id: data.dojoId,
        waiver_id: currentWaiver?.id ?? null,
        waiver_version: currentWaiver?.version ?? null,
        signed_name: signedName,
        signature_text: signatureText,
        guardian_name: minor ? guardianName : null,
        waiver_audience: signedAudience,
        signed_by: minor ? "guardian" : "member",
        signed_at: now,
      });
    if (waiverError) throw waiverError;

    // MEMBER SELF-SIGNUP FLOW: the member picked a plan, so payment is part of
    // joining — send them straight to Stripe Checkout. Admin-created members
    // (AddMemberDialog) deliberately never reach this code.
    let checkoutUrl: string | null = null;
    let checkoutError: string | null = null;
    if (planRow && planRow.price_cents > 0) {
      try {
        const {
          PLATFORM_FEE_PERCENT,
  subscriptionAppFeePercent,
          totalAppFeeCents,
          getOrigin,
          getPlatformStripe,
          hasStripeSecret,
          planSubscriptionBilling,
          billingModeFromDojo,
        } = await import("@/lib/stripe-connect.server");

        if (!hasStripeSecret()) {
          console.error("Signup: STRIPE_SECRET_KEY missing — cannot start checkout");
          checkoutError =
            "This gym can't take online payments yet. Your place is saved — contact the gym to pay.";
        } else {
          const { data: dojoAcct } = await supabaseAdmin
            .from("dojos")
            .select(
              "stripe_account_id, stripe_charges_enabled, slug, pass_platform_fee_to_members, billing_day_of_month, billing_mode, timezone, payment_methods, stripe_account_country, country, default_currency",
            )
            .eq("id", data.dojoId)
            .single();

          if (!dojoAcct?.stripe_account_id || !dojoAcct.stripe_charges_enabled) {
            console.error("Signup: dojo has not finished payment setup", data.dojoId);
            checkoutError =
              "This gym hasn't finished setting up online payments. Your place is saved — contact the gym to pay.";
          } else {

            const stripeAccount = dojoAcct.stripe_account_id;
            const passFee = !!dojoAcct.pass_platform_fee_to_members;
            const stripe = getPlatformStripe();

            const { data: planFull } = await supabaseAdmin
              .from("dojo_plans")
              .select("id, name, price_cents, currency, interval, stripe_price_id")
              .eq("id", planRow.id)
              .single();

            // Only mint a Stripe Price when we'll charge the plan's real price.
            // Pass-through checkouts use inline price_data so we can charge the
            // gross amount without a shadow Stripe Price.
            let priceId = planFull?.stripe_price_id ?? null;
            if (!passFee && !priceId && planFull) {
              const product = await stripe.products.create(
                { name: planFull.name, metadata: { dojo_plan_id: planFull.id } },
              );
              const isOneTime = planFull.interval === "one_time";
              const price = await stripe.prices.create(
                {
                  product: product.id,
                  unit_amount: planFull.price_cents,
                  currency: (planFull.currency ?? "usd").toLowerCase(),
                  lookup_key: `plan_${planFull.id}`,
                  metadata: { dojo_plan_id: planFull.id },
                  ...(isOneTime
                    ? {}
                    : { recurring: { interval: planFull.interval as "month" | "year" } }),
                },
              );
              priceId = price.id;
              await supabaseAdmin
                .from("dojo_plans")
                .update({ stripe_price_id: priceId })
                .eq("id", planFull.id);
            }

            // The Stripe customer is the PAYER. On a child's membership the
            // member has no address of their own, so billing this to `email`
            // would create a customer with no address at all: no receipts, no
            // failed-payment notice, nothing reaching the parent.
            const customer = await stripe.customers.create(
              { email: accountEmail, name, metadata: { member_id: member.id } },
            );
            await supabaseAdmin
              .from("members")
              .update({ stripe_customer_id: customer.id })
              .eq("id", member.id);

            const origin = getOrigin();
            const returnBase = `/j/${dojoAcct.slug ?? ""}/signup`;
            const isOneTime = planRow.interval === "one_time";

            // Tiered family pricing: the payer is charged the discounted sum of
            // every family member's own plan price.
            const { familyTotalForPayer } = await import("@/lib/family-pricing.server");
            // Gated on being the family's designated payer (2+ members), not
            // on plan_type — a family payer on a Monthly plan still gets the
            // tiered discount.
            const familyQuote = await familyTotalForPayer(
              supabaseAdmin,
              data.dojoId,
              member.id,
              // Everyone in a family created seconds ago is "pending" -- they
              // are paying through the very checkout being built here.
              { countPending: true },
            );

            // A family that prices to nothing is a bug, not a free membership:
            // `??` would keep a zero here, and the subscription would bill zero
            // for as long as it existed. Refuse rather than create it.
            if (familyQuote && familyQuote.totalCents <= 0) {
              throw new Error(
                "This family plan priced to zero, so no payment was set up. Please contact the gym — nobody has been charged.",
              );
            }

            const originalCents = familyQuote?.totalCents ?? planRow.price_cents;
            const grossCents = passFee
              ? originalCents + Math.round((originalCents * PLATFORM_FEE_PERCENT) / 100)
              : originalCents;
            const currency = (
              familyQuote?.currency ?? planFull?.currency ?? "usd"
            ).toLowerCase();
            const baseName = familyQuote
              ? `${planFull?.name ?? "Family plan"} — ${familyQuote.size} ${familyQuote.size === 1 ? "member" : "members"} (${familyQuote.discountPercent}% family discount)`
              : (planFull?.name ?? "Plan");
            const displayName = passFee
              ? `${baseName} (includes ${PLATFORM_FEE_PERCENT}% platform fee)`
              : baseName;

            const lineItems =
              passFee || familyQuote
                ? [
                    {
                      quantity: 1,
                      price_data: {
                        currency,
                        unit_amount: grossCents,
                        product_data: { name: displayName, metadata: { dojo_plan_id: planRow.id } },
                        ...(isOneTime
                          ? {}
                          : { recurring: { interval: planRow.interval as "month" | "year" } }),
                      },
                    },
                  ]
                : [{ price: priceId!, quantity: 1 }];


            // Margin PLUS Stripe's cost: the gym pays card fees, as agreed and
            // as they would with any provider. Claiming only the margin left
            // the platform paying Stripe out of its own balance.
            const oneTimeAppFee = totalAppFeeCents(originalCents, grossCents);
            const subAppFeePercent = subscriptionAppFeePercent(originalCents, grossCents, passFee);

            // Monthly plans anchor to the gym's billing day in its timezone;
            // annual plans charge in full today and renew on the same date
            // next year with no proration.
            const billing = planSubscriptionBilling({
              interval: planRow.interval,
              grossCents,
              currency,
              billingDay: (dojoAcct as any).billing_day_of_month,
              billingMode: billingModeFromDojo(dojoAcct),
              timezone: (dojoAcct as any).timezone ?? "UTC",
            });

            // Direct debit follows the payer as well as the gym: SEPA for EUR
            // charges from SEPA-area payers, BACS only for GBP on a GB
            // account with a UK payer.
            let payerCountry: string | null = null;
            try {
              const cust = await stripe.customers.retrieve(customer.id);
              payerCountry = (cust as any)?.address?.country ?? null;
            } catch {
              payerCountry = null;
            }
            const { resolveCheckoutPaymentMethods } = await import(
              "@/lib/payment-methods"
            );
            const paymentMethodTypes = resolveCheckoutPaymentMethods({
              currency,
              accountCountry:
                (dojoAcct as any).stripe_account_country ?? (dojoAcct as any).country,
              payerCountry,
              enabled: (dojoAcct as any).payment_methods,
              settingsCurrency: (dojoAcct as any).default_currency,
              oneTime: isOneTime,
            });


            // TRIAL MEMBERS ARE NOT CHARGED AT SIGNUP. `resolveTrialDeferral`
            // is the single source of truth for the trial end date, including
            // the deliberately generous provisional value before their first
            // class and the correction made by syncTrialEndAfterAttendance the
            // moment they attend.
            let trialEndUnix: number | null = null;
            if (deferChargeToTrialEnd && !isOneTime) {
              try {
                const { resolveTrialDeferral } = await import("@/lib/trial-billing.server");
                const deferral = await resolveTrialDeferral(
                  supabaseAdmin,
                  data.dojoId,
                  member.id,
                );
                trialEndUnix = deferral?.unix ?? null;
              } catch (e) {
                // Better to charge slightly late than to charge a trial member
                // early, so a failure here must not silently bill them today.
                console.error("[signup] trial deferral lookup failed", e);
                throw e;
              }
            }

            const session = await stripe.checkout.sessions.create(
              {
                mode: isOneTime ? "payment" : "subscription",
                customer: customer.id,
                line_items: lineItems as any,
                payment_method_types: paymentMethodTypes as any,
                success_url: `${origin}${returnBase}?payment=success&member=${member.id}`,
                cancel_url: `${origin}${returnBase}?payment=cancelled&member=${member.id}`,
                metadata: {
                  type: "member_dues",
                  memberId: member.id,
                  dojoId: data.dojoId,
                  planId: planRow.id,
                  pass_platform_fee_to_members: passFee ? "true" : "false",
                },
                ...(isOneTime
                  ? {
                      payment_intent_data: {
                        application_fee_amount: oneTimeAppFee,
                        transfer_data: { destination: stripeAccount },
                        on_behalf_of: stripeAccount,
                        metadata: {
                          type: "member_dues",
                          memberId: member.id,
                          dojoId: data.dojoId,
                          planId: planRow.id,
                        },
                      },
                    }
                  : {
                      subscription_data: {
                        application_fee_percent: subAppFeePercent,
                        // A deferred trial charge owns the billing anchor: the
                        // trial end becomes the first payment date, so an
                        // anchor or proration alongside it would charge early.
                        ...(trialEndUnix
                          ? { trial_end: trialEndUnix }
                          : billing.billingCycleAnchor
                            ? {
                                billing_cycle_anchor: billing.billingCycleAnchor,
                                proration_behavior: billing.prorationBehavior,
                              }
                            : {}),
                        transfer_data: { destination: stripeAccount },
                        on_behalf_of: stripeAccount,
                        metadata: {
                          type: "member_dues",
                          memberId: member.id,
                          dojoId: data.dojoId,
                          planId: planRow.id,
                        },
                      },
                    }),
              },
            );
            checkoutUrl = session.url;
          }
        }
      } catch (e) {
        // MEMBER SELF-SIGNUP: paying is part of joining, so a rejected
        // Checkout session must be surfaced, never swallowed.
        const { getConnectErrorMessage } = await import(
          "@/lib/stripe-connect.server"
        );
        const message = getConnectErrorMessage(e);
        console.error("Member self-signup checkout failed:", message, e);
        checkoutError = message;
      }
    }


    // FREE TRIAL SIGNUP: nothing is charged, so this is where the signup ends
    // and the welcome belongs. Paid signups are welcomed from the Stripe
    // webhook instead, once the payment has actually completed.
    if (!checkoutUrl && !(planRow && planRow.price_cents > 0)) {
      try {
        const { sendSignupWelcome } = await import("@/lib/welcome-email.server");
        const res = await sendSignupWelcome({
          dojoId: data.dojoId,
          memberId: member.id,
          kind: "trial",
        });
        if (!res.ok) console.error("[signup] trial welcome email not sent:", res.error);
      } catch (e) {
        // The member is registered — never fail a signup over the welcome.
        console.error("[signup] trial welcome email failed", e);
      }
    }

    // Tell the gym someone has joined. A small gym otherwise finds out when
    // the owner next opens the app, which can be days.
    try {
      const { sendNewSignupAlert } = await import("@/lib/staff-notify.server");
      const res = await sendNewSignupAlert({
        dojoId: data.dojoId,
        memberId: member.id,
        planName: planRow?.name ?? null,
        payment: checkoutUrl
          ? "checkout"
          : planRow && planRow.price_cents > 0
            ? "none"
            : "trial",
        via: "signup",
      });
      if (!res.ok) console.error("[signup] staff alert not sent:", res.error);
    } catch (e) {
      // The member is registered — never fail a signup over a notification.
      console.error("[signup] staff alert failed", e);
    }

    return { memberId: member.id, checkoutUrl, checkoutError };
  });

