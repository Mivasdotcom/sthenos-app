import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Clock, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BLOCKER_LABELS, monthsLabel, type RetentionBlocker } from "@/lib/retention-policy";
import { getMemberRetention, setRetentionHold } from "@/lib/data-retention.functions";

const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";

/**
 * Advance notice on a member's own page: when their record is due to be
 * anonymised under the gym's retention policy, and a way to exclude it.
 */
export function MemberRetentionCard({
  dojoId,
  memberId,
  canEdit,
}: {
  dojoId: string;
  memberId: string;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const load = useServerFn(getMemberRetention);
  const setHold = useServerFn(setRetentionHold);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  const { data } = useQuery({
    queryKey: ["member-retention", dojoId, memberId],
    queryFn: () => load({ data: { dojoId, memberId } }),
  });

  const hold = useMutation({
    mutationFn: (next: boolean) =>
      setHold({ data: { dojoId, memberId, hold: next, reason } }),
    onSuccess: () => {
      toast.success("Retention updated");
      setOpen(false);
      setReason("");
      qc.invalidateQueries({ queryKey: ["member-retention"] });
      qc.invalidateQueries({ queryKey: ["retention-schedule"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not update"),
  });

  if (!data) return null;

  if (data.anonymisedAt) {
    return (
      <div className="rounded-xl bg-card p-4 text-xs text-muted-foreground ring-1 ring-black/5">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <ShieldCheck className="size-4" /> Anonymised on {fmt(data.anonymisedAt)}
        </div>
        <p className="mt-1">
          Personal details were removed under the gym's data retention policy. Invoices, payments and
          training statistics have been kept.
        </p>
      </div>
    );
  }

  const m = data.member;
  const policy = data.policy;
  if (!m || !m.departedAt || !policy.autoEnabled || policy.departedMonths == null) return null;

  const onHold = m.blockers.includes("on_hold" as RetentionBlocker);
  const otherBlockers = m.blockers.filter((b) => b !== "on_hold" && b !== "still_a_member");
  const days = m.daysUntilDue ?? 0;

  return (
    <div className="rounded-xl bg-card p-4 ring-1 ring-black/5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            <Clock className="size-4" /> Data retention
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Left {fmt(m.departedAt)}. Under your {monthsLabel(policy.departedMonths)} retention
            policy this record is {days > 0 ? "due" : "past due"} for anonymisation on{" "}
            <strong>{fmt(m.dueOn)}</strong>
            {days > 0 ? ` (in ${days} day${days === 1 ? "" : "s"})` : ""}. Personal details are
            removed; invoices, payments and training statistics are kept.
          </p>
          {onHold && (
            <p className="mt-1 text-xs text-amber-700">
              Excluded from automatic anonymisation{m.holdReason ? ` — ${m.holdReason}` : ""}.
            </p>
          )}
          {otherBlockers.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Held back automatically:{" "}
              {otherBlockers.map((b) => BLOCKER_LABELS[b as RetentionBlocker] ?? b).join(", ")}.
            </p>
          )}
        </div>
        {canEdit && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (onHold) hold.mutate(false);
              else setOpen(true);
            }}
            disabled={hold.isPending}
          >
            {hold.isPending && <Loader2 className="mr-2 size-3.5 animate-spin" />}
            {onHold ? "Allow anonymisation" : "Keep this record"}
          </Button>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Keep this record</DialogTitle>
            <DialogDescription>
              This record will be excluded from automatic anonymisation until you remove the
              exclusion. Record why — an ongoing dispute, an outstanding balance or a pending claim.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Injury claim pending"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!reason.trim() || hold.isPending} onClick={() => hold.mutate(true)}>
              {hold.isPending && <Loader2 className="mr-2 size-3.5 animate-spin" />}
              Keep record
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
