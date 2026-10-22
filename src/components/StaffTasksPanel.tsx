import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ClipboardList } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { listTasks, setTaskStatus } from "@/lib/tasks.functions";

/**
 * Things the system has flagged for a human that have nowhere else to appear.
 *
 * The app raises internal tasks from several places and, until now, displayed
 * none of them: the API existed and no page called it. In practice that only
 * hid one kind -- a failed payment -- which the amber panel above already
 * reports in more detail, with the amount and how long ago it failed.
 *
 * So payment failures are deliberately left out here. What remains are the
 * ones with no other home, and they are the ones that quietly cost a gym
 * money: a family losing its payer, a member removed from a family with no
 * card of their own, records due for anonymisation. The panel renders nothing
 * until one of those exists, which today is never -- and that is the point.
 * It appears the day something needs a person, and stays out of the way
 * otherwise.
 */

/** Covered in full by PaymentFailureAlerts, so never shown twice. */
function isPaymentFailure(title: string): boolean {
  return title.trim().toLowerCase().startsWith("payment failed");
}

export function StaffTasksPanel({ dojoId }: { dojoId: string | null }) {
  const qc = useQueryClient();
  // A member reaching the dashboard through the logo would otherwise fire a
  // staff-only call on every visit, and be refused every time.
  const { isRealStaff } = useAuth();
  const listFn = useServerFn(listTasks);
  const setStatusFn = useServerFn(setTaskStatus);

  const { data } = useQuery({
    queryKey: ["staff-tasks", dojoId],
    enabled: !!dojoId && isRealStaff,
    queryFn: () => listFn({ data: { dojoId: dojoId! } }),
  });

  const done = useMutation({
    mutationFn: (id: string) =>
      setStatusFn({ data: { id, status: "done" as const, dojoId: dojoId! } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["staff-tasks", dojoId] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Couldn't update that."),
  });

  const open = ((data?.tasks ?? []) as any[]).filter(
    (t) => t.status === "open" && !isPaymentFailure(String(t.title ?? "")),
  );
  if (open.length === 0) return null;

  return (
    <section className="rounded-xl border border-zinc-950/10 bg-card p-5">
      <div className="flex items-center gap-2">
        <ClipboardList className="size-5 text-brand" />
        <h2 className="font-display text-base font-semibold">
          {open.length === 1 ? "1 thing needs you" : `${open.length} things need you`}
        </h2>
      </div>
      <ul className="mt-4 space-y-2">
        {open.map((t) => (
          <li
            key={t.id}
            className="flex flex-wrap items-start justify-between gap-3 rounded-lg p-3 text-sm ring-1 ring-black/5"
          >
            <div className="min-w-0">
              <div className="font-medium">{t.title}</div>
              {t.description && (
                <div className="mt-0.5 text-xs text-muted-foreground">{t.description}</div>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={done.isPending}
              onClick={() => done.mutate(t.id)}
            >
              Done
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
