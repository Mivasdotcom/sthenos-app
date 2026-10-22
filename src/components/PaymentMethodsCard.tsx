import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  getCurrencyHealth,
  getDojoPaymentMethods,
  setDojoPaymentMethods,
} from "@/lib/payment-methods.functions";
import {
  ALL_PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHOD_LEAD_TIME,
  nativeCurrencyForCountry,
  type PaymentMethodId,
} from "@/lib/payment-methods";

export function PaymentMethodsCard({ dojoId }: { dojoId?: string | null }) {
  const qc = useQueryClient();
  const loadMethods = useServerFn(getDojoPaymentMethods);
  const loadHealth = useServerFn(getCurrencyHealth);
  const save = useServerFn(setDojoPaymentMethods);

  const { data } = useQuery({
    queryKey: ["dojo-payment-methods", dojoId],
    enabled: !!dojoId,
    queryFn: () => loadMethods({ data: { dojoId: dojoId! } }),
  });
  const { data: health } = useQuery({
    queryKey: ["dojo-currency-health", dojoId],
    enabled: !!dojoId,
    queryFn: () => loadHealth({ data: { dojoId: dojoId! } }),
  });

  const mutate = useMutation({
    mutationFn: (methods: string[]) => save({ data: { dojoId: dojoId!, methods } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dojo-payment-methods", dojoId] });
      toast.success("Payment methods updated.");
    },
    onError: (e: any) => toast.error(e?.message ?? "Couldn't save payment methods."),
  });

  const enabled = new Set(data?.enabled ?? []);
  const eligible = new Set(data?.eligible ?? ["card"]);
  const native = nativeCurrencyForCountry(health?.accountCountry ?? data?.accountCountry);
  const currency = (data?.currency ?? "").toUpperCase();

  const toggle = (m: PaymentMethodId, on: boolean) => {
    const next = new Set(enabled);
    if (on) next.add(m);
    else next.delete(m);
    next.add("card");
    mutate.mutate(Array.from(next));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Payment methods</CardTitle>
        <CardDescription>
          Direct debit keeps members paying when cards expire. Stripe only allows each
          method in specific currencies, so unavailable options are explained below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {ALL_PAYMENT_METHODS.map((m) => {
          const available = eligible.has(m);
          return (
            <div key={m} className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  {PAYMENT_METHOD_LABELS[m]}
                  {m === "card" && <Badge variant="secondary">Always on</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  {available
                    ? PAYMENT_METHOD_LEAD_TIME[m] ?? "Charged immediately."
                    : m === "sepa_debit"
                      ? `Requires plans priced in EUR — your plans are in ${currency || "your gym currency"}.`
                      : `Requires a UK Stripe account with GBP plans — yours is ${
                          (health?.accountCountry ?? data?.accountCountry ?? "not set")
                        } / ${currency || "unset"}.`}
                </p>
              </div>
              <Switch
                checked={available && enabled.has(m)}
                disabled={m === "card" || !available || mutate.isPending}
                onCheckedChange={(v) => toggle(m, v)}
              />
            </div>
          );
        })}

        {health && native && health.defaultCurrency !== native && (
          <div className="rounded-md border border-amber-300 bg-amber-100 p-3 text-sm text-amber-900">
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="size-4" /> Currency mismatch
            </div>
            <p className="mt-1">
              Your Stripe account is registered in{" "}
              {health.accountCountry ?? "another country"} and settles in{" "}
              {native.toUpperCase()}, but your plans are priced in{" "}
              {health.defaultCurrency.toUpperCase()}. This blocks direct debit and adds
              currency-conversion costs to every payout. Reprice your plans in{" "}
              {native.toUpperCase()} on the Plans page to fix it.
            </p>
          </div>
        )}

        {!!health?.mismatchedPlans.length && (
          <div className="rounded-md border p-3 text-sm">
            <p className="font-medium">Plans priced off your gym currency</p>
            <ul className="mt-1 list-disc pl-5 text-muted-foreground">
              {health.mismatchedPlans.map((p) => (
                <li key={p.id}>
                  {p.name} — {p.currency.toUpperCase()}
                </li>
              ))}
            </ul>
          </div>
        )}

        {!!health?.legacySubscriptions.length && (
          <div className="rounded-md border p-3 text-sm">
            <p className="font-medium">
              {health.legacySubscriptions.length} member
              {health.legacySubscriptions.length === 1 ? "" : "s"} still billed in an old
              currency
            </p>
            <p className="text-muted-foreground">
              Stripe can't change the currency of a live subscription. These members keep
              paying at their current currency until their subscription is cancelled and
              restarted.
            </p>
            <ul className="mt-1 list-disc pl-5 text-muted-foreground">
              {health.legacySubscriptions.slice(0, 8).map((s) => (
                <li key={s.memberId}>
                  {s.memberName} — {s.currency.toUpperCase()} ({s.status})
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
