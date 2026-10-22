import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { notifyHasFailure, notifySentence, type NotifySummary } from "@/lib/notify-summary";
import { PauseCircle, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/family-pricing";
import { resumeMembership } from "@/lib/pause.functions";

type PausedMember = {
  id: string;
  name: string;
  status: string;
  paused_at: string | null;
  pause_reason: string | null;
  pause_note: string | null;
  pause_resumes_at: string | null;
  pending_price_cents: number | null;
  pending_price_effective_at: string | null;
  currency: string;
};

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

/** Shown only when a membership is paused or has a scheduled price change. */
export function MembershipPauseCard({
  dojoId,
  member,
}: {
  dojoId: string;
  member: PausedMember;
}) {
  const qc = useQueryClient();
  const resumeFn = useServerFn(resumeMembership);

  const resume = useMutation({
    mutationFn: () => resumeFn({ data: { dojoId, memberId: member.id } }),
    onSuccess: (res) => {
      toast.success(
        res.payerNewTotalCents != null
          ? `Membership restarted — the family total is back to ${formatMoney(res.payerNewTotalCents, member.currency)}.`
          : "Membership restarted. Billing resumes at the next renewal.",
      );
      const notes = (res as any).notifications as NotifySummary | undefined;
      if (notifyHasFailure(notes)) toast.error(notifySentence(notes) ?? "Email failed", { duration: 10000 });
      qc.invalidateQueries({ queryKey: ["member-detail", member.id] });
      qc.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not restart the membership"),
  });

  const paused = member.status === "paused";
  const priceChange =
    member.pending_price_cents != null && member.pending_price_effective_at;

  if (!paused && !priceChange) return null;

  return (
    <div className="space-y-3">
      {paused && (
        <section className="rounded-xl border border-amber-300 bg-amber-100 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-amber-900">
                <PauseCircle className="size-4" /> Membership paused
              </h2>
              <p className="text-[13px] text-amber-900/90">
                Billing is stopped
                {member.paused_at ? ` since ${fmtDate(member.paused_at)}` : ""}
                {member.pause_reason ? ` · ${member.pause_reason}` : ""}
                {member.pause_resumes_at
                  ? ` · restarts automatically on ${fmtDate(member.pause_resumes_at)}`
                  : " · no restart date set"}
                .
              </p>
              {member.pause_note && (
                <p className="text-xs text-amber-900/80">“{member.pause_note}”</p>
              )}
            </div>
            <Button
              size="sm"
              className="gap-2 bg-amber-900 text-white hover:bg-amber-900/90"
              disabled={resume.isPending}
              onClick={() => resume.mutate()}
            >
              <PlayCircle className="size-3.5" />
              {resume.isPending ? "Restarting…" : "Restart membership"}
            </Button>
          </div>
        </section>
      )}

      {priceChange && (
        <section className="rounded-xl border border-sky-200 bg-sky-50 px-5 py-4 text-[13px] text-sky-900">
          Price changing to{" "}
          <span className="font-semibold">
            {formatMoney(member.pending_price_cents!, member.currency)}
          </span>{" "}
          from their first payment on or after{" "}
          {fmtDate(member.pending_price_effective_at!)}. They've been told, and nothing
          changes before then.
        </section>
      )}
    </div>
  );
}
