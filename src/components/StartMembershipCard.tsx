import { useState } from "react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PlanPicker } from "@/components/PlanPicker";
import { PLATFORM_FEE_PERCENT } from "@/lib/platform-fee";
import { getMyPlanOptions, selectMyPlan } from "@/lib/member-plans.functions";
import { createCheckoutSession } from "@/lib/payments.functions";
import { billingTimingSentence } from "@/lib/billing-copy";

/**
 * "Start your membership" — shown to a member who has no plan yet (typically a
 * public signup that skipped plan selection). Without this the only route to
 * payment was a staff member manually sending a link.
 *
 * Deliberately NOT shown to members who already have a plan or an active
 * subscription: changing plan is a price change and stays with the gym.
 */
export function StartMembershipCard({
  dojoId,
  returnPath = "/portal",
  showCoverage = false,
}: {
  dojoId: string;
  returnPath?: string;
  showCoverage?: boolean;
}) {
  const optionsFn = useServerFn(getMyPlanOptions);
  const selectFn = useServerFn(selectMyPlan);
  const checkoutFn = useServerFn(createCheckoutSession);
  const [planId, setPlanId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const { data } = useQuery({
    queryKey: ["my-plan-options", dojoId],
    enabled: !!dojoId,
    queryFn: () => optionsFn({ data: { dojoId } }),
  });

  if (!data?.memberId) return null;

  if (data.coveredBy) {
    if (!showCoverage) return null;
    return (
      <section className="rounded-xl bg-violet-50 p-5 ring-1 ring-violet-500/20">
        <h2 className="font-display text-base font-medium text-violet-900">
          You're covered by a family plan
        </h2>
        <p className="mt-1 text-sm text-violet-900/80">
          {data.coveredBy.name ? `${data.coveredBy.name} pays for your membership` : "Your family's payer covers your membership"}
          {data.coveredBy.planName ? ` (${data.coveredBy.planName})` : ""} — there's nothing to pay
          here.
        </p>
      </section>
    );
  }

  // Already paying, or paying cash at the dojo. A member who has a plan on
  // their record but NO live subscription still needs a way to pay — that is
  // exactly the staff-created member case, so we keep the card visible and
  // pre-select their assigned plan.
  if (data.hasActiveSubscription) return null;
  if (data.paymentMethod === "cash") return null;

  const preselected = planId ?? data.selectedPlanId ?? null;
  const hasAssignedPlan = !!data.selectedPlanId;

  const start = async () => {
    const chosen = preselected;
    if (!chosen) {
      toast.error("Choose a plan first");
      return;
    }
    setLoading(true);
    try {
      const sel = await selectFn({ data: { dojoId, planId: chosen } });
      if (!sel.ok || !sel.memberId) {
        toast.error(sel.error ?? "Couldn't select that plan");
        return;
      }
      const res = await checkoutFn({
        data: { memberId: sel.memberId, dojoId, planId: chosen, returnPath },
      });
      if (!res?.url) {
        toast.error(res?.error ?? "Couldn't start checkout. Please try again.");
        return;
      }
      (window.top ?? window).location.href = res.url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong opening checkout.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section
      id="start-membership"
      className="rounded-xl border border-brand/30 bg-brand/5 p-6 ring-1 ring-brand/10"
    >
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-brand" />
        <h2 className="font-display text-base font-medium">
          {hasAssignedPlan ? "Complete your membership" : "Start your membership"}
        </h2>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {hasAssignedPlan
          ? "Your gym has assigned you a plan, but payment isn't set up yet. Confirm your plan below to finish."
          : data.status === "trial"
            ? "You're on a trial. Choose a plan to become a full member."
            : "Choose a plan to activate your membership."}
      </p>
      {data.status === "trial" && (
        <p className="mt-2 text-sm text-muted-foreground">
          Nothing is due today. Your card or bank details are saved now, and your first
          payment is only taken once your free trial has finished — your trial starts at
          your first class, so it can never be charged before you've trained.
        </p>
      )}


      {data.plans.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Your gym hasn't published any plans yet — they'll be in touch.
        </p>
      ) : !data.onlinePaymentsEnabled ? (
        <div className="mt-4 space-y-3">
          <PlanPicker
            plans={data.plans}
            value={preselected}
            onChange={setPlanId}
            passPlatformFeeToMembers={data.passPlatformFee}
            platformFeePercent={PLATFORM_FEE_PERCENT}
          />
          <p className="text-sm text-muted-foreground">
            This gym doesn't take online payments yet — they'll arrange payment with you
            directly.
          </p>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <PlanPicker
            plans={data.plans}
            value={preselected}
            onChange={setPlanId}
            passPlatformFeeToMembers={data.passPlatformFee}
            platformFeePercent={PLATFORM_FEE_PERCENT}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={start} disabled={loading || !preselected}>
              {loading ? "Redirecting…" : hasAssignedPlan ? "Set up payment" : "Start membership"}
            </Button>
            <span className="text-xs text-muted-foreground">
              You'll be taken to a secure Stripe checkout.
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {billingTimingSentence({
              mode: data.billingMode,
              billingDayOfMonth: data.billingDayOfMonth,
              interval:
                data.plans.find((pl) => pl.id === preselected)?.interval ?? "month",
              onTrial: data.status === "trial",
            })}
          </p>
        </div>
      )}
    </section>
  );
}
