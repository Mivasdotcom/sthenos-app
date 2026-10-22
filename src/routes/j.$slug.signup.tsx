import {
  signupFreePeriodEnd,
  trialOffered,
  trialPolicyDescription,
  trialPolicyFromDojo,
  trialPolicyLabel,
} from "@/lib/trial-policy";

import { PUBLIC_SITE_URL } from "@/lib/site";
import { useEffect, useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  getDojoBySlug,
  getDojoPlansPublic,
  getFamilyPricingPublic,
  getDojoClassTypes,
  submitSignup,
} from "@/lib/signup.functions";
import { TurnstileWidget, turnstileEnabled } from "@/components/TurnstileWidget";
import { FamilyPricingBreakdown } from "@/components/FamilyPricingBreakdown";

import { computeFamilyQuote, DEFAULT_FAMILY_TIERS } from "@/lib/family-pricing";
import { getPublicAgreements } from "@/lib/agreements.functions";
import { getPublicPrivacyNotice } from "@/lib/privacy.functions";
import { getTodayClasses, bookFirstClass } from "@/lib/signup-classes.functions";
import { PlanPicker } from "@/components/PlanPicker";
import { PLATFORM_FEE_PERCENT, grossChargeCents } from "@/lib/platform-fee";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { billingModeOf, billingTimingSentence } from "@/lib/billing-copy";
import { LEAD_SOURCES, REFERRAL_LEAD_SOURCE } from "@/lib/lead-sources";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, ArrowRight, Check, Shield, CreditCard, Calendar, Clock, Users } from "lucide-react";
import { buildDisciplineOptions, getBeltColors } from "@/lib/belt-colors";
import { DEFAULT_WAIVER_BODY, DEFAULT_WAIVER_TITLE } from "@/lib/waiver-defaults";
import { MEDIA_CONSENT_HINT, mediaConsentLabel } from "@/lib/consent";
import { GUARDIAN_RELATIONSHIPS, isUnder18 } from "@/lib/minors";
import { Info } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { linkMemberOnAuth } from "@/lib/link-member.functions";
import { useDojoLogoUrl } from "@/hooks/use-dojo-logo";

function PublicDojoLogo({ name, logoPath }: { name: string; logoPath: string | null }) {
  const url = useDojoLogoUrl(logoPath);
  if (!url) return null;
  return (
    <img
      src={url}
      alt={`${name} logo`}
      className="mx-auto mb-3 size-16 rounded-lg object-contain"
    />
  );
}


type Step = "info" | "plan" | "waiver" | "success";

type FamilyDependent = { name: string; email: string; phone: string; dateOfBirth: string };

/**
 * Who this form is being filled in for. Asked before anything else, because
 * every label after it changes: a parent enrolling a child enters the CHILD'S
 * name and date of birth, but their OWN email and password.
 */
type SigningFor = "" | "self" | "child";

type FormState = {
  signingFor: SigningFor;
  name: string;
  /** The address that owns the login. The PARENT'S on the child path. */
  email: string;
  password: string;
  confirmPassword: string;
  phone: string;
  discipline: string;
  beltColor: string;
  leadSource: string;
  referredBy: string;
  selectedPlanId: string | null;
  waiverAgreed: boolean;
  termsAgreed: boolean;
  mediaConsent: boolean;
  dateOfBirth: string;
  signedName: string;
  guardianName: string;
  guardianEmail: string;
  guardianPhone: string;
  guardianRelationship: string;
  /** Whether the parent trains too, or only pays. Only asked on the child path. */
  guardianTrains: boolean;
  /** The PARENT'S date of birth, needed only when they train themselves. */
  guardianDob: string;
  selectedClassId: string | null;
  familyMembers: FamilyDependent[];
  /** Explicit confirmation that the signer is the family's designated payer. */
  payerConfirmed: boolean;
};

const MIN_PASSWORD_LENGTH = 8;

const emptyForm: FormState = {
  signingFor: "",
  name: "",
  email: "",
  password: "",
  confirmPassword: "",
  phone: "",
  discipline: "BJJ",
  beltColor: "beginner",
  leadSource: "",
  referredBy: "",
  selectedPlanId: null,
  waiverAgreed: false,
  termsAgreed: false,
  mediaConsent: false,
  dateOfBirth: "",
  signedName: "",
  guardianName: "",
  guardianEmail: "",
  guardianPhone: "",
  guardianRelationship: "",
  guardianTrains: false,
  guardianDob: "",
  selectedClassId: null,
  familyMembers: [],
  payerConfirmed: false,
};


export const Route = createFileRoute("/j/$slug/signup")({
  head: ({ params }) => {
    const url = `${PUBLIC_SITE_URL}/j/${params.slug}/signup`;
    const title = `Sign up — ${params.slug}`;
    const description = `Join the ${params.slug} martial arts gym: pick a plan, sign the waiver, and start training.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:url", content: url },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: description },
      ],
      links: [{ rel: "canonical", href: url }],
    };
  },
  component: SignupPage,
  notFoundComponent: () => (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This signup link doesn't exist or the gym hasn't enabled public signups yet.
        </p>
      </div>
    </div>
  ),
});

function formatTime(t: string): string {
  // t may be "HH:MM:SS" or "HH:MM"
  const [h, m] = t.split(":");
  const hn = Number(h);
  const suffix = hn >= 12 ? "PM" : "AM";
  const h12 = ((hn + 11) % 12) + 1;
  return `${h12}:${m ?? "00"} ${suffix}`;
}

function SignupPage() {
  const { slug } = Route.useParams();
  const router = useRouter();
  const [step, setStep] = useState<Step>("info");
  // A trial has to be picked deliberately: selectedPlanId is null both before
  // anyone chooses and when the free trial is chosen, so track the choice.
  const [trialChosen, setTrialChosen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [existingAccount, setExistingAccount] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

  const getDojoFn = useServerFn(getDojoBySlug);
  const getPublicPrivacyNoticeFn = useServerFn(getPublicPrivacyNotice);
  const getPlansFn = useServerFn(getDojoPlansPublic);
  const getClassTypesFn = useServerFn(getDojoClassTypes);
  const getAgreementsFn = useServerFn(getPublicAgreements);
  const getTodayClassesFn = useServerFn(getTodayClasses);
  const submitFn = useServerFn(submitSignup);
  const bookFn = useServerFn(bookFirstClass);
  const linkFn = useServerFn(linkMemberOnAuth);

  // Returning from Stripe Checkout — the member is already signed in.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const payment = params.get("payment");
    if (payment === "success") {
      toast.success("Payment complete — welcome aboard!");
      router.navigate({ to: "/portal" });
    } else if (payment === "cancelled") {
      toast.error("Payment cancelled. You can pay from your portal any time.");
    }
  }, [router]);


  const { data: dojoData, isLoading: dojoLoading, error: dojoError } = useQuery({
    queryKey: ["dojo-public", slug],
    queryFn: () => getDojoFn({ data: { slug } }),
    retry: false,
  });

  const dojo = dojoData?.dojo;

  // The gym is the data controller, so members are pointed at the gym's OWN
  // published notice. Until it is published we don't present one at all.
  const { data: privacyData } = useQuery({
    queryKey: ["public-privacy-notice", slug],
    queryFn: () => getPublicPrivacyNoticeFn({ data: { slug } }),
    retry: false,
  });
  const privacyPublished = !!privacyData?.notice;
  const privacyContactEmail = privacyData?.dojo.contactEmail ?? null;

  const { data: plansData } = useQuery({
    queryKey: ["dojo-plans-public", dojo?.id],
    queryFn: () => getPlansFn({ data: { dojoId: dojo!.id } }),
    enabled: !!dojo?.id,
  });

  const getFamilyPricingFn = useServerFn(getFamilyPricingPublic);
  const { data: familyPricing } = useQuery({
    queryKey: ["dojo-family-pricing-public", dojo?.id],
    queryFn: () => getFamilyPricingFn({ data: { dojoId: dojo!.id } }),
    enabled: !!dojo?.id,
  });



  const { data: classTypesData } = useQuery({
    queryKey: ["dojo-class-types-public", dojo?.id],
    queryFn: () => getClassTypesFn({ data: { dojoId: dojo!.id } }),
    enabled: !!dojo?.id,
  });

  const { data: agreementsData } = useQuery({
    queryKey: ["dojo-agreements-public", dojo?.id],
    queryFn: () => getAgreementsFn({ data: { dojoId: dojo!.id } }),
    enabled: !!dojo?.id,
  });

  const { data: todayClassesData } = useQuery({
    queryKey: ["dojo-today-classes-public", dojo?.id],
    queryFn: () => getTodayClassesFn({ data: { dojoId: dojo!.id } }),
    enabled: !!dojo?.id && step === "waiver",
  });

  const submitMut = useMutation({
    mutationFn: async () => {
      setExistingAccount(false);
      const emailTrim = form.email.trim();
      const minorAtSubmit = isUnder18(form.dateOfBirth || null);
      // On the child path the address on this form is the PARENT'S: it owns
      // the login and receives everything, and the child is stored with no
      // address of their own. That keeps the parent's address free, so it is
      // still available if they ever join themselves.
      const forChildAtSubmit = form.signingFor === "child";
      // Child + family plan: the PARENT is the payer member and every child is
      // a dependent, so the group is headed by an adult and one signup covers
      // the whole household. Child + individual plan is unchanged.
      const planAtSubmit = plans.find((p) => p.id === form.selectedPlanId) ?? null;
      const familyAtSubmit =
        forChildAtSubmit && (planAtSubmit as any)?.plan_type === "family";
      // On the family path the signer is the parent, as an adult, so no
      // guardian is recorded against the payer's own row.
      const signerIsMinor = minorAtSubmit && !familyAtSubmit;


      // 1. Create the login so the member can reach their portal.
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email: emailTrim,
        password: form.password,
        options: {
          emailRedirectTo: window.location.origin,
          data: { full_name: form.name.trim() },
        },
      });

      // Only an explicit "already registered" error from Supabase counts.
      const alreadyRegistered =
        !!authError &&
        (authError.code === "user_already_exists" ||
          /already\s+(been\s+)?registered|already\s+exists|user\s+already/i.test(
            authError.message ?? "",
          ));

      if (alreadyRegistered) {
        setExistingAccount(true);
        throw new Error("ALREADY_REGISTERED");
      }
      if (authError) throw authError;
      void authData;

      // 2. Create the member record for this gym.
      const res = await submitFn({
        data: {
          dojoId: dojo!.id,
          name: familyAtSubmit ? form.guardianName.trim() : form.name,
          // The payer owns the address on the family path -- they are a member
          // in their own right, not a login attached to a child's record.
          email: familyAtSubmit ? emailTrim : forChildAtSubmit ? "" : emailTrim,
          accountEmail: emailTrim,
          trains: familyAtSubmit ? form.guardianTrains : true,
          phone: form.phone || null,
          discipline: form.discipline,
          beltColor: form.beltColor,
          beltLabel: form.beltColor === "beginner" ? "Beginner" : (form.beltColor[0].toUpperCase() + form.beltColor.slice(1)),
          selectedPlanId: form.selectedPlanId,
          signedName: form.signedName,
          signatureText: form.signedName,
          guardianName: signerIsMinor ? form.guardianName.trim() : null,
          guardianEmail: signerIsMinor
            ? forChildAtSubmit
              ? emailTrim
              : form.guardianEmail.trim()
            : null,
          guardianPhone: signerIsMinor ? form.guardianPhone.trim() : null,
          // Sent on the family path too, where it describes the PAYER'S
          // relationship to the children rather than to themselves.
          guardianRelationship:
            signerIsMinor || familyAtSubmit ? form.guardianRelationship.trim() : null,
          leadSource: form.leadSource || null,
          referredBy:
            form.leadSource === REFERRAL_LEAD_SOURCE ? form.referredBy.trim() || null : null,
          mediaConsent: form.mediaConsent,
          termsAccepted: form.termsAgreed,
          // On the family path this row is the parent's, so it carries THEIR
          // date of birth -- and none at all when they only pay.
          dateOfBirth: familyAtSubmit
            ? form.guardianDob || null
            : form.dateOfBirth || null,
          turnstileToken,
          userId: authData?.user?.id ?? null,
          familyMembers: [
            // The child named at step 1 is the first dependent on the family
            // path -- they were entered before the plan was chosen, so they
            // are not in the dependants list the payer filled in later.
            ...(familyAtSubmit
              ? [
                  {
                    name: form.name.trim(),
                    email: "",
                    phone: null,
                    dateOfBirth: form.dateOfBirth || null,
                  },
                ]
              : []),
            ...form.familyMembers
              .filter((f) => f.name.trim().length >= 2)
              .map((f) => ({
                name: f.name.trim(),
                email: f.email.trim(),
                phone: f.phone.trim() || null,
                dateOfBirth: f.dateOfBirth || null,
              })),
          ],
        },
      });

      // 3. Attach the new member row to the signed-in auth user.
      try {
        await linkFn({ data: undefined } as any);
      } catch (linkErr) {
        console.error("signup: linking member to auth user failed", linkErr);
      }

      if (form.selectedClassId && res?.memberId) {
        try {
          await bookFn({
            data: {
              dojoId: dojo!.id,
              classId: form.selectedClassId,
              memberId: res.memberId,
            },
          });
        } catch (bookErr: any) {
          toast.error(
            bookErr?.message ?? "Signed up, but couldn't book that class. Try again from your portal.",
          );
        }
      }

      return res;
    },
    onSuccess: (res) => {
      // Paid plan → Stripe Checkout; we come back to ?payment=success signed in.
      if (res?.checkoutUrl) {
        window.location.href = res.checkoutUrl;
        return;
      }
      if (res?.checkoutError) {
        // The account and pending member record are preserved so payment can
        // be retried safely from the portal without creating a duplicate.
        window.location.href = `/portal?payment=setup_failed&error=${encodeURIComponent(res.checkoutError)}`;
        return;
      }
      setStep("success");
      toast.success("Welcome aboard!");
      // Hard navigation: the membership row was created server-side moments
      // ago, so the app must re-read auth + membership state from scratch
      // rather than reuse the pre-signup (empty) snapshot.
      window.location.href = "/portal";

    },
    onError: (e: any) => {
      if (e?.message === "ALREADY_REGISTERED") return;
      toast.error(e?.message ?? "Something went wrong. Please try again.");
    },
  });


  if (dojoLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (dojoError || !dojo || !dojo.public_page_enabled) {
    const notFound = !!dojoError || !dojo;
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            {notFound ? "Gym not found" : "Signups are closed"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {notFound
              ? "Check the link with your gym — this signup page doesn't exist."
              : "This gym isn't accepting new signups through this link right now. Check with your gym."}
          </p>
        </div>
      </div>
    );
  }

  const plans = (plansData?.plans ?? []) as any[];

  // The free option is named from the gym's configured trial policy: "Free
  // Trial Week" for 7 days, "Free Trial Class" for 1, and nothing at all when
  // the gym doesn't offer a trial.
  const trialPolicy = trialPolicyFromDojo(dojo);
  // SIGNUP FREE PERIOD (per-gym, 0 = off): everyone picks a plan and enters a
  // card, trains with full access for N days, then the first payment is taken
  // automatically. When it is on, the "trial only, no plan" option is removed.
  const signupFreeDays = Number((dojo as { signup_free_days?: number | null }).signup_free_days ?? 0) || 0;
  // Same rolling N x 24 hour window the signup, checkout, portal and emails use
  // (`signupFreePeriodEnd`), so the date quoted here is the charge date.
  const freePeriodEndsOn = (() => {
    if (signupFreeDays <= 0) return null;
    return signupFreePeriodEnd(signupFreeDays).toLocaleDateString(undefined, {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  })();

  const trialOfferedHere = trialOffered(trialPolicy);
  const trialAllowance = signupFreeDays > 0 ? 0 : trialOfferedHere ? 1 : 0;
  const trialLabel = trialPolicyLabel(trialPolicy) ?? "Free Trial";
  const trialDescription = trialPolicyDescription(trialPolicy);
  const classTypes = (classTypesData?.classTypes ?? []) as Array<{ id: string; discipline: string }>;
  const disciplineOptions = buildDisciplineOptions(
    classTypes.map((ct) => ct.discipline).filter(Boolean),
  );
  const beltOptions = getBeltColors(form.discipline);
  const minor = isUnder18(form.dateOfBirth || null);
  const forChild = form.signingFor === "child";
  // A parent enrolling a child ON A FAMILY PLAN becomes the payer member and
  // the child becomes a dependent, so the group is headed by an adult rather
  // than by a five-year-old. On an individual plan nothing changes: the child
  // is the member and the parent is only a login on their record.
  const selectedPlan = plans.find((p) => p.id === form.selectedPlanId) ?? null;
  const familyPath = forChild && (selectedPlan as any)?.plan_type === "family";
  // Who is actually signing. On the family path it is the parent, as an adult
  // in their own right, so the ADULT waiver applies even though the date of
  // birth entered above belongs to their child.
  const signerIsGuardian = minor && !familyPath;
  // Everyone this signature has to cover on the family path: the child named
  // at step 1, plus any others added on the plan step.
  const familyChildNames = familyPath
    ? [
        ...(isUnder18(form.dateOfBirth || null) && form.name.trim() ? [form.name.trim()] : []),
        ...form.familyMembers
          .filter((f) => f.name.trim().length >= 2 && isUnder18(f.dateOfBirth || null))
          .map((f) => f.name.trim()),
      ]
    : [];
  // A signature can only cover children if the signer was asked to give it on
  // their behalf, so the minor waiver is what gets shown once any child is in
  // the family.
  const signingForChildren = familyChildNames.length > 0;
  const adultWaiver = agreementsData?.adultWaiver ?? agreementsData?.waiver ?? null;
  const minorWaiver = agreementsData?.minorWaiver ?? null;
  // Under-18s sign the gym's minor waiver when it has one; otherwise the adult
  // waiver, still signed by a parent or guardian.
  const waiver = (signerIsGuardian || signingForChildren
    ? (minorWaiver ?? adultWaiver)
    : adultWaiver) ?? {
    title: DEFAULT_WAIVER_TITLE,
    body_markdown: DEFAULT_WAIVER_BODY,
  };
  const terms = agreementsData?.terms ?? null;
  const collectMediaConsent = agreementsData?.collectMediaConsent !== false;
  const todayClasses = todayClassesData?.classes ?? [];

  // "My child" was chosen but the date of birth given is an adult's. The
  // waiver has to follow the date of birth rather than the button, so say so
  // instead of quietly filing guardian details against an adult.
  const childButAdultDob = forChild && form.dateOfBirth.trim().length > 0 && !minor;
  // Guardian details are asked for at step 1 now. They used to appear only at
  // the agreements step, long after the child's details had been typed in.
  const collectGuardian = forChild || minor;

  const passwordTooShort = form.password.length < MIN_PASSWORD_LENGTH;
  const passwordMismatch = form.confirmPassword !== form.password;
  // On the child path the login address is the guardian's by construction, so
  // it is not asked for a second time.
  const effectiveGuardianEmail = forChild ? form.email : form.guardianEmail;
  const guardianComplete =
    form.guardianName.trim().length >= 2 &&
    effectiveGuardianEmail.includes("@") &&
    form.guardianPhone.trim().length >= 5 &&
    form.guardianRelationship.trim().length >= 2;
  const canContinueInfo =
    form.signingFor !== "" &&
    form.name.trim().length >= 2 &&
    form.email.includes("@") &&
    // Required for everyone now. An unknown date of birth was being treated as
    // an adult, which quietly skipped the minor waiver and guardian capture.
    form.dateOfBirth.trim().length > 0 &&
    !passwordTooShort &&
    !passwordMismatch &&
    (!minor || guardianComplete) &&
    (form.leadSource !== REFERRAL_LEAD_SOURCE || form.referredBy.trim().length >= 2);
  const canSubmitWaiver =
    form.waiverAgreed &&
    form.signedName.trim().length >= 2 &&
    (!terms || form.termsAgreed) &&
    (!minor || guardianComplete) &&
    (!turnstileEnabled || !!turnstileToken);


  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-2xl px-4 py-10">
        <div className="mb-8 text-center">
          <PublicDojoLogo name={dojo.name} logoPath={(dojo as { logo_path?: string | null }).logo_path ?? null} />
          <h1 className="text-2xl font-semibold tracking-tight">{dojo.name}</h1>
          {dojo.tagline && (
            <p className="mt-1 text-sm text-muted-foreground">{dojo.tagline}</p>
          )}
        </div>

        <div className="mb-6 flex items-center justify-center gap-2">
          <StepDot active={step === "info"} done={step !== "info"} label="Info" />
          <StepLine done={step === "plan" || step === "waiver" || step === "success"} />
          <StepDot active={step === "plan"} done={step === "waiver" || step === "success"} label="Plan" />
          <StepLine done={step === "waiver" || step === "success"} />
          <StepDot active={step === "waiver"} done={step === "success"} label="Agreements" />
        </div>

        <div className="rounded-xl border border-zinc-950/10 bg-card p-6 shadow-sm sm:p-8">
          {step === "info" && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold">
                  {forChild ? "Your child's details" : "Your details"}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {forChild
                    ? "Enter your child's details here. We'll ask for yours below."
                    : "Tell us a little about yourself to get started."}
                </p>
              </div>

              {/* Asked first, because it decides whose name and date of birth
                  the next fields are for. Without it a parent reads "Your
                  details" and enters their own. */}
              <div className="space-y-2">
                <Label>Who is this membership for?</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {([
                    { value: "self", label: "Myself", hint: "I'm joining the gym" },
                    { value: "child", label: "My child", hint: "I'm a parent or guardian" },
                  ] as const).map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => update("signingFor", opt.value)}
                      className={`rounded-lg border p-3 text-left transition ${
                        form.signingFor === opt.value
                          ? "border-brand bg-brand/5 ring-1 ring-brand"
                          : "border-zinc-950/10 hover:border-zinc-950/20"
                      }`}
                    >
                      <div className="text-sm font-semibold">{opt.label}</div>
                      <div className="text-xs text-muted-foreground">{opt.hint}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="name">
                    {forChild ? "Child's full name" : "Full name"}
                  </Label>
                  <Input
                    id="name"
                    value={form.name}
                    onChange={(e) => update("name", e.target.value)}
                    placeholder={forChild ? "Maria Georgiou" : "John Doe"}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="email">
                    {forChild ? "Your email (parent or guardian)" : "Email"}
                  </Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    value={form.email}
                    onChange={(e) => {
                      setExistingAccount(false);
                      update("email", e.target.value);
                    }}
                    placeholder={forChild ? "parent@example.com" : "john@example.com"}
                  />
                  {forChild && (
                    <p className="text-xs text-muted-foreground">
                      Your address, not your child's. Everything about this membership
                      comes here.
                    </p>
                  )}
                </div>

                {existingAccount && (
                  <div className="rounded-lg border border-amber-300 bg-amber-100 p-3 text-sm text-amber-900">
                    {forChild ? (
                      <>
                        This address already has an account, so it can't start a second
                        signup. To add another child, ask {dojo.name} to add them to your
                        family — or{" "}
                        <Link to="/login" className="font-semibold underline">
                          log in
                        </Link>{" "}
                        to see the membership you already have.
                      </>
                    ) : (
                      <>
                        You already have an account —{" "}
                        <Link to="/login" className="font-semibold underline">
                          log in instead
                        </Link>
                        .
                      </>
                    )}
                  </div>
                )}

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="password">Password</Label>
                    <Input
                      id="password"
                      type="password"
                      autoComplete="new-password"
                      value={form.password}
                      onChange={(e) => update("password", e.target.value)}
                      placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                    />
                    {form.password.length > 0 && passwordTooShort && (
                      <p className="text-xs text-destructive">
                        Use at least {MIN_PASSWORD_LENGTH} characters.
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="confirmPassword">Confirm password</Label>
                    <Input
                      id="confirmPassword"
                      type="password"
                      autoComplete="new-password"
                      value={form.confirmPassword}
                      onChange={(e) => update("confirmPassword", e.target.value)}
                      placeholder="Re-enter your password"
                    />
                    {form.confirmPassword.length > 0 && passwordMismatch && (
                      <p className="text-xs text-destructive">Passwords don't match.</p>
                    )}
                  </div>
                </div>

                <p className="text-xs text-muted-foreground">
                  {forChild
                    ? "This creates your login. You'll manage your child's membership from here."
                    : "This creates your login so you can access your member portal."}
                </p>


                <div className="space-y-1.5">
                  <Label htmlFor="phone">
                    {/* Whose number this is follows who the form is for. The
                        guardian's is captured separately below. */}
                    {forChild ? "Child's phone (optional)" : "Phone (optional)"}
                  </Label>
                  <Input
                    id="phone"
                    value={form.phone}
                    onChange={(e) => update("phone", e.target.value)}
                    placeholder="+357 99 123456"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="dateOfBirth">
                    {forChild ? "Child's date of birth" : "Date of birth"}
                  </Label>
                  <Input
                    id="dateOfBirth"
                    type="date"
                    value={form.dateOfBirth}
                    onChange={(e) => update("dateOfBirth", e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Used for age-appropriate classes. For under-18s it also switches the
                    membership to a waiver signed by a parent or guardian, and we'll ask
                    for their contact details.
                  </p>
                </div>

                {/* Guardian details, asked here rather than at the agreements
                    step — by then the child's details have already been
                    entered with nothing on screen to say whose they are. */}
                {collectGuardian && (
                  <div className="space-y-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
                    <div>
                      <h3 className="text-sm font-semibold">
                        {forChild ? "Your details (parent or guardian)" : "Parent or guardian details"}
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {childButAdultDob
                          ? "That date of birth is 18 or over, so they'll sign for themselves. Change it if you meant a different date."
                          : "We'll use these for anything to do with this membership."}
                      </p>
                    </div>
                    {!childButAdultDob && (
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label htmlFor="guardianName">Parent/guardian full name</Label>
                          <Input
                            id="guardianName"
                            value={form.guardianName}
                            onChange={(e) => update("guardianName", e.target.value)}
                            placeholder="Jane Doe"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="guardianRelationship">Relationship to member</Label>
                          <Select
                            value={form.guardianRelationship}
                            onValueChange={(v) => update("guardianRelationship", v)}
                          >
                            <SelectTrigger id="guardianRelationship">
                              <SelectValue placeholder="Select" />
                            </SelectTrigger>
                            <SelectContent>
                              {GUARDIAN_RELATIONSHIPS.map((r) => (
                                <SelectItem key={r} value={r}>
                                  {r}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        {/* On the child path the account address IS the
                            guardian's, so asking twice only invites the two
                            to disagree. */}
                        {!forChild && (
                          <div className="space-y-1.5">
                            <Label htmlFor="guardianEmail">Parent/guardian email</Label>
                            <Input
                              id="guardianEmail"
                              type="email"
                              value={form.guardianEmail}
                              onChange={(e) => update("guardianEmail", e.target.value)}
                              placeholder="jane@example.com"
                            />
                          </div>
                        )}
                        <div className="space-y-1.5">
                          <Label htmlFor="guardianPhone">Parent/guardian phone</Label>
                          <Input
                            id="guardianPhone"
                            value={form.guardianPhone}
                            onChange={(e) => update("guardianPhone", e.target.value)}
                            placeholder="+357 99 123456"
                          />
                        </div>
                      </div>
                    )}
                    {/* Asked of the parent, about the parent. A guardian who
                        only pays still needs a record -- it holds the login,
                        the card and the family -- but must not be counted as
                        someone who trains. */}
                    {!childButAdultDob && (
                      <div className="space-y-3 border-t border-amber-500/20 pt-3">
                        <div className="flex items-start gap-3">
                          <Checkbox
                            id="guardianTrains"
                            checked={form.guardianTrains}
                            onCheckedChange={(v) => update("guardianTrains", v === true)}
                            className="mt-0.5"
                          />
                          <Label
                            htmlFor="guardianTrains"
                            className="text-sm font-normal leading-snug"
                          >
                            I'll be training here too, not just paying
                          </Label>
                        </div>
                        {form.guardianTrains && (
                          <div className="space-y-1.5">
                            <Label htmlFor="guardianDob">Your date of birth</Label>
                            <Input
                              id="guardianDob"
                              type="date"
                              value={form.guardianDob}
                              onChange={(e) => update("guardianDob", e.target.value)}
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label htmlFor="discipline">Discipline</Label>
                  <Select
                    value={form.discipline}
                    onValueChange={(v) => update("discipline", v)}
                  >
                    <SelectTrigger id="discipline">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {disciplineOptions.map((d) => (
                        <SelectItem key={d} value={d}>
                          {d}
                        </SelectItem>
                      ))}

                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="belt">Current rank</Label>
                  <Select
                    value={form.beltColor}
                    onValueChange={(v) => update("beltColor", v)}
                  >
                    <SelectTrigger id="belt">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {beltOptions.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c === "beginner"
                            ? "Beginner — never trained before"
                            : c[0].toUpperCase() + c.slice(1)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="leadSource">How did you hear about us?</Label>
                  <Select
                    value={form.leadSource}
                    onValueChange={(v) => update("leadSource", v)}
                  >
                    <SelectTrigger id="leadSource">
                      <SelectValue placeholder="Choose an option" />
                    </SelectTrigger>
                    <SelectContent>
                      {LEAD_SOURCES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {form.leadSource === REFERRAL_LEAD_SOURCE && (
                  <div className="space-y-1.5">
                    <Label htmlFor="referredBy">Who referred you?</Label>
                    <Input
                      id="referredBy"
                      value={form.referredBy}
                      onChange={(e) => update("referredBy", e.target.value)}
                      placeholder="Their name"
                      maxLength={120}
                      required
                    />
                  </div>
                )}

              </div>

              <div className="flex justify-end pt-2">
                <Button
                  className="bg-brand text-brand-foreground hover:bg-brand/90"
                  disabled={!canContinueInfo}
                  onClick={() => setStep("plan")}
                >
                  Continue
                  <ArrowRight className="ml-2 size-4" />
                </Button>
              </div>
            </div>
          )}

          {step === "plan" && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold">Choose a plan</h2>
                <p className="text-sm text-muted-foreground">
                  Pick the option that fits you. You can change this later.
                </p>
              </div>

              <PlanPicker
                plans={plans}
                value={form.selectedPlanId}
                onChange={(id) => {
                  update("selectedPlanId", id);
                  setTrialChosen(id === null);
                  const p = plans.find((pl) => pl.id === id);
                  if (p?.plan_type !== "family") update("familyMembers", []);
                }}
                showNoneOption={trialAllowance > 0}
                noneOptionTitle={trialLabel}
                noneOptionDescription={trialDescription}
                noneSelected={trialChosen}
                passPlatformFeeToMembers={!!(dojo as any)?.pass_platform_fee_to_members}
                platformFeePercent={PLATFORM_FEE_PERCENT}
              />

              {trialChosen && (
                <div className="rounded-lg border border-zinc-950/10 bg-surface p-4 text-sm">
                  <div className="font-semibold">{trialLabel}</div>
                  <p className="mt-1 text-muted-foreground">
                    No payment now — {trialDescription.charAt(0).toLowerCase() +
                      trialDescription.slice(1)}
                  </p>
                </div>
              )}

              {(() => {
                const p = plans.find((pl) => pl.id === form.selectedPlanId);
                if (p?.plan_type !== "family") return null;
                const cap = p.max_family_members ?? 6;
                const maxDeps = Math.max(1, cap - 1);
                // On the child path the person at step 1 is a CHILD, not the
                // payer, so they occupy a place of their own on top of the
                // parent's.
                const stepOneChild =
                  familyPath && form.name.trim().length >= 2 ? 1 : 0;
                const used = form.familyMembers.length + 1 + stepOneChild;
                const atLimit = form.familyMembers.length + stepOneChild >= maxDeps;
                return (
                  <div className="space-y-3 rounded-lg border border-zinc-950/10 bg-surface p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold">
                          {familyPath
                            ? `Add any other children joining (up to ${maxDeps}).`
                            : `Add the family members joining with you (up to ${maxDeps}).`}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          One payment covers everyone. Each person gets their own profile,
                          attendance and belt tracking.
                        </div>
                        <div className="mt-1 text-xs font-medium">
                          {used} of {cap} places used
                          {atLimit ? " — this plan is full" : ""}
                        </div>
                        {familyPricing?.mode === "tiered" && (
                          <div className="mt-2">
                            <FamilyPricingBreakdown
                              compact
                              passPlatformFeeToMembers={
                                !!(dojo as any)?.pass_platform_fee_to_members
                              }
                              platformFeePercent={PLATFORM_FEE_PERCENT}
                              quote={computeFamilyQuote({
                                members: [
                                  { name: form.name || "You", planName: p.name, priceCents: p.price_cents },
                                  ...form.familyMembers.map((fm, i) => ({
                                    name: fm.name || `Family member ${i + 1}`,
                                    planName: p.name,
                                    priceCents: p.price_cents,
                                  })),
                                ],
                                tiers: familyPricing.tiers.length
                                  ? familyPricing.tiers
                                  : DEFAULT_FAMILY_TIERS,
                                currency: p.currency,
                                interval: p.interval,
                              })}
                            />
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              Your gym applies a family discount based on how many of you join. The
                              final amount is confirmed at checkout.
                            </p>
                          </div>
                        )}
                      </div>

                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={atLimit}
                        onClick={() =>
                          update("familyMembers", [
                            ...form.familyMembers,
                            { name: "", email: "", phone: "", dateOfBirth: "" },
                          ])
                        }
                      >
                        Add person
                      </Button>
                    </div>

                    {atLimit && (
                      <p className="text-xs font-medium text-amber-700">
                        This family plan covers {cap} people in total (you plus {maxDeps}). Remove
                        someone to add a different person, or ask your gym about a larger plan.
                      </p>
                    )}

                    <div className="flex items-start gap-3 rounded-md border border-zinc-950/10 bg-background p-3">
                      <Checkbox
                        id="payerConfirmed"
                        checked={form.payerConfirmed}
                        onCheckedChange={(v) => update("payerConfirmed", v === true)}
                      />
                      <Label htmlFor="payerConfirmed" className="text-xs font-normal leading-relaxed">
                        {/* The payer is the PARENT on the child path, never the
                            child whose name was entered at step 1. */}
                        I confirm{" "}
                        <strong>
                          {(familyPath ? form.guardianName.trim() : form.name) || "I"}
                        </strong>{" "}
                        {(familyPath ? form.guardianName.trim() : form.name) ? "is" : "am"} the
                        designated payer for this family. Only the designated payer is charged —
                        everyone else in this family is covered by this one payment and is never
                        billed separately.
                      </Label>
                    </div>

                    {/* The child named at step 1 is already part of this family
                        — show them as such, or the parent enters them twice and
                        the gym gets two records for one kid. */}
                    {familyPath && form.name.trim().length >= 2 && (
                      <div className="flex items-center justify-between gap-2 rounded-md border border-zinc-950/10 bg-background p-3 text-sm">
                        <span>
                          <strong>{form.name.trim()}</strong>
                          <span className="text-muted-foreground"> · added at the first step</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => setStep("info")}
                          className="text-xs font-semibold underline"
                        >
                          Change
                        </button>
                      </div>
                    )}

                    {form.familyMembers.length === 0 && !familyPath ? (
                      <div className="rounded-md border border-dashed border-zinc-950/10 bg-card/40 p-3 text-center text-xs text-muted-foreground">
                        Add at least one family member to continue.
                      </div>
                    ) : (
                      <ul className="space-y-3">
                        {form.familyMembers.map((fm, idx) => (
                          <li key={idx} className="grid gap-2 rounded-md border border-zinc-950/10 bg-background p-3 sm:grid-cols-4">
                            <Input
                              placeholder="Full name"
                              value={fm.name}
                              onChange={(e) => {
                                const next = [...form.familyMembers];
                                next[idx] = { ...fm, name: e.target.value };
                                update("familyMembers", next);
                              }}
                            />
                            {/* Required: most people added to a family plan are
                                children, and a missing date of birth files them
                                as adults with no guardian and no minor waiver. */}
                            <div className="space-y-1">
                              <Input
                                type="date"
                                aria-label={`Date of birth for ${fm.name || "family member"}`}
                                value={fm.dateOfBirth}
                                onChange={(e) => {
                                  const next = [...form.familyMembers];
                                  next[idx] = { ...fm, dateOfBirth: e.target.value };
                                  update("familyMembers", next);
                                }}
                              />
                              {isUnder18(fm.dateOfBirth || null) && (
                                <p className="text-[11px] text-muted-foreground">
                                  Under 18 — you sign for them
                                </p>
                              )}
                            </div>
                            <Input
                              placeholder="Email (optional)"
                              value={fm.email}
                              onChange={(e) => {
                                const next = [...form.familyMembers];
                                next[idx] = { ...fm, email: e.target.value };
                                update("familyMembers", next);
                              }}
                            />
                            <div className="flex items-center gap-2">
                              <Input
                                placeholder="Phone (optional)"
                                value={fm.phone}
                                onChange={(e) => {
                                  const next = [...form.familyMembers];
                                  next[idx] = { ...fm, phone: e.target.value };
                                  update("familyMembers", next);
                                }}
                              />
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  const next = form.familyMembers.filter((_, i) => i !== idx);
                                  update("familyMembers", next);
                                }}
                              >
                                Remove
                              </Button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })()}

              {(() => {
                const p = plans.find((pl) => pl.id === form.selectedPlanId);
                const isPaid = p && p.price_cents > 0;
                if (isPaid && signupFreeDays > 0) {
                  const passFee = !!(dojo as { pass_platform_fee_to_members?: boolean | null })
                    .pass_platform_fee_to_members;
                  const amount = (grossChargeCents(p!.price_cents, passFee) / 100).toLocaleString(
                    undefined,
                    { style: "currency", currency: p!.currency || "EUR" },
                  );
                  return (
                    <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-100 p-4 text-sm text-amber-900">
                      <CreditCard className="mt-0.5 size-4 flex-none" />
                      <div>
                        <div className="font-semibold">
                          Your first {signupFreeDays} days are free
                        </div>
                        <div className="mt-1 text-amber-800/80">
                          Train as much as you like for {signupFreeDays} days — no class limits.
                          You'll enter your card at secure checkout now, but nothing is taken
                          today. Your free period runs until {freePeriodEndsOn}, when your first
                          payment of {amount} is taken, and you can cancel before then from your
                          member area.
                        </div>

                      </div>
                    </div>
                  );
                }
                return (
                  <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-100 p-4 text-sm text-amber-900">
                    <CreditCard className="mt-0.5 size-4 flex-none" />
                    <div>
                      <div className="font-semibold">Payment details</div>
                      <div className="mt-1 text-amber-800/80">
                        {isPaid
                          ? `You'll be redirected to secure checkout after signing the waiver. ${billingTimingSentence(
                              {
                                mode: billingModeOf(dojo),
                                billingDayOfMonth: (dojo as { billing_day_of_month?: number | null })
                                  .billing_day_of_month ?? null,
                                interval: p?.interval ?? "month",
                                // A gym that offers a trial gives it to plan
                                // pickers too: nothing is taken today.
                                onTrial: trialOfferedHere && p?.interval !== "one_time",
                              },
                            )}`
                          : "Your gym will confirm payment details with you after signup. No card is required right now."}
                      </div>
                    </div>
                  </div>
                );
              })()}

              <div className="flex justify-between pt-2">
                <Button variant="ghost" onClick={() => setStep("info")}>
                  <ArrowLeft className="mr-2 size-4" />
                  Back
                </Button>
                <Button
                  className="bg-brand text-brand-foreground hover:bg-brand/90"
                  disabled={
                    (plans.find((pl) => pl.id === form.selectedPlanId)?.plan_type ===
                      "family" &&
                      (!form.payerConfirmed ||
                        // Every dependent needs a date of birth, or they are
                        // filed as adults with no guardian and no minor waiver.
                        form.familyMembers.some(
                          (fm) =>
                            fm.name.trim().length >= 2 && !fm.dateOfBirth.trim(),
                        ))) ||
                    // Force an explicit choice rather than letting someone fall
                    // through the plan step without picking anything.
                    (!form.selectedPlanId && !(trialChosen && trialAllowance > 0))
                  }
                  onClick={() => setStep("waiver")}
                >
                  Continue
                  <ArrowRight className="ml-2 size-4" />
                </Button>
              </div>
            </div>
          )}

          {step === "waiver" && (
            <div className="space-y-8">
              {/* Section A — Waiver (adult, or minor signed by a guardian) */}
              <section className="space-y-5">
                <div>
                  <h2 className="text-lg font-semibold">
                    {signerIsGuardian || signingForChildren
                      ? "Parent or guardian waiver"
                      : "Sign the waiver"}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {signerIsGuardian
                      ? "This member is under 18, so a parent or guardian must read and agree to the waiver on their behalf."
                      : signingForChildren
                        ? `You're signing on behalf of ${familyChildNames.length === 1 ? "your child" : "your children"}, so this waiver covers ${familyChildNames.join(", ")}.`
                        : "Please read and agree to the training waiver before submitting."}
                  </p>
                </div>

                {/* Guardian details are collected at step 1. Repeated here as a
                    read-only summary so the person signing can see exactly who
                    they are signing as before they commit. */}
                {signerIsGuardian && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
                    <h3 className="text-sm font-semibold">Signing as</h3>
                    <p className="mt-1 text-muted-foreground">
                      {form.guardianName.trim() || "Parent or guardian"}
                      {form.guardianRelationship ? ` (${form.guardianRelationship})` : ""} ·{" "}
                      {effectiveGuardianEmail || "no email given"}
                      {form.guardianPhone.trim() ? ` · ${form.guardianPhone.trim()}` : ""}
                    </p>
                    <button
                      type="button"
                      onClick={() => setStep("info")}
                      className="mt-2 text-xs font-semibold underline"
                    >
                      Change
                    </button>
                  </div>
                )}

                <div className="rounded-lg border border-zinc-950/10 bg-surface p-4">
                  <h3 className="text-sm font-semibold">{waiver.title}</h3>
                  <div className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap text-sm text-muted-foreground">
                    {waiver.body_markdown}
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <Checkbox
                    id="waiverAgreed"
                    checked={form.waiverAgreed}
                    onCheckedChange={(v) => update("waiverAgreed", Boolean(v))}
                    className="mt-0.5"
                  />
                  <Label htmlFor="waiverAgreed" className="text-sm font-normal leading-snug">
                    {signerIsGuardian
                      ? `I am the parent or legal guardian of ${form.name.trim() || "this member"}, and I have read and agree to this waiver on their behalf.`
                      : signingForChildren
                        ? `I am the parent or legal guardian of ${familyChildNames.join(", ")}, and I have read and agree to this waiver on their behalf${form.guardianTrains ? " and for myself" : ""}.`
                        : "I have read and agree to this waiver."}
                  </Label>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="signedName">
                    {signerIsGuardian
                      ? "Parent/guardian signature (type your full name)"
                      : "Signature (type your full name)"}
                  </Label>
                  <Input
                    id="signedName"
                    value={form.signedName}
                    onChange={(e) => update("signedName", e.target.value)}
                    placeholder="Type your full legal name"
                  />
                </div>


                <div className="flex items-start gap-3 rounded-lg border border-zinc-950/10 bg-surface p-4 text-sm text-muted-foreground">
                  <Shield className="mt-0.5 size-4 flex-none text-brand" />
                  <div>
                    Your information is stored securely and only shared with{" "}
                    {dojo.name}. By signing up you agree to receive communications
                    about your membership.
                  </div>
                </div>
              </section>

              {/* Section B — Gym terms & conditions (only when the gym has set them) */}
              {terms && (
                <section className="space-y-5 border-t border-border pt-6">
                  <div>
                    <h2 className="text-lg font-semibold">{terms.title}</h2>
                    <p className="text-sm text-muted-foreground">
                      {dojo.name}'s membership terms — cancellation notice, etiquette, and gym rules.
                    </p>
                  </div>

                  <div className="rounded-lg border border-zinc-950/10 bg-surface p-4">
                    <div className="max-h-64 overflow-y-auto whitespace-pre-wrap text-sm text-muted-foreground">
                      {terms.body_markdown}
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="termsAgreed"
                      checked={form.termsAgreed}
                      onCheckedChange={(v) => update("termsAgreed", Boolean(v))}
                      className="mt-0.5"
                    />
                    <Label htmlFor="termsAgreed" className="text-sm font-normal leading-snug">
                      I have read and agree to these terms &amp; conditions.
                    </Label>
                  </div>
                </section>
              )}

              {/* Section C — Data transparency (information only, never a consent box) */}
              <section className="border-t border-border pt-6">
                <div className="flex items-start gap-3 rounded-lg border border-brand/30 bg-brand/5 p-4">
                  <Info className="mt-0.5 size-4 flex-none text-brand" />
                  {privacyPublished ? (
                    <p className="text-sm">
                      <span className="font-semibold">How your data is used — </span>
                      <a
                        href={`/j/${slug}/privacy`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-brand-strong underline underline-offset-2"
                      >
                        read {dojo.name}'s privacy notice
                      </a>
                      <span className="text-muted-foreground">
                        {" "}(opens in a new tab). {dojo.name} is responsible for your member
                        information. This is for your information — there is nothing to agree to
                        here.
                      </span>
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      <span className="font-semibold text-foreground">How your data is used — </span>
                      {dojo.name} is responsible for your member information and uses Sthenos to run
                      its membership.{" "}
                      {privacyContactEmail ? (
                        <>
                          For any question about your data, or to ask for a copy of it, contact{" "}
                          <a
                            href={`mailto:${privacyContactEmail}`}
                            className="font-medium text-brand-strong underline underline-offset-2"
                          >
                            {privacyContactEmail}
                          </a>
                          .
                        </>
                      ) : (
                        <>For any question about your data, contact {dojo.name} directly.</>
                      )}{" "}
                      There is nothing to agree to here.
                    </p>
                  )}
                </div>
              </section>

              {/* Section D — Optional media consent */}
              {collectMediaConsent && (
                <section className="space-y-3 border-t border-border pt-6">
                  <div>
                    <h2 className="text-lg font-semibold">Photos and video (optional)</h2>
                    {signerIsGuardian && (
                      <p className="mt-1 text-xs font-medium text-amber-600">
                        This member is under 18 — the parent or guardian named above gives this
                        consent on their behalf, and can withdraw it at any time.
                      </p>
                    )}
                  </div>
                  <div className="flex items-start gap-3 rounded-lg border border-zinc-950/10 bg-surface p-4">
                    <Checkbox
                      id="mediaConsent"
                      checked={form.mediaConsent}
                      onCheckedChange={(v) => update("mediaConsent", Boolean(v))}
                      className="mt-0.5"
                    />
                    <Label htmlFor="mediaConsent" className="text-sm font-normal leading-snug">
                      {mediaConsentLabel(dojo.name, minor)}
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {MEDIA_CONSENT_HINT}
                      </span>
                    </Label>
                  </div>
                </section>
              )}



              {/* Section B — Book first class */}
              <section className="space-y-4 border-t border-border pt-6">
                <div>
                  <h2 className="text-lg font-semibold">Book your first class</h2>
                  <p className="text-sm text-muted-foreground">
                    Pick a class scheduled for today. Optional — you can always book later.
                  </p>
                </div>

                {todayClasses.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-zinc-950/10 bg-card/40 p-6 text-center text-sm text-muted-foreground">
                    No classes today — you can book from your portal once your account is confirmed.
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {todayClasses.map((c) => {
                      const selected = form.selectedClassId === c.id;
                      const full = c.spots_left === 0;
                      return (
                        <li key={c.id}>
                          <button
                            type="button"
                            disabled={full}
                            onClick={() =>
                              update("selectedClassId", selected ? null : c.id)
                            }
                            className={`flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left transition-colors ${
                              selected
                                ? "border-brand bg-brand/5 ring-1 ring-brand/40"
                                : "border-zinc-950/10 bg-background hover:bg-accent"
                            } ${full ? "cursor-not-allowed opacity-50" : ""}`}
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 text-sm font-semibold">
                                <Calendar className="size-4 text-muted-foreground" />
                                {c.name}
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                <span className="inline-flex items-center gap-1">
                                  <Clock className="size-3" />
                                  {formatTime(c.start_time)} – {formatTime(c.end_time)}
                                </span>
                                {c.instructor && <span>Coach: {c.instructor}</span>}
                                <span className="inline-flex items-center gap-1">
                                  <Users className="size-3" />
                                  {c.spots_left == null
                                    ? "Open"
                                    : `${c.spots_left} spot${c.spots_left === 1 ? "" : "s"} left`}
                                </span>
                              </div>
                            </div>
                            {selected && <Check className="size-4 flex-none text-brand" />}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {form.selectedClassId && (
                  <button
                    type="button"
                    onClick={() => update("selectedClassId", null)}
                    className="text-xs text-muted-foreground underline hover:text-foreground"
                  >
                    Skip, I'll book later
                  </button>
                )}
              </section>

              <TurnstileWidget onToken={setTurnstileToken} />

              <div className="flex justify-between pt-2">
                <Button variant="ghost" onClick={() => setStep("plan")}>
                  <ArrowLeft className="mr-2 size-4" />
                  Back
                </Button>
                <Button
                  className="bg-brand text-brand-foreground hover:bg-brand/90"
                  disabled={!canSubmitWaiver || submitMut.isPending}
                  onClick={() => submitMut.mutate()}
                >
                  {submitMut.isPending ? (
                    <>Submitting…</>
                  ) : (
                    <>
                      Complete signup
                      <Check className="ml-2 size-4" />
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}

          {step === "success" && (
            <div className="space-y-5 text-center">
              <div className="mx-auto grid size-14 place-items-center rounded-full bg-emerald-50 text-emerald-600 ring-1 ring-emerald-500/20">
                <Check className="size-7" />
              </div>
              <div>
                <h2 className="text-xl font-semibold">Welcome to {dojo.name}!</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  Your account is ready. Check your portal for attendance and progress tracking.
                </p>
                {form.familyMembers.length > 0 && (
                  <p className="mx-auto mt-3 max-w-sm rounded-md bg-surface px-3 py-2 text-xs text-muted-foreground ring-1 ring-inset ring-black/5">
                    <strong>Payer: {form.name}</strong> — you are the designated payer for this
                    family. {form.familyMembers.length}{" "}
                    {form.familyMembers.length === 1 ? "member is" : "members are"} covered by your
                    family plan and will never be charged separately.
                  </p>
                )}

              </div>
              <div className="flex flex-col items-center gap-2">
                <Button asChild className="bg-brand text-brand-foreground hover:bg-brand/90">
                  <Link to="/portal">Go to my portal</Link>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => router.navigate({ to: "/" })}
                >
                  Back to Sthenos home
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StepDot({
  active,
  done,
  label,
}: {
  active: boolean;
  done: boolean;
  label: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className={`grid size-8 place-items-center rounded-full text-xs font-semibold transition-colors ${
          done
            ? "bg-brand text-brand-foreground"
            : active
              ? "bg-brand/10 text-brand ring-1 ring-brand/30"
              : "bg-muted text-muted-foreground"
        }`}
      >
        {done ? <Check className="size-4" /> : label.charAt(0)}
      </div>
      <span
        className={`text-[10px] font-medium uppercase tracking-wider ${
          active || done ? "text-foreground" : "text-muted-foreground"
        }`}
      >
        {label}
      </span>
    </div>
  );
}

function StepLine({ done }: { done: boolean }) {
  return (
    <div className="relative top-[-10px] h-px w-10">
      <div
        className={`h-full transition-colors ${
          done ? "bg-brand/40" : "bg-border"
        }`}
      />
    </div>
  );
}
