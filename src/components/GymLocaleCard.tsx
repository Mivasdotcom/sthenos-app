import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Lock } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  CONNECT_COUNTRIES,
  allowedAccountCurrencies,
  countryLabel,
} from "@/lib/connect-countries";
import { updateDojoLocale } from "@/lib/connect.functions";

/**
 * Country and default currency for the gym.
 *
 * Editable only until a Stripe account exists — Stripe fixes a connected
 * account's country at creation, so afterwards these are shown read-only.
 */
export function GymLocaleCard({
  dojoId,
  country,
  currency,
  locked,
  canEdit,
}: {
  dojoId?: string | null;
  country: string | null;
  currency: string | null;
  locked: boolean;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const save = useServerFn(updateDojoLocale);
  const [nextCountry, setNextCountry] = useState(country ?? "");
  const [nextCurrency, setNextCurrency] = useState((currency ?? "").toLowerCase());

  useEffect(() => {
    setNextCountry(country ?? "");
    setNextCurrency((currency ?? "").toLowerCase());
  }, [country, currency]);

  const choices = allowedAccountCurrencies(nextCountry);
  const currencyInvalid = !!nextCountry && !!nextCurrency && !choices.includes(nextCurrency);

  const mutation = useMutation({
    mutationFn: () =>
      save({
        data: { dojoId: dojoId!, country: nextCountry, defaultCurrency: nextCurrency },
      }),
    onSuccess: () => {
      toast.success("Country and currency updated.");
      qc.invalidateQueries({ queryKey: ["dojo-stripe", dojoId] });
      qc.invalidateQueries({ queryKey: ["dojo-currency-health", dojoId] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not save"),
  });

  const dirty =
    nextCountry !== (country ?? "") || nextCurrency !== (currency ?? "").toLowerCase();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Country &amp; currency</CardTitle>
        <CardDescription>
          {locked
            ? "Locked because your Stripe account is connected."
            : "Stripe only supports certain currencies per country, and fixes your country when you connect. Get these right before connecting Stripe."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {locked ? (
          <>
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-muted-foreground">Country</dt>
                <dd className="font-medium">
                  {country ? countryLabel(country) : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Default currency</dt>
                <dd className="font-medium">{(currency ?? "").toUpperCase() || "—"}</dd>
              </div>
            </dl>
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <Lock className="mt-0.5 size-3.5 shrink-0" />
              Stripe does not allow a connected account's country to change. Correcting
              these would require a new Stripe connection — contact support if you need
              that.
            </p>
          </>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-sm font-medium">Country</label>
                <select
                  value={nextCountry}
                  disabled={!canEdit || mutation.isPending}
                  onChange={(e) => {
                    const c = e.target.value;
                    setNextCountry(c);
                    const allowed = allowedAccountCurrencies(c);
                    setNextCurrency((prev) => (allowed.includes(prev) ? prev : ""));
                  }}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-50"
                >
                  <option value="">Select your country</option>
                  {CONNECT_COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium">Default currency</label>
                <select
                  value={nextCurrency}
                  disabled={!canEdit || !nextCountry || mutation.isPending}
                  onChange={(e) => setNextCurrency(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-50"
                >
                  <option value="">
                    {nextCountry ? "Select your currency" : "Choose a country first"}
                  </option>
                  {choices.map((c) => (
                    <option key={c} value={c}>
                      {c.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {currencyInvalid && (
              <p className="text-xs text-destructive">
                Stripe doesn't support {nextCurrency.toUpperCase()} for a{" "}
                {countryLabel(nextCountry)} account. Choose{" "}
                {choices.map((c) => c.toUpperCase()).join(" or ")}.
              </p>
            )}
            <div className="flex items-center gap-3">
              <Button
                disabled={
                  !canEdit ||
                  !dojoId ||
                  !nextCountry ||
                  !nextCurrency ||
                  currencyInvalid ||
                  !dirty ||
                  mutation.isPending
                }
                onClick={() => mutation.mutate()}
              >
                {mutation.isPending ? "Saving…" : "Save"}
              </Button>
              <p className="text-xs text-muted-foreground">
                {canEdit
                  ? "You can change these until you connect Stripe."
                  : "Only owners and admins can change these."}
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
