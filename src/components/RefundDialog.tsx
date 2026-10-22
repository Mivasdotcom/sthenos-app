import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getRefundQuote, refundInvoice } from "@/lib/refunds.functions";

function money(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `${currency.toUpperCase()} ${(cents / 100).toFixed(2)}`;
  }
}

export function RefundDialog({
  open,
  onOpenChange,
  dojoId,
  invoiceId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  dojoId: string | null;
  invoiceId: string | null;
  onDone?: () => void;
}) {
  const quoteFn = useServerFn(getRefundQuote);
  const refundFn = useServerFn(refundInvoice);
  const qc = useQueryClient();

  const [mode, setMode] = useState<"full" | "partial">("full");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  const quoteQ = useQuery({
    queryKey: ["refund-quote", dojoId, invoiceId],
    enabled: open && !!dojoId && !!invoiceId,
    staleTime: 0,
    queryFn: () => quoteFn({ data: { dojoId: dojoId!, invoiceId: invoiceId!, amountCents: null } }),
  });

  const quote = quoteQ.data?.quote ?? null;
  const currency = quote?.currency ?? "usd";
  const remaining = quote?.remainingRefundableCents ?? 0;

  // Preview a partial amount by scaling the full-refund split proportionally.
  const preview = useMemo(() => {
    if (!quote) return null;
    const requested =
      mode === "full" ? remaining : Math.round((parseFloat(amount || "0") || 0) * 100);
    const capped = Math.min(Math.max(requested, 0), remaining);
    const feeRatio =
      quote.refundAmountCents > 0
        ? quote.platformFeeReversedCents / quote.refundAmountCents
        : 0;
    const stripeRatio =
      quote.refundAmountCents > 0
        ? quote.stripeCostBorneByGymCents / quote.refundAmountCents
        : 0;
    const fee = Math.round(capped * feeRatio);
    return {
      requested,
      capped,
      fee,
      stripeCost: Math.round(capped * stripeRatio),
      gym: Math.max(0, capped - fee),
      after: Math.max(0, remaining - capped),
      tooMuch: requested > remaining,
    };
  }, [quote, mode, amount, remaining]);

  const mutation = useMutation({
    mutationFn: () =>
      refundFn({
        data: {
          dojoId: dojoId!,
          invoiceId: invoiceId!,
          amountCents: mode === "full" ? null : preview?.capped ?? null,
          reason: reason.trim() || undefined,
        },
      }),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.error ?? "Refund failed");
        return;
      }
      toast.success(
        `Refunded ${money(res.amountCents, res.currency)} · ${money(res.remainingAfterCents, res.currency)} still refundable`,
      );
      void qc.invalidateQueries({ queryKey: ["invoices"] });
      void qc.invalidateQueries({ queryKey: ["member-invoices"] });
      void qc.invalidateQueries({ queryKey: ["refunds"] });
      onOpenChange(false);
      setAmount("");
      setReason("");
      setMode("full");
      onDone?.();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const blocked =
    !quote ||
    remaining <= 0 ||
    !preview ||
    preview.capped <= 0 ||
    preview.tooMuch ||
    mutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Refund payment</DialogTitle>
          <DialogDescription>
            Money is returned to the member. The gym gives back its share, and the platform's
            1% comes back to the gym proportionally.
          </DialogDescription>
        </DialogHeader>

        {quoteQ.isLoading ? (
          <div className="h-32 animate-pulse rounded-lg bg-muted" />
        ) : quoteQ.data?.error || quoteQ.isError ? (
          <p className="text-sm text-destructive">
            {quoteQ.data?.error ?? (quoteQ.error as Error)?.message}
          </p>
        ) : !quote ? null : (
          <div className="space-y-4">
            <div className="rounded-lg bg-muted/50 p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Original payment</span>
                <span className="tabular-nums">{money(quote.chargeAmountCents, currency)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Already refunded</span>
                <span className="tabular-nums">{money(quote.alreadyRefundedCents, currency)}</span>
              </div>
              <div className="mt-1 flex justify-between border-t border-border pt-1 font-medium">
                <span>Remaining refundable</span>
                <span className="tabular-nums">{money(remaining, currency)}</span>
              </div>
            </div>

            {remaining <= 0 ? (
              <p className="text-sm text-muted-foreground">
                This payment has already been refunded in full.
              </p>
            ) : (
              <>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={mode === "full" ? "default" : "outline"}
                    onClick={() => setMode("full")}
                  >
                    Full ({money(remaining, currency)})
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={mode === "partial" ? "default" : "outline"}
                    onClick={() => setMode("partial")}
                  >
                    Partial
                  </Button>
                </div>

                {mode === "partial" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="refund-amount">Amount ({currency.toUpperCase()})</Label>
                    <Input
                      id="refund-amount"
                      inputMode="decimal"
                      value={amount}
                      placeholder={(remaining / 100).toFixed(2)}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                    {preview?.tooMuch && (
                      <p className="text-xs text-destructive">
                        Maximum refundable is {money(remaining, currency)}.
                      </p>
                    )}
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label htmlFor="refund-reason">Reason</Label>
                  <Textarea
                    id="refund-reason"
                    rows={2}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Why is this being refunded?"
                  />
                </div>

                {preview && preview.capped > 0 && (
                  <div className="rounded-lg border border-border p-3 text-sm">
                    <div className="mb-1 font-medium">What will happen</div>
                    <ul className="space-y-1 text-muted-foreground">
                      <li className="flex justify-between">
                        <span>Refunded to member</span>
                        <span className="tabular-nums text-foreground">
                          {money(preview.capped, currency)}
                        </span>
                      </li>
                      <li className="flex justify-between">
                        <span>The gym gives back</span>
                        <span className="tabular-nums text-foreground">
                          {money(preview.gym, currency)}
                        </span>
                      </li>
                      <li className="flex justify-between">
                        <span>Platform fee returned to you</span>
                        <span className="tabular-nums text-foreground">
                          {money(preview.fee, currency)}
                        </span>
                      </li>
                      <li className="flex justify-between">
                        <span>Still refundable afterwards</span>
                        <span className="tabular-nums text-foreground">
                          {money(preview.after, currency)}
                        </span>
                      </li>
                    </ul>
                    {preview.stripeCost > 0 && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Stripe keeps its processing fee on a refund, so{" "}
                        {money(preview.stripeCost, currency)} of what you give back is Stripe's
                        card fee on the original payment.
                      </p>
                    )}
                    <p className="mt-2 text-xs text-muted-foreground">
                      This does <strong>not</strong> cancel the membership — billing continues
                      until you end it explicitly.
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={blocked}
            onClick={() => mutation.mutate()}
            className="gap-2"
          >
            <Undo2 className="size-4" />
            {mutation.isPending
              ? "Refunding…"
              : preview && preview.capped > 0
                ? `Refund ${money(preview.capped, currency)}`
                : "Refund"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
