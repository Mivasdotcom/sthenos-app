import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { togglePaidThisPeriod } from "@/lib/cash-payments.functions";
import { shortPeriodLabel } from "@/lib/cash-payments";

/**
 * One-tap "Paid this month" for cash members. No dialog: tapping records a
 * payment for the current period at the plan price, tapping again undoes it.
 */
export function CashPaidToggle({
  dojoId,
  memberId,
  paid,
  interval,
  size = "sm",
}: {
  dojoId: string;
  memberId: string;
  paid: boolean;
  interval?: string | null;
  size?: "sm" | "md";
}) {
  const qc = useQueryClient();
  const toggle = useServerFn(togglePaidThisPeriod);
  const label = shortPeriodLabel(interval ?? "month");

  const mutation = useMutation({
    mutationFn: () => toggle({ data: { dojoId, memberId } }),
    onSuccess: (res) => {
      toast.success(res.paid ? `Marked paid · ${label}` : `Payment for ${label} removed`);
      qc.invalidateQueries({ queryKey: ["members"] });
      qc.invalidateQueries({ queryKey: ["member-detail"] });
      qc.invalidateQueries({ queryKey: ["cash-paid-state"] });
      qc.invalidateQueries({ queryKey: ["cash-payments"] });
      qc.invalidateQueries({ queryKey: ["cash-dues"] });
      qc.invalidateQueries({ queryKey: ["billing-revenue-summary"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not update payment"),
  });

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (!mutation.isPending) mutation.mutate();
      }}
      disabled={mutation.isPending}
      aria-pressed={paid}
      title={paid ? `Undo cash payment for ${label}` : `Record cash payment for ${label}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border font-medium transition-colors disabled:opacity-60",
        size === "sm" ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-xs",
        paid
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20"
          : "border-zinc-300 bg-background text-muted-foreground hover:border-zinc-400 hover:text-foreground",
      )}
    >
      {mutation.isPending ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <Check className={cn("size-3", paid ? "opacity-100" : "opacity-40")} />
      )}
      {paid ? `Paid · ${label}` : `Mark paid · ${label}`}
    </button>
  );
}
