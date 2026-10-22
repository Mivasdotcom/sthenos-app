import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { notifyHasFailure, notifySentence, type NotifySummary } from "@/lib/notify-summary";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatMoney } from "@/lib/family-pricing";
import { PLATFORM_FEE_PERCENT } from "@/lib/platform-fee";
import {
  applyPlanPriceChange,
  previewPlanPriceChange,
  type PriceChangeScope,
} from "@/lib/price-changes.functions";
import type { DojoPlan } from "@/lib/plans.functions";
import { AlertTriangle, ArrowRight, Users } from "lucide-react";

/**
 * Change a plan's price. Nobody is charged mid-cycle and nobody's amount
 * changes without notice — the preview states exactly who is affected, by how
 * much, and from when.
 */
export function PlanPriceChangeDialog({
  open,
  plan,
  dojoId,
  onClose,
}: {
  open: boolean;
  plan: DojoPlan | null;
  dojoId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [price, setPrice] = useState("");
  const [scope, setScope] = useState<PriceChangeScope>("new_members");
  const [notes, setNotes] = useState("");
  const [confirming, setConfirming] = useState(false);

  const previewFn = useServerFn(previewPlanPriceChange);
  const applyFn = useServerFn(applyPlanPriceChange);

  const currentPrice = plan ? plan.price_cents : 0;
  const newCents = Math.round(parseFloat(price || "0") * 100);
  const valid = !!plan && Number.isFinite(newCents) && newCents >= 0 && newCents !== currentPrice;

  const { data: preview, isFetching } = useQuery({
    queryKey: ["price-change-preview", plan?.id, newCents],
    enabled: open && valid,
    queryFn: () =>
      previewFn({ data: { dojoId, planId: plan!.id, newPriceCents: newCents } }),
  });

  const apply = useMutation({
    mutationFn: () =>
      applyFn({
        data: {
          dojoId,
          planId: plan!.id,
          newPriceCents: newCents,
          scope,
          notes: notes.trim() || null,
        },
      }),
    onSuccess: (res) => {
      if (res.scope === "new_members") {
        toast.success(
          `New price saved for new members. ${res.grandfathered} existing member${res.grandfathered === 1 ? "" : "s"} stay on their current price.`,
        );
      } else {
        const notes = (res as any).notifications as NotifySummary | undefined;
        toast.success(
          `Scheduled — the new amount applies from each member's first payment on or after ${new Date(res.effectiveAt!).toLocaleDateString()}. ${res.notified} of ${notes?.attempted ?? res.notified} member${(notes?.attempted ?? res.notified) === 1 ? "" : "s"} notified.`,
        );
        if (notifyHasFailure(notes)) toast.error(notifySentence(notes) ?? "Email failed", { duration: 10000 });
      }
      qc.invalidateQueries({ queryKey: ["dojo-plans"] });
      qc.invalidateQueries({ queryKey: ["price-changes"] });
      qc.invalidateQueries({ queryKey: ["grandfathered-members"] });
      reset();
      onClose();
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not change the price"),
  });

  function reset() {
    setPrice("");
    setScope("new_members");
    setNotes("");
    setConfirming(false);
  }

  if (!plan) return null;
  const currency = plan.currency;
  const per = plan.interval === "year" ? "year" : plan.interval === "one_time" ? "" : "month";
  const changing = preview?.rows.filter((r) => r.newChargeCents !== r.oldChargeCents) ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Change the price of {plan.name}</DialogTitle>
          <DialogDescription>
            Currently {formatMoney(currentPrice, currency)}
            {per ? ` per ${per}` : ""}. Nobody is charged today, and no existing
            member's amount changes without notice.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="new-price">New price</Label>
            <Input
              id="new-price"
              type="number"
              min="0"
              step="0.01"
              value={price}
              onChange={(e) => {
                setPrice(e.target.value);
                setConfirming(false);
              }}
              placeholder={(currentPrice / 100).toFixed(2)}
            />
          </div>

          <div className="space-y-2">
            <Label>Who does the new price apply to?</Label>
            <div className="grid gap-2">
              <ScopeOption
                selected={scope === "new_members"}
                onSelect={() => setScope("new_members")}
                title="New members only"
                body="Existing members keep the price they signed up at. Nothing changes for anyone already paying."
              />
              <ScopeOption
                selected={scope === "all_members"}
                onSelect={() => setScope("all_members")}
                title="All members on this plan"
                body={`Everyone is told now and moves to the new price at their next renewal, after a ${preview?.noticeDays ?? 30}-day notice period.`}
              />
            </div>
          </div>

          {valid && (
            <div className="rounded-lg border border-zinc-950/10 bg-zinc-50/60 p-4 text-sm">
              <div className="mb-2 font-semibold">What will happen</div>
              {isFetching && <p className="text-muted-foreground">Working out the impact…</p>}
              {preview && !isFetching && (
                <div className="space-y-2 text-[13px]">
                  <p>
                    New signups pay{" "}
                    <span className="font-semibold tabular-nums">
                      {formatMoney(newCents, currency)}
                    </span>
                    {per ? ` per ${per}` : ""} from now.
                  </p>
                  {scope === "new_members" ? (
                    <p>
                      {preview.counts.onPlan} existing member
                      {preview.counts.onPlan === 1 ? "" : "s"} on this plan keep their
                      current price. Nothing is charged and nothing is scheduled.
                    </p>
                  ) : (
                    <>
                      <p>
                        {changing.length} member{changing.length === 1 ? "" : "s"} affected.
                        The new amount applies from their first payment on or after{" "}
                        <span className="font-semibold">
                          {new Date(preview.effectiveAt).toLocaleDateString(undefined, {
                            day: "numeric",
                            month: "long",
                            year: "numeric",
                          })}
                        </span>{" "}
                        ({preview.noticeDays} days' notice). Nobody is charged mid-cycle.
                      </p>
                      <p className="tabular-nums">
                        Recurring revenue from these members:{" "}
                        {formatMoney(preview.totals.oldCents, currency)} →{" "}
                        <span className="font-semibold">
                          {formatMoney(preview.totals.newCents, currency)}
                        </span>{" "}
                        <span
                          className={
                            preview.totals.diffCents >= 0
                              ? "text-emerald-700"
                              : "text-amber-700"
                          }
                        >
                          ({preview.totals.diffCents >= 0 ? "+" : "−"}
                          {formatMoney(Math.abs(preview.totals.diffCents), currency)}
                          {per ? `/${per}` : ""})
                        </span>
                      </p>
                      {preview.passFee && (
                        <p className="text-muted-foreground">
                          Amounts shown are what members are actually charged, including
                          the {PLATFORM_FEE_PERCENT}% platform fee you pass on.
                        </p>
                      )}
                      {preview.counts.paused > 0 && (
                        <p className="text-muted-foreground">
                          {preview.counts.paused} of them are paused — they move to the new
                          price when they restart.
                        </p>
                      )}
                      {preview.counts.cash > 0 && (
                        <p className="text-muted-foreground">
                          {preview.counts.cash} pay in cash — they are told the new amount
                          but you collect it yourself.
                        </p>
                      )}
                      {changing.length > 0 && (
                        <div className="mt-2 max-h-56 overflow-y-auto rounded border border-zinc-950/10 bg-card">
                          <table className="w-full text-left text-[12px]">
                            <thead>
                              <tr className="border-b border-zinc-950/5 text-[10px] uppercase tracking-wider text-muted-foreground">
                                <th className="px-3 py-2">Member</th>
                                <th className="px-3 py-2">Now</th>
                                <th className="px-3 py-2">After</th>
                                <th className="px-3 py-2">Next renewal</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-zinc-950/5">
                              {changing.map((r) => (
                                <tr key={r.memberId}>
                                  <td className="px-3 py-1.5">
                                    <span className="font-medium">{r.name}</span>
                                    {r.isFamilyPayer && (
                                      <span className="ml-1.5 inline-flex items-center gap-1 rounded bg-violet-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-violet-700">
                                        <Users className="size-3" /> family of{" "}
                                        {r.coveredCount + 1}
                                      </span>
                                    )}
                                    {r.status === "paused" && (
                                      <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-700">
                                        paused
                                      </span>
                                    )}
                                  </td>
                                  <td className="px-3 py-1.5 tabular-nums">
                                    {formatMoney(r.oldGrossCents, currency)}
                                  </td>
                                  <td className="px-3 py-1.5 font-semibold tabular-nums">
                                    {formatMoney(r.newGrossCents, currency)}
                                  </td>
                                  <td className="px-3 py-1.5 text-muted-foreground">
                                    {r.nextRenewalAt
                                      ? new Date(r.nextRenewalAt).toLocaleDateString()
                                      : r.paymentMethod === "cash"
                                      ? "cash"
                                      : "—"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {scope === "all_members" && (
            <div className="space-y-1.5">
              <Label htmlFor="pc-notes">Internal note (optional)</Label>
              <Textarea
                id="pc-notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Why the price is changing — kept for your records."
              />
            </div>
          )}

          {confirming && scope === "all_members" && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-100 p-3 text-[13px] text-amber-900">
              <AlertTriangle className="mt-0.5 size-4 flex-none" />
              <div>
                This tells {changing.length} member
                {changing.length === 1 ? "" : "s"} that their price is changing, and
                schedules it. Press again to confirm.
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="bg-brand text-brand-foreground hover:bg-brand/90"
            disabled={!valid || apply.isPending || isFetching}
            onClick={() => {
              if (scope === "all_members" && !confirming) {
                setConfirming(true);
                return;
              }
              apply.mutate();
            }}
          >
            {apply.isPending ? (
              "Saving…"
            ) : scope === "all_members" && !confirming ? (
              <>
                Review <ArrowRight className="size-4" />
              </>
            ) : scope === "all_members" ? (
              "Confirm and notify members"
            ) : (
              "Save new price"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScopeOption({
  selected,
  onSelect,
  title,
  body,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`rounded-lg border p-3 text-left transition-colors ${
        selected
          ? "border-brand bg-brand/5 ring-1 ring-brand/30"
          : "border-zinc-950/10 hover:bg-zinc-50"
      }`}
    >
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{body}</div>
    </button>
  );
}
