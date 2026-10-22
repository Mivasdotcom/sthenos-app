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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { FamilyPricingBreakdown } from "@/components/FamilyPricingBreakdown";
import { formatMoney } from "@/lib/family-pricing";
import {
  getFamilyQuote,
  transferFamilyPayer,
} from "@/lib/family-pricing.functions";
import { listFamilyPayerCandidates } from "@/lib/family.functions";

function intervalWord(interval: string): string {
  if (interval === "year") return "year";
  if (interval === "one_time") return "one-off";
  return "month";
}

/**
 * "Change payer": pick any current family member, see exactly what happens to
 * billing, then hand the single family subscription over.
 */
export function ChangeFamilyPayerDialog({
  dojoId,
  groupId,
  open,
  onOpenChange,
  initialPayerId,
}: {
  dojoId: string;
  groupId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initialPayerId?: string | null;
}) {
  const qc = useQueryClient();
  const quoteFn = useServerFn(getFamilyQuote);
  const candidatesFn = useServerFn(listFamilyPayerCandidates);
  const transferFn = useServerFn(transferFamilyPayer);
  const [newPayerId, setNewPayerId] = useState("");

  useEffect(() => {
    if (open) setNewPayerId(initialPayerId ?? "");
  }, [open, initialPayerId]);

  const quoteQ = useQuery({
    queryKey: ["family-quote", dojoId, groupId],
    enabled: open,
    queryFn: () => quoteFn({ data: { dojoId, groupId } }),
  });
  const candidatesQ = useQuery({
    queryKey: ["family-payer-candidates", dojoId, groupId],
    enabled: open,
    queryFn: () => candidatesFn({ data: { dojoId, groupId } }),
  });

  const quote = quoteQ.data?.current;
  const currentPayer = quoteQ.data?.payer ?? null;
  const candidates = candidatesQ.data?.candidates ?? [];
  const chosen = candidates.find((c) => c.id === newPayerId) ?? null;
  const isSame = !!currentPayer && currentPayer.id === newPayerId;

  const mutation = useMutation({
    mutationFn: () =>
      transferFn({
        data: {
          dojoId,
          groupId,
          newPayerId,
          expectedTotalCents: quote?.totalCents,
        },
      }),
    onSuccess: (res: any) => {
      toast.success(
        res.needsCheckout
          ? `${res.newPayer.name} is now the designated payer. They have no saved card — send them the payment link to start billing.`
          : `${res.newPayer.name} is now the designated payer and is charged the family total.`,
      );
      qc.invalidateQueries({ queryKey: ["family-quote"] });
      qc.invalidateQueries({ queryKey: ["family-overview"] });
      qc.invalidateQueries({ queryKey: ["family-payer-candidates"] });
      qc.invalidateQueries({ queryKey: ["member-detail"] });
      qc.invalidateQueries({ queryKey: ["members"] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not change the payer"),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!mutation.isPending) onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change the family payer</DialogTitle>
          <DialogDescription>
            {currentPayer
              ? `${currentPayer.name} is currently the only member billed for this family.`
              : "Nobody is being billed for this family yet."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>New payer</Label>
            <Select value={newPayerId} onValueChange={setNewPayerId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a family member…" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                    {c.planName ? ` · ${c.planName}` : " · no plan"}
                    {c.isCurrentPayer ? " · current payer" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {quote && <FamilyPricingBreakdown quote={quote} title="Family total" />}

          {chosen && !isSame && (
            <div className="space-y-2 rounded-md bg-zinc-50 px-3 py-2 text-xs ring-1 ring-inset ring-zinc-950/5">
              <p className="font-medium">
                {currentPayer
                  ? `${currentPayer.name}'s subscription will be cancelled and a new subscription created for ${chosen.name}`
                  : `A new subscription will be created for ${chosen.name}`}
                {quote
                  ? ` for the same discounted total of ${formatMoney(quote.totalCents, quote.currency)}/${intervalWord(quote.interval)}, prorated.`
                  : "."}
              </p>
              <p className="text-muted-foreground">
                Everyone else in the family stays covered and is never charged. If Stripe
                refuses either step, nothing is changed — the family is never left with two
                subscriptions or none.
              </p>
            </div>
          )}

          {isSame && (
            <p className="text-xs text-muted-foreground">
              That member is already the designated payer.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={mutation.isPending || !newPayerId || isSame}
            onClick={() => mutation.mutate()}
            className="bg-brand text-brand-foreground hover:bg-brand/90"
          >
            {mutation.isPending ? "Changing payer…" : "Confirm and change payer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
