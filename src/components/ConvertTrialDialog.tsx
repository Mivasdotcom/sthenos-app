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
import { convertTrialToActive, previewTrialConversion } from "@/lib/trial-convert.functions";

/**
 * Converting a trial member onto a paid plan adds them to their family total,
 * so the payer's amount can move. That is never silent: staff see the
 * before/after here, and the change lands at the payer's next renewal.
 */
export function ConvertTrialDialog({
  open,
  onOpenChange,
  dojoId,
  memberId,
  memberName,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  dojoId: string;
  memberId: string;
  memberName: string;
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const preview = useServerFn(previewTrialConversion);
  const convert = useServerFn(convertTrialToActive);

  const q = useQuery({
    queryKey: ["trial-conversion-preview", dojoId, memberId],
    queryFn: () => preview({ data: { dojoId, memberId } }),
    enabled: open,
  });

  const mut = useMutation({
    mutationFn: () => convert({ data: { dojoId, memberId } }),
    onSuccess: (res: any) => {
      toast.success(
        res?.payerNotified
          ? "Converted to a paid plan — the payer has been told about their new total"
          : "Converted to a paid plan",
      );
      qc.invalidateQueries({ queryKey: ["member-detail", memberId] });
      qc.invalidateQueries({ queryKey: ["members"] });
      qc.invalidateQueries({ queryKey: ["family-group"] });
      onOpenChange(false);
      onDone?.();
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not convert this member"),
  });

  const data = q.data as any;
  const before = data?.before ?? null;
  const after = data?.after ?? null;
  const effectiveDate = data?.effectiveAt
    ? new Date(data.effectiveAt).toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Move {memberName} onto a paid plan</DialogTitle>
          <DialogDescription>
            {before && after
              ? "They are on a free trial, so they are not in the family total yet. Starting a paid plan adds them."
              : "They will move from trial to active."}
          </DialogDescription>
        </DialogHeader>

        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Working out the family total…</p>
        ) : before && after ? (
          <div className="space-y-3">
            <div className="grid gap-2 rounded-lg bg-muted/50 p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {data.payer?.name ?? "Payer"} pays now
                </span>
                <span className="tabular-nums">
                  {formatMoney(before.totalCents, before.currency)}
                </span>
              </div>
              <div className="flex justify-between font-semibold">
                <span>
                  From {effectiveDate}
                  {" "}
                  <span className="font-normal text-muted-foreground">(next renewal)</span>
                </span>
                <span className="tabular-nums">
                  {formatMoney(after.totalCents, after.currency)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {before.size} counted member{before.size === 1 ? "" : "s"} at{" "}
                {trimPct(before.discountPercent)}% → {after.size} at{" "}
                {trimPct(after.discountPercent)}% family discount. {memberName} is the
                member being added.
              </p>
            </div>
            <FamilyPricingBreakdown quote={after} title="Family total after this change" />
            <p className="text-xs text-muted-foreground">
              Nothing is charged today. The new amount applies at{" "}
              {data.payer?.name ?? "the payer"}'s first payment on or after {effectiveDate},
              and they are notified now.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            This does not change anyone else's bill.
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending || q.isLoading}>
            {mut.isPending ? "Applying…" : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
