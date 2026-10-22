import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { setMembersPaymentMethod } from "@/lib/cash-payments.functions";

/**
 * Switches members between card and cash. If any of them still has a live
 * Stripe subscription we stop and ask for explicit confirmation first — we
 * never cancel billing implicitly.
 */
export function useSetPaymentMethod(dojoId: string | null) {
  const qc = useQueryClient();
  const setMethod = useServerFn(setMembersPaymentMethod);
  const [pending, setPending] = useState<{
    memberIds: string[];
    method: "card" | "cash";
    names: string[];
  } | null>(null);
  const [familyPending, setFamilyPending] = useState<{
    memberIds: string[];
    method: "card" | "cash";
    families: {
      id: string;
      name: string;
      coveredNames: string[];
      totalCents: number;
      currency: string;
      interval: string;
      liveSubscriptions: number;
      hasSavedCard: boolean;
    }[];
  } | null>(null);

  const mutation = useMutation({
    mutationFn: (vars: {
      memberIds: string[];
      method: "card" | "cash";
      confirmKeepSubscription?: boolean;
      confirmFamilyChange?: boolean;
    }) =>
      setMethod({
        data: {
          dojoId: dojoId!,
          memberIds: vars.memberIds,
          method: vars.method,
          confirmKeepSubscription: vars.confirmKeepSubscription ?? false,
          confirmFamilyChange: vars.confirmFamilyChange ?? false,
        },
      }),
    onSuccess: (res, vars) => {
      if (res.needsFamilyConfirm.length > 0) {
        setFamilyPending({
          memberIds: vars.memberIds,
          method: vars.method,
          families: res.needsFamilyConfirm,
        });
        return;
      }
      if (res.needsConfirm.length > 0) {
        setPending({
          memberIds: vars.memberIds,
          method: vars.method,
          names: res.needsConfirm.map((m) => m.name),
        });
        return;
      }
      setPending(null);
      setFamilyPending(null);
      if (res.familyNeedsCheckout.length > 0) {
        toast.warning(
          `${res.familyNeedsCheckout.join(", ")} now pays by card, but there is no saved card yet — send a payment link to start the family subscription.`,
        );
      }
      toast.success(
        vars.method === "cash"
          ? `${res.updated} ${res.updated === 1 ? "member" : "members"} now tracked as cash payers`
          : `${res.updated} ${res.updated === 1 ? "member" : "members"} set back to card`,
      );
      qc.invalidateQueries({ queryKey: ["members"] });
      qc.invalidateQueries({ queryKey: ["member-detail"] });
      qc.invalidateQueries({ queryKey: ["cash-dues"] });
      qc.invalidateQueries({ queryKey: ["cash-paid-state"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not change payment method"),
  });

  const dialog = (
    <AlertDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Card billing is still active</AlertDialogTitle>
          <AlertDialogDescription>
            {pending?.names.join(", ")} {pending && pending.names.length === 1 ? "has" : "have"} a
            live card subscription. Switching to cash only changes how Sthenos tracks payment — the
            existing subscription keeps charging until you end it from the member's membership
            actions. Continue?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={mutation.isPending}
            onClick={() =>
              pending &&
              mutation.mutate({
                memberIds: pending.memberIds,
                method: pending.method,
                confirmKeepSubscription: true,
              })
            }
          >
            {mutation.isPending ? "Saving…" : "Switch to cash anyway"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  const money = (cents: number, currency: string) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: (currency || "usd").toUpperCase(),
    }).format(cents / 100);

  const familyDialog = (
    <AlertDialog open={!!familyPending} onOpenChange={(o) => !o && setFamilyPending(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            This changes the whole family&apos;s payment arrangement
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm">
              {familyPending?.families.map((f) => (
                <div key={f.id} className="space-y-1">
                  <p className="font-medium text-foreground">
                    {f.name} pays for {f.coveredNames.length + 1}{" "}
                    {f.coveredNames.length + 1 === 1 ? "member" : "members"}
                  </p>
                  {familyPending.method === "cash" ? (
                    <p>
                      {f.liveSubscriptions > 0
                        ? `${f.name}'s card subscription will be cancelled. `
                        : ""}
                      From now on {f.name} is expected to pay{" "}
                      <strong>{money(f.totalCents, f.currency)}</strong> per {f.interval} in cash
                      for the whole family.
                      {f.coveredNames.length > 0 && (
                        <>
                          {" "}
                          {f.coveredNames.join(", ")} stay covered and are never chased
                          individually.
                        </>
                      )}
                    </p>
                  ) : (
                    <p>
                      {f.hasSavedCard
                        ? `A card subscription for ${money(f.totalCents, f.currency)} per ${f.interval} will start on ${f.name}'s saved card.`
                        : `${f.name} has no saved card yet, so you'll need to send a payment link to start the ${money(f.totalCents, f.currency)} per ${f.interval} family subscription.`}
                      {f.coveredNames.length > 0 && (
                        <>
                          {" "}
                          {f.coveredNames.join(", ")} will be covered by that card and will no
                          longer be expected to pay cash.
                        </>
                      )}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={mutation.isPending}
            onClick={() =>
              familyPending &&
              mutation.mutate({
                memberIds: familyPending.memberIds,
                method: familyPending.method,
                confirmKeepSubscription: true,
                confirmFamilyChange: true,
              })
            }
          >
            {mutation.isPending
              ? "Saving…"
              : familyPending?.method === "cash"
                ? "Switch family to cash"
                : "Switch family to card"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return {
    setPaymentMethod: (memberIds: string[], method: "card" | "cash") =>
      mutation.mutate({ memberIds, method }),
    isPending: mutation.isPending,
    dialog: (
      <>
        {dialog}
        {familyDialog}
      </>
    ),
  };
}
