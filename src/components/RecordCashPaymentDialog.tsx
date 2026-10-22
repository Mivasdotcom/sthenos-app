import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { recordCashPayment } from "@/lib/cash-payments.functions";
import { currentPeriod, periodLabel } from "@/lib/cash-payments";

export type CashPaymentTarget = {
  id: string;
  dojo_id: string;
  name: string;
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function RecordCashPaymentDialog({
  member,
  open,
  onOpenChange,
}: {
  member: CashPaymentTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const record = useServerFn(recordCashPayment);

  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(todayIso());
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [note, setNote] = useState("");

  const planQ = useQuery({
    queryKey: ["cash-plan", member?.id],
    enabled: !!member && open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("members")
        .select("id, dojo_plans:selected_plan_id(name, price_cents, currency, interval)")
        .eq("id", member!.id)
        .eq("dojo_id", member!.dojo_id)
        .maybeSingle();
      if (error) throw error;
      return ((data as any)?.dojo_plans ?? null) as {
        name: string;
        price_cents: number;
        currency: string;
        interval: string | null;
      } | null;
    },
  });

  const plan = planQ.data ?? null;

  // Defaults: plan price, today, and the period the plan is currently in.
  useEffect(() => {
    if (!open) return;
    const period = currentPeriod(plan?.interval ?? "month");
    setPaidOn(todayIso());
    setPeriodStart(period.start);
    setPeriodEnd(period.end);
    setNote("");
    setAmount(plan ? (plan.price_cents / 100).toFixed(2) : "");
  }, [open, plan]);

  const mutation = useMutation({
    mutationFn: async () => {
      const cents = Math.round(Number(amount) * 100);
      if (!Number.isFinite(cents) || cents <= 0) throw new Error("Enter a valid amount");
      return record({
        data: {
          dojoId: member!.dojo_id,
          memberId: member!.id,
          amountCents: cents,
          currency: plan?.currency,
          paidOn,
          periodStart,
          periodEnd,
          note: note || null,
        },
      });
    },
    onSuccess: () => {
      toast.success("Cash payment recorded");
      qc.invalidateQueries({ queryKey: ["members"] });
      qc.invalidateQueries({ queryKey: ["member-detail"] });
      qc.invalidateQueries({ queryKey: ["cash-payments"] });
      qc.invalidateQueries({ queryKey: ["cash-dues"] });
      qc.invalidateQueries({ queryKey: ["billing-revenue-summary"] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not record payment"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record cash payment</DialogTitle>
          <DialogDescription>
            {member?.name}
            {plan ? ` · ${plan.name}` : " · no plan assigned"}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!member || mutation.isPending) return;
            mutation.mutate();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cash-amount">
                Amount {plan?.currency ? `(${plan.currency.toUpperCase()})` : ""}
              </Label>
              <Input
                id="cash-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cash-paid-on">Date paid</Label>
              <Input
                id="cash-paid-on"
                type="date"
                value={paidOn}
                onChange={(e) => setPaidOn(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cash-period-start">Covers from</Label>
              <Input
                id="cash-period-start"
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cash-period-end">Covers to</Label>
              <Input
                id="cash-period-end"
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                required
              />
            </div>
          </div>
          {periodStart && periodEnd && periodEnd >= periodStart && (
            <p className="text-[11px] text-muted-foreground">
              Covers {periodLabel({ start: periodStart, end: periodEnd })} — the member counts as
              paid up through this period.
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="cash-note">Note (optional)</Label>
            <Input
              id="cash-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. paid at the desk"
              maxLength={300}
            />
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
              type="submit"
              disabled={mutation.isPending}
              className="bg-brand text-brand-foreground hover:bg-brand/90"
            >
              {mutation.isPending ? "Saving…" : "Record payment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
