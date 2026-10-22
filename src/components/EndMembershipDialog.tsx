// Single UI entry point for ending a membership. Always goes through the
// `endMembership` server function so Stripe billing is stopped first.

import { useState } from "react";
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
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { AlertTriangle, Users } from "lucide-react";
import {
  endMembership,
  getEndMembershipPreview,
  type CancelMode,
} from "@/lib/cancellation.functions";

function fmtDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function EndMembershipDialog({
  open,
  onOpenChange,
  dojoId,
  member,
  reason,
  source,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  dojoId: string | null;
  member: { id: string; name: string } | null;
  reason?: string | null;
  source?: string;
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<CancelMode>("period_end");
  const previewFn = useServerFn(getEndMembershipPreview);
  const endFn = useServerFn(endMembership);

  const previewQ = useQuery({
    queryKey: ["end-membership-preview", dojoId, member?.id],
    enabled: !!dojoId && !!member?.id && open,
    queryFn: () => previewFn({ data: { dojoId: dojoId!, memberId: member!.id } }),
  });
  const preview = previewQ.data;

  const mut = useMutation({
    mutationFn: () =>
      endFn({
        data: {
          dojoId: dojoId!,
          memberId: member!.id,
          mode,
          reason: reason ?? null,
          source: source ?? null,
        },
      }),
    onSuccess: (res) => {
      const until = fmtDate(res.accessUntil);
      if (res.mode === "period_end" && until) {
        toast.success(`Billing stopped — access until ${until}, no further charges`);
      } else {
        toast.success("Membership ended and billing stopped");
      }
      if (res.dependents.length > 0) {
        toast.warning(
          `${res.dependents.length} family member${res.dependents.length === 1 ? "" : "s"} lost coverage — a task was created to reassign them`,
        );
      }
      qc.invalidateQueries({ queryKey: ["members"] });
      qc.invalidateQueries({ queryKey: ["cancellations"] });
      qc.invalidateQueries({ queryKey: ["member-detail"] });
      qc.invalidateQueries({ queryKey: ["cash-dues"] });
      qc.invalidateQueries({ queryKey: ["cancellation-reconciliation"] });
      onOpenChange(false);
      onDone?.();
    },
    onError: (e: Error) =>
      toast.error(e.message || "Could not end this membership — nothing was changed"),
  });

  const periodEnd = fmtDate(preview?.subscription?.currentPeriodEnd ?? null);
  const hasSub = !!preview?.subscription;
  const isCash = preview?.paymentMethod === "cash";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>End membership for {member?.name}?</DialogTitle>
          <DialogDescription>
            {isCash
              ? "This member pays in cash, so there is no subscription to cancel. They will be marked lapsed and will stop appearing in expected dues."
              : hasSub
                ? "Their Stripe subscription is cancelled first. If Stripe refuses, nothing is changed here."
                : "No active subscription found, so there is nothing to cancel in Stripe. They will be marked lapsed."}
          </DialogDescription>
        </DialogHeader>

        {previewQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Checking billing…</p>
        ) : (
          <div className="space-y-4">
            {hasSub && !isCash && (
              <RadioGroup value={mode} onValueChange={(v) => setMode(v as CancelMode)}>
                <div className="flex items-start gap-3 rounded-lg border border-border p-3">
                  <RadioGroupItem value="period_end" id="mode-period-end" className="mt-0.5" />
                  <div className="space-y-0.5">
                    <Label htmlFor="mode-period-end" className="font-medium">
                      Cancel at end of paid period (recommended)
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {periodEnd
                        ? `Access until ${periodEnd}, no further charges.`
                        : "They keep access for the period they've already paid for, with no further charges."}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3 rounded-lg border border-border p-3">
                  <RadioGroupItem value="immediate" id="mode-immediate" className="mt-0.5" />
                  <div className="space-y-0.5">
                    <Label htmlFor="mode-immediate" className="font-medium">
                      Cancel immediately
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Billing and access stop right now. The remainder of the paid period is not
                      refunded automatically.
                    </p>
                  </div>
                </div>
              </RadioGroup>
            )}

            {preview && preview.dependents.length > 0 && (
              <div className="space-y-1 rounded-lg bg-amber-100 p-3 ring-1 ring-amber-500/30">
                <div className="flex items-center gap-2 text-sm font-semibold text-amber-900">
                  <Users className="size-4" /> This member pays for a family plan
                </div>
                <p className="text-xs text-amber-900">
                  These members lose coverage when the plan ends:{" "}
                  <strong>{preview.dependents.map((d) => d.name).join(", ")}</strong>. A staff task
                  will be created to reassign them.
                </p>
              </div>
            )}

            {hasSub && preview?.stripeConfigured === false && (
              <div className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                Stripe isn't configured, so this subscription can't be stopped. Resolve payment
                setup before cancelling.
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mut.isPending}>
            Back
          </Button>
          <Button
            variant="destructive"
            onClick={() => mut.mutate()}
            disabled={mut.isPending || previewQ.isLoading}
          >
            {mut.isPending ? "Stopping billing…" : "End membership"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
