import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/family-pricing";
import {
  listGrandfatheredMembers,
  listPlanPriceChanges,
  moveMemberToCurrentPrice,
} from "@/lib/price-changes.functions";
import { Lock, CheckCircle2 } from "lucide-react";

const REASON_LABEL: Record<string, string> = {
  older_plan_price: "on an older plan price",
  platform_fee: "platform fee not applied",
};

/** Members billed something other than the gym's current pricing, plus scheduled changes. */
export function GrandfatheredPricesCard({ dojoId }: { dojoId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listGrandfatheredMembers);
  const changesFn = useServerFn(listPlanPriceChanges);
  const moveFn = useServerFn(moveMemberToCurrentPrice);

  const { data, isLoading } = useQuery({
    queryKey: ["grandfathered-members", dojoId],
    enabled: !!dojoId,
    queryFn: () => listFn({ data: { dojoId } }),
  });
  const { data: changes } = useQuery({
    queryKey: ["price-changes", dojoId],
    enabled: !!dojoId,
    queryFn: () => changesFn({ data: { dojoId } }),
  });

  const move = useMutation({
    mutationFn: (memberId: string) => moveFn({ data: { dojoId, memberId } }),
    onSuccess: (res) => {
      toast.success(
        `Scheduled — the new price applies from their first payment on or after ${new Date(res.effectiveAt).toLocaleDateString()}, and they've been told.`,
      );
      qc.invalidateQueries({ queryKey: ["grandfathered-members"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not schedule the change"),
  });

  const members = data?.members ?? [];
  const scheduled = (changes?.changes ?? []).filter(
    (c) => !c.appliedAt && new Date(c.effectiveAt).getTime() > Date.now(),
  );

  return (
    <div className="rounded-xl bg-card p-5 ring-1 ring-black/5">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Lock className="size-4 text-muted-foreground" /> Pricing mismatches
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Members billed a different amount than your current pricing — an older plan price, or
        the 1% platform fee not being passed on — plus price changes still waiting out their
        notice period.
      </p>

      {scheduled.length > 0 && (
        <div className="mt-4 space-y-1.5">
          {scheduled.map((c) => (
            <div
              key={c.id}
              className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-[13px] text-sky-900"
            >
              <span className="font-semibold">{c.planName}</span>:{" "}
              {formatMoney(c.oldPriceCents, c.currency)} →{" "}
              {formatMoney(c.newPriceCents, c.currency)} for {c.membersAffected} member
              {c.membersAffected === 1 ? "" : "s"}, from{" "}
              {new Date(c.effectiveAt).toLocaleDateString(undefined, {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
              .
            </div>
          ))}
        </div>
      )}

      {members.length === 0 ? (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-[13px] text-emerald-900">
          <CheckCircle2 className="size-4 shrink-0" />
          {isLoading
            ? "Checking every member against your current pricing…"
            : data?.checked
              ? `Every member matches your current pricing (${data.checked} checked).`
              : "No live memberships to check yet."}
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-950/10">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-zinc-950/5 bg-zinc-50/50 text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2">Member</th>
                <th className="px-3 py-2">Plan</th>
                <th className="px-3 py-2">Why</th>
                <th className="px-3 py-2">Pays now</th>
                <th className="px-3 py-2">Would pay</th>
                <th className="px-3 py-2">You receive</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-950/5">
              {members.map((m) => (
                <tr key={m.memberId}>
                  <td className="px-3 py-2 font-medium">{m.name}</td>
                  <td className="px-3 py-2 text-muted-foreground">{m.planName}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {m.reasons.map((r) => (
                        <span
                          key={r}
                          className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900"
                        >
                          {REASON_LABEL[r] ?? r}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {formatMoney(m.currentChargeCents, m.currency)}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {formatMoney(m.targetChargeCents, m.currency)}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">
                    {formatMoney(m.currentNetCents, m.currency)} →{" "}
                    <span className="text-foreground">
                      {formatMoney(m.targetNetCents, m.currency)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {m.pendingPriceCents != null && m.pendingEffectiveAt ? (
                      <span className="text-[11px] text-sky-700">
                        moving on {new Date(m.pendingEffectiveAt).toLocaleDateString()}
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 whitespace-nowrap text-xs"
                        disabled={move.isPending}
                        onClick={() => move.mutate(m.memberId)}
                      >
                        Move to current price
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
