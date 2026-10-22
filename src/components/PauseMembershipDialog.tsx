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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatMoney } from "@/lib/family-pricing";
import {
  getPausePreview,
  pauseMembership,
  type PauseReason,
} from "@/lib/pause.functions";
import { AlertTriangle, PauseCircle } from "lucide-react";

/** Freeze a membership: billing stops, nothing accrues, access follows policy. */
export function PauseMembershipDialog({
  open,
  dojoId,
  memberId,
  memberName,
  onClose,
}: {
  open: boolean;
  dojoId: string;
  memberId: string;
  memberName: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState<PauseReason | "">("");
  const [note, setNote] = useState("");
  const [resumeAt, setResumeAt] = useState("");
  const [scope, setScope] = useState<"member" | "family">("member");
  const [ackIncrease, setAckIncrease] = useState(false);

  const previewFn = useServerFn(getPausePreview);
  const pauseFn = useServerFn(pauseMembership);

  const { data: preview, isLoading } = useQuery({
    queryKey: ["pause-preview", dojoId, memberId],
    enabled: open && !!memberId,
    queryFn: () => previewFn({ data: { dojoId, memberId } }),
  });

  const mut = useMutation({
    mutationFn: () =>
      pauseFn({
        data: {
          dojoId,
          memberId,
          reason: reason as PauseReason,
          note: note.trim() || null,
          resumeAt: resumeAt ? new Date(`${resumeAt}T00:00:00`).toISOString() : null,
          scope,
        },
      }),
    onSuccess: (res) => {
      const notes = (res as any).notifications as NotifySummary | undefined;
      const emailFailed = notifyHasFailure(notes);
      // Never claim the member was told when the email did not go out.
      const told = emailFailed
        ? ""
        : `, and ${scope === "family" ? "everyone" : memberName} has been told`;
      toast.success(
        res.alreadyPaused
          ? "Already paused."
          : `Paused. Billing stopped${res.bookingsReleased ? `, ${res.bookingsReleased} upcoming booking${res.bookingsReleased === 1 ? "" : "s"} released` : ""}${told}.`,
      );
      if (emailFailed) toast.error(notifySentence(notes) ?? "Email failed", { duration: 10000 });
      qc.invalidateQueries({ queryKey: ["member"] });
      qc.invalidateQueries({ queryKey: ["members"] });
      qc.invalidateQueries({ queryKey: ["paused-members"] });
      onClose();
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not pause this membership"),
  });

  const blockedButFamily =
    preview?.blockedReason && preview.isFamilyPayer && preview.status !== "paused";

  // Steep tiers mean pausing a cheap member can push the family into a smaller
  // discount and INCREASE what the payer pays. Never let that pass unseen.
  const increaseCents =
    preview?.familyBeforeCents != null && preview?.familyAfterCents != null
      ? preview.familyAfterCents - preview.familyBeforeCents
      : 0;


  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PauseCircle className="size-5 text-amber-600" /> Pause {memberName}'s membership
          </DialogTitle>
          <DialogDescription>
            Billing stops while paused and nothing builds up to pay back. When they
            restart, they return to exactly the same price.
          </DialogDescription>
        </DialogHeader>

        {isLoading && <p className="text-sm text-muted-foreground">Checking billing…</p>}

        {preview && (
          <div className="space-y-4">
            {preview.blockedReason && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-100 p-3 text-[13px] text-amber-900">
                <AlertTriangle className="mt-0.5 size-4 flex-none" />
                <div>
                  {preview.blockedReason}
                  {blockedButFamily && (
                    <div className="mt-2">
                      <button
                        type="button"
                        className="font-semibold underline underline-offset-2"
                        onClick={() => setScope("family")}
                      >
                        Pause the whole family instead
                      </button>
                      {scope === "family" && (
                        <span className="ml-2 rounded bg-amber-200/60 px-1.5 py-0.5 text-[10px] font-bold uppercase">
                          selected
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Reason</Label>
                <Select value={reason} onValueChange={(v) => setReason(v as PauseReason)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a reason" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="travel">Travel</SelectItem>
                    <SelectItem value="personal">Personal</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="resume-at">Restart on (optional)</Label>
                <Input
                  id="resume-at"
                  type="date"
                  value={resumeAt}
                  min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
                  onChange={(e) => setResumeAt(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pause-note">Note (optional)</Label>
              <Textarea
                id="pause-note"
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Back on 15 October"
              />
              <p className="text-xs text-muted-foreground">
                Please don't record medical or health information here.
              </p>
            </div>

            <div className="rounded-lg border border-zinc-950/10 bg-zinc-50/60 p-3 text-[13px]">
              <div className="mb-1.5 font-semibold">What will happen</div>
              <ul className="space-y-1 text-muted-foreground">
                <li>
                  {preview.hasLiveSubscription
                    ? `Card billing stops${preview.nextRenewalAt ? ` — no charge on ${new Date(preview.nextRenewalAt).toLocaleDateString()}` : ""}, and nothing accumulates.`
                    : preview.paymentMethod === "cash"
                    ? "They pay in cash, so simply stop expecting payment while paused."
                    : "There is no live card subscription, so nothing to stop."}
                </li>
                <li>
                  {resumeAt
                    ? `Restarts automatically on ${new Date(`${resumeAt}T00:00:00`).toLocaleDateString()}, with a reminder 3 days before.`
                    : "Stays paused until you restart it."}
                </li>
                <li>
                  {preview.pausedMembersCanBook
                    ? "They can still book classes while paused."
                    : `Class booking is blocked while paused${preview.futureBookings ? `, and ${preview.futureBookings} upcoming booking${preview.futureBookings === 1 ? "" : "s"} will be released` : ""}.`}
                </li>
                {preview.familyBeforeCents != null && preview.familyAfterCents != null && (
                  <li className="text-foreground">
                    Family total{preview.payer ? ` for ${preview.payer.name}` : ""}:{" "}
                    <span className="tabular-nums">
                      {formatMoney(preview.familyBeforeCents, preview.currency)} →{" "}
                      <span className="font-semibold">
                        {formatMoney(preview.familyAfterCents, preview.currency)}
                      </span>
                    </span>{" "}
                    ({preview.familyDiscountBefore}% → {preview.familyDiscountAfter}%
                    family discount), from the next payment date — never mid-cycle.
                  </li>
                )}
                <li>{memberName} is told all of this straight away.</li>
              </ul>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="bg-amber-600 text-white hover:bg-amber-600/90"
            disabled={
              mut.isPending ||
              !reason ||
              !preview ||
              (!preview.canPause && !(blockedButFamily && scope === "family")) ||
              (increaseCents > 0 && !ackIncrease)
            }
            onClick={() => mut.mutate()}
          >
            {mut.isPending
              ? "Pausing…"
              : scope === "family"
              ? "Pause the whole family"
              : "Pause membership"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
