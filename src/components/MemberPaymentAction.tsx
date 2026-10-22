import { useState } from "react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  createBillingPortalSession,
  createCheckoutSession,
} from "@/lib/payments.functions";
import { getMemberBilling } from "@/lib/my-members.functions";
import { grossChargeCents } from "@/lib/platform-fee";

export type MemberBillingState = {
  memberId: string;
  planId: string | null;
  planName: string | null;
  planPriceCents: number | null;
  planCurrency: string | null;
  planInterval: string | null;
  subscription: {
    id: string;
    status: string;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
  } | null;
  hasActiveSubscription: boolean;
  hasBillingAccount: boolean;
  /** Gym passes the platform fee on to members at checkout. */
  passPlatformFee: boolean;
  /**
   * The amount Stripe will ACTUALLY charge on the next renewal — plan price plus
   * the platform fee when pass-through is on. Always prefer this over
   * `planPriceCents` for any future/payable amount shown to a person.
   */
  nextChargeCents: number | null;
};

/**
 * Single source of truth for a member's billing state, scoped by dojo_id.
 * "Payment set up" == an active/trialing Stripe subscription (or an existing
 * Stripe customer with a subscription record) — never merely-active membership.
 */
export function useMemberBilling(memberId?: string | null, dojoId?: string | null) {
  // Server-side, because a parent reading their child's billing gets nothing
  // back on their own client: the members policy shows them only their own row.
  const load = useServerFn(getMemberBilling);
  return useQuery({
    queryKey: ["member-billing", dojoId, memberId],
    enabled: !!memberId && !!dojoId,
    queryFn: async (): Promise<MemberBillingState> => {
      const res: any = await load({ data: { dojoId: dojoId!, memberId: memberId! } });
      return {
        memberId: res.memberId,
        planId: res.planId,
        planName: res.planName,
        planPriceCents: res.planPriceCents,
        planCurrency: res.planCurrency,
        planInterval: res.planInterval,
        subscription: res.subscription,
        hasActiveSubscription: res.hasActiveSubscription,
        hasBillingAccount: res.hasBillingAccount,
        passPlatformFee: res.passPlatformFee,
        nextChargeCents:
          res.planBasePriceCents == null
            ? null
            : grossChargeCents(res.planBasePriceCents, res.passPlatformFee),
      };
    },
  });
}

export function MemberPaymentAction({
  memberId,
  dojoId,
  billing,
  returnPath = "/billing",
  size = "sm",
  variant = "outline",
  className,
}: {
  memberId?: string | null;
  dojoId?: string | null;
  billing?: MemberBillingState | null;
  returnPath?: string;
  size?: "sm" | "default";
  variant?: "outline" | "default";
  className?: string;
}) {
  const [loading, setLoading] = useState(false);
  const portalFn = useServerFn(createBillingPortalSession);
  const checkoutFn = useServerFn(createCheckoutSession);

  const hasAccount = !!billing?.hasBillingAccount;
  const label = hasAccount ? "Update payment method" : "Set up payment";

  const go = (url: string) => {
    if (typeof window !== "undefined") {
      (window.top ?? window).location.href = url;
    }
  };

  const onClick = async () => {
    if (!memberId || !dojoId) {
      toast.error("We couldn't find your member record for this gym.");
      return;
    }
    setLoading(true);
    try {
      if (hasAccount) {
        const res = await portalFn({ data: { memberId, dojoId, returnPath } });
        if (!res?.url) {
          toast.error(res?.error ?? "Payment isn't set up yet for your account.");
          return;
        }
        go(res.url);
        return;
      }

      if (!billing?.planId) {
        toast.error("No plan assigned yet — ask your gym to assign a membership plan.");
        return;
      }
      const res = await checkoutFn({
        data: { memberId, dojoId, planId: billing.planId, returnPath },
      });
      if (!res?.url) {
        toast.error(res?.error ?? "Couldn't start checkout. Please try again.");
        return;
      }
      go(res.url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong opening Stripe.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button size={size} variant={variant} className={className} onClick={onClick} disabled={loading}>
      <CreditCard className="size-4" /> {loading ? "Opening…" : label}
    </Button>
  );
}
