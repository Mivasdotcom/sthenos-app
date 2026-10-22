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
import { familyIncreaseWarning, formatMoney, trimPct } from "@/lib/family-pricing";
import { listFamilyGroups } from "@/lib/family.functions";
import {
  getFamilyMergePreview,
  mergeFamilyGroups,
} from "@/lib/family-pricing.functions";

function intervalWord(interval: string): string {
  if (interval === "year") return "year";
  if (interval === "one_time") return "one-off";
  return "month";
}

/**
 * Fold a duplicate family group into this one: choose the other group, choose
 * which payer survives, then confirm the before/after size, tier and amount.
 */
export function MergeFamiliesDialog({
  dojoId,
  groupId,
  groupName,
  open,
  onOpenChange,
  presetOtherGroupId,
}: {
  dojoId: string;
  groupId: string;
  groupName: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  presetOtherGroupId?: string | null;
}) {
  const qc = useQueryClient();
  const listGroupsFn = useServerFn(listFamilyGroups);
  const previewFn = useServerFn(getFamilyMergePreview);
  const mergeFn = useServerFn(mergeFamilyGroups);

  const [otherId, setOtherId] = useState<string>("");
  const [ackIncrease, setAckIncrease] = useState(false);
  const [payerId, setPayerId] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    setOtherId(presetOtherGroupId ?? "");
    setPayerId("");
  }, [open, presetOtherGroupId]);

  const groupsQ = useQuery({
    queryKey: ["family-groups", dojoId],
    enabled: open,
    queryFn: () => listGroupsFn({ data: { dojoId } }),
  });
  const others = (groupsQ.data?.groups ?? []).filter((g) => g.id !== groupId);

  const previewQ = useQuery({
    queryKey: ["family-merge-preview", dojoId, groupId, otherId, payerId],
    enabled: open && !!otherId,
    queryFn: () =>
      previewFn({
        data: {
          dojoId,
          groupIds: [groupId, otherId],
          survivingPayerId: payerId || null,
        },
      }),
  });
  const preview = previewQ.data;

  useEffect(() => {
    if (!preview || payerId) return;
    const suggested =
      preview.candidates.find((c) => c.isPayer && c.groupId === groupId) ??
      preview.candidates.find((c) => c.isPayer) ??
      preview.candidates[0];
    if (suggested) setPayerId(suggested.id);
  }, [preview, payerId, groupId]);

  const mergeMut = useMutation({
    mutationFn: () =>
      mergeFn({
        data: {
          dojoId,
          targetGroupId: groupId,
          sourceGroupId: otherId,
          survivingPayerId: payerId,
          expectedTotalCents: preview!.merged.totalCents,
        },
      }),
    onSuccess: (res: any) => {
      toast.success(
        `Families merged — ${res.survivingPayer.name} now pays ${formatMoney(
          res.totalCents,
          preview!.merged.currency,
        )} for ${res.size} members (${trimPct(res.discountPercent)}% family discount).`,
      );
      if (res.canceledSubscriptions > 0) {
        toast.info("The other payer's subscription was cancelled.");
      }
      qc.invalidateQueries({ queryKey: ["family-groups"] });
      qc.invalidateQueries({ queryKey: ["family-overview"] });
      qc.invalidateQueries({ queryKey: ["family-quote"] });
      qc.invalidateQueries({ queryKey: ["family-coverage"] });
      qc.invalidateQueries({ queryKey: ["member-detail"] });
      qc.invalidateQueries({ queryKey: ["members"] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not merge these families"),
  });

  const thisGroup = preview?.groups.find((g) => g.id === groupId) ?? null;
  const otherGroup = preview?.groups.find((g) => g.id === otherId) ?? null;
  const survivor = preview?.candidates.find((c) => c.id === payerId) ?? null;
  // The surviving payer's group before the merge, so an increase is visible.
  const survivorGroupBefore =
    preview?.groups.find((g) => g.payer?.id === payerId) ?? null;
  const mergeIncrease =
    preview && survivorGroupBefore
      ? familyIncreaseWarning(survivorGroupBefore.quote, preview.merged)
      : null;
  const summary =
    preview && thisGroup && otherGroup
      ? `${thisGroup.size} + ${otherGroup.size} members → ${preview.merged.size} members · discount ${trimPct(
          thisGroup.quote.discountPercent,
        )}% → ${trimPct(preview.merged.discountPercent)}% · payer charged ${formatMoney(
          preview.merged.totalCents,
          preview.merged.currency,
        )}/${intervalWord(preview.merged.interval)}`
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!mergeMut.isPending) onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Merge families</DialogTitle>
          <DialogDescription>
            Everyone moves into {groupName ?? "this family"}. One payer survives and is
            charged the recalculated family total; the other family's subscription is
            cancelled.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Family to merge in</Label>
            <Select value={otherId} onValueChange={setOtherId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose the other family group…" />
              </SelectTrigger>
              <SelectContent>
                {others.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                    {g.member_count
                      ? ` · ${g.member_count} ${g.member_count === 1 ? "member" : "members"}`
                      : " · empty"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {previewQ.isLoading && otherId && (
            <p className="text-xs text-muted-foreground">Working out the new amounts…</p>
          )}

          {preview && (
            <>
              <div className="space-y-1.5">
                <Label>Payer who survives</Label>
                <Select value={payerId} onValueChange={setPayerId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose who pays for the merged family…" />
                  </SelectTrigger>
                  <SelectContent>
                    {preview.candidates.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                        {c.isPayer ? " · current payer" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {summary && (
                <p className="rounded-md bg-zinc-50 px-3 py-2 text-xs font-medium ring-1 ring-inset ring-zinc-950/5">
                  {summary}
                </p>
              )}

              <div className="space-y-2">
                {preview.groups.map((g) => (
                  <FamilyPricingBreakdown
                    key={g.id}
                    quote={g.quote}
                    title={`Before · ${g.name}${g.payer ? ` (payer ${g.payer.name})` : " (no payer)"}`}
                    compact
                  />
                ))}
                <FamilyPricingBreakdown
                  quote={preview.merged}
                  title="After merging"
                />
              </div>

              {mergeIncrease && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
                  <p className="font-semibold text-foreground">{mergeIncrease}</p>
                  <label className="mt-2 flex items-center gap-2 font-medium">
                    <input
                      type="checkbox"
                      checked={ackIncrease}
                      onChange={(e) => setAckIncrease(e.target.checked)}
                    />
                    I understand the payer will pay more
                  </label>
                </div>
              )}

              {preview.redundantPayers.length > 0 && (
                <p className="rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-500/30">
                  {preview.redundantPayers
                    .map(
                      (p) =>
                        `${p.name}${p.hasLiveSubscription ? "'s active subscription will be cancelled" : " has no active subscription to cancel"}`,
                    )
                    .join("; ")}
                  . {survivor?.name ?? "The surviving payer"} then covers everyone, prorated.
                </p>
              )}

              <p className="text-[11px] text-muted-foreground">
                If any Stripe step fails, nothing is changed — the families are left
                exactly as they are now.
              </p>
            </>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mergeMut.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={
              mergeMut.isPending || !preview || !payerId || (!!mergeIncrease && !ackIncrease)
            }
            className="bg-brand text-brand-foreground hover:bg-brand/90"
            onClick={() => mergeMut.mutate()}
          >
            {mergeMut.isPending ? "Merging…" : "Merge families"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
