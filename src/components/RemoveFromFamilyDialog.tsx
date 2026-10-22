import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FamilyPricingBreakdown } from "@/components/FamilyPricingBreakdown";
import { formatMoney, trimPct } from "@/lib/family-pricing";
import {
  getFamilyQuote,
  removeMemberFromFamily,
} from "@/lib/family-pricing.functions";

function intervalWord(interval: string): string {
  if (interval === "year") return "year";
  if (interval === "one_time") return "one-off";
  return "month";
}

/**
 * "Remove from family" with its billing consequences shown before confirming:
 * new family size, new discount tier, and the new amount the payer is charged.
 */
export function RemoveFromFamilyDialog({
  dojoId,
  groupId,
  member,
  open,
  onOpenChange,
  onRemoved,
}: {
  dojoId: string;
  groupId: string;
  member: { id: string; name: string } | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onRemoved?: () => void;
}) {
  const qc = useQueryClient();
  const quoteFn = useServerFn(getFamilyQuote);
  const removeFn = useServerFn(removeMemberFromFamily);
  const [dissolve, setDissolve] = useState(false);
  const [ackIncrease, setAckIncrease] = useState(false);

  useEffect(() => {
    if (open) setDissolve(false);
  }, [open]);

  const quoteQ = useQuery({
    queryKey: ["family-quote", dojoId, groupId, "remove", member?.id],
    enabled: open && !!member,
    queryFn: () =>
      quoteFn({
        data: { dojoId, groupId, removeMemberIds: [member!.id] },
      }),
  });
  const quote = quoteQ.data;
  const current = quote?.current;
  const next = quote?.next;
  // A removal can INCREASE the payer's bill when the family drops a tier.
  const increasesBill = !!next && !!current && next.totalCents > current.totalCents;
  const isPayer = !!quote?.payer && quote.payer.id === member?.id;
  const leavesOne = (next?.size ?? 0) <= 1;

  const mutation = useMutation({
    mutationFn: () =>
      removeFn({
        data: {
          dojoId,
          groupId,
          memberId: member!.id,
          expectedTotalCents: next?.totalCents ?? 0,
          dissolveIfLastOne: dissolve,
        },
      }),
    onSuccess: (res: any) => {
      toast.success(
        `${res.removed.name} was removed from the family. They now have no payment arrangement — a task was created to set one up.`,
      );
      if (res.groupDissolved) toast.info("The family group was dissolved.");
      qc.invalidateQueries({ queryKey: ["family-quote"] });
      qc.invalidateQueries({ queryKey: ["family-overview"] });
      qc.invalidateQueries({ queryKey: ["family-groups"] });
      qc.invalidateQueries({ queryKey: ["member-detail"] });
      qc.invalidateQueries({ queryKey: ["members"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
      onOpenChange(false);
      onRemoved?.();
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not remove this member"),
  });

  const summary =
    current && next
      ? `Family drops from ${current.size} to ${next.size} member${next.size === 1 ? "" : "s"} · discount ${trimPct(current.discountPercent)}% → ${trimPct(next.discountPercent)}% · payer now charged ${formatMoney(next.totalCents, next.currency)}/${intervalWord(next.interval)} instead of ${formatMoney(current.totalCents, current.currency)}/${intervalWord(current.interval)}`
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!mutation.isPending) onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove {member?.name} from the family?</DialogTitle>
          <DialogDescription>
            {isPayer
              ? "This member is the family's designated payer."
              : "This changes what the payer is charged, so check the amounts below."}
          </DialogDescription>
        </DialogHeader>

        {isPayer ? (
          <p className="rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-500/30">
            {member?.name} is the designated payer, so removing them would leave this
            family with nobody paying. Change the payer to another family member first
            (or dissolve the family), then remove them.
          </p>
        ) : (
          <div className="space-y-3">
            {quoteQ.isLoading && (
              <p className="text-xs text-muted-foreground">Working out the new amounts…</p>
            )}
            {summary && (
              <p className="rounded-md bg-zinc-50 px-3 py-2 text-xs font-medium ring-1 ring-inset ring-zinc-950/5">
                {summary}
              </p>
            )}
            {current && current.size > 0 && (
              <FamilyPricingBreakdown quote={current} title="Before" compact />
            )}
            {next && <FamilyPricingBreakdown quote={next} title="After removal" />}
            {quote?.tierDropWarning && (
              <div
                className={
                  increasesBill
                    ? "rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs"
                    : "rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-500/30"
                }
              >
                <p className={increasesBill ? "font-semibold text-foreground" : ""}>
                  {quote.tierDropWarning}
                </p>
                {increasesBill && (
                  <label className="mt-2 flex items-center gap-2 font-medium">
                    <input
                      type="checkbox"
                      checked={ackIncrease}
                      onChange={(e) => setAckIncrease(e.target.checked)}
                    />
                    I understand the payer will pay more
                  </label>
                )}
              </div>
            )}

            {leavesOne && (
              <div className="space-y-2 rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-500/30">
                <p className="font-semibold">
                  Only one member would be left, so the family discount no longer applies.
                </p>
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    className="mt-0.5"
                    checked={!dissolve}
                    onChange={() => setDissolve(false)}
                  />
                  <span>
                    Keep the family group for future additions — the remaining member stays
                    in it and is charged their own plan price.
                  </span>
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    className="mt-0.5"
                    checked={dissolve}
                    onChange={() => setDissolve(true)}
                  />
                  <span>
                    Dissolve the family and move the remaining member onto their own
                    individual plan.
                  </span>
                </label>
              </div>
            )}

            <p className="text-[11px] text-muted-foreground">
              {member?.name} will be left with no payment arrangement and flagged as needing
              a plan, and a staff task is created so they never look like a paying member.
              The payer's subscription is updated with proration.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          {!isPayer && (
            <Button
              type="button"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={
                mutation.isPending ||
                quoteQ.isLoading ||
                !next ||
                (increasesBill && !ackIncrease)
              }
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? "Removing…" : "Remove from family"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
