import { PUBLIC_SITE_URL } from "@/lib/site";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  createExpressLoginLink,
  getDojoStripeStatus,
  refreshConnectStatus,
  startConnectOnboarding,
  updateBillingSchedule,
} from "@/lib/connect.functions";
import { backfillInvoicesFromStripe } from "@/lib/billing-backfill.functions";
import {
  reconcileDuesSubscriptions,
  cancelOrphanedSubscription,
  cancelStripeDuesSubscription,

  type StillBillingRow,
  type DoubleBilledFamily,
} from "@/lib/billing-reconcile.functions";

import { PaymentMethodsCard } from "@/components/PaymentMethodsCard";
import { GymLocaleCard } from "@/components/GymLocaleCard";
import {
  PLATFORM_FEE_PERCENT,
  grossChargeCents,
  platformFeeCents,
  stripeFeeCents,
} from "@/lib/platform-fee";

/**
 * A worked example built from the SAME helpers that set the real fees, so the
 * words on this page can never again drift from what a gym is actually paid.
 * They did once: this page promised "your payout equals the full plan price"
 * for weeks after card processing started coming out of the gym's payout.
 */
function payoutExample(currency: string | null | undefined, passOn: boolean) {
  const base = 6500;
  const gross = grossChargeCents(base, passOn);
  const card = stripeFeeCents(gross);
  const platform = platformFeeCents(base);
  const fmt = (c: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: (currency || "eur").toUpperCase(),
    }).format(c / 100);
  return {
    price: fmt(base),
    memberPays: fmt(gross),
    card: fmt(card),
    youReceive: fmt(gross - card - platform),
  };
}
import { ordinal } from "@/lib/billing-copy";
import { ArrowLeft, CheckCircle2, CircleDashed, ExternalLink, AlertTriangle } from "lucide-react";

export const Route = createFileRoute("/settings/payments")({
  head: () => ({
    meta: [
      { title: "Payment setup — Sthenos" },
      { name: "description", content: "Connect your gym's Stripe account to accept membership payments." },
    ],
    links: [{ rel: "canonical", href: `${PUBLIC_SITE_URL}/settings/payments` }],
  }),
  component: PaymentsSettings,
});

type DojoStripeRow = {
  id: string;
  stripe_account_id: string | null;
  stripe_charges_enabled: boolean;
  stripe_details_submitted: boolean;
  stripe_account_country: string | null;
  country: string | null;
  default_currency: string | null;
  pass_platform_fee_to_members: boolean;
  billing_day_of_month: number | null;
  billing_mode: string | null;
  timezone: string | null;
};

const COMMON_TIMEZONES = [
  "UTC",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Lisbon",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "Europe/Athens",
  "Europe/Nicosia",
  "Europe/Stockholm",
  "Europe/Warsaw",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Sao_Paulo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

function PaymentsSettings() {
  const { activeDojoId, activeDojo } = useCurrentDojo();
  const canEdit = activeDojo?.role === "owner" || activeDojo?.role === "admin";
  const isOwner = activeDojo?.role === "owner";
  const qc = useQueryClient();

  const fetchStripeStatus = useServerFn(getDojoStripeStatus);
  const { data, isLoading } = useQuery({
    queryKey: ["dojo-stripe", activeDojoId],
    enabled: !!activeDojoId,
    queryFn: async (): Promise<DojoStripeRow | null> => {
      const row = await fetchStripeStatus({ data: { dojoId: activeDojoId! } });
      return (row as DojoStripeRow | null) ?? null;
    },
  });

  const saveBillingSchedule = useServerFn(updateBillingSchedule);
  const scheduleMutation = useMutation({
    mutationFn: async (vars: { billingDayOfMonth: number; timezone: string }) =>
      await saveBillingSchedule({ data: { dojoId: activeDojoId!, ...vars } }),
    onSuccess: () => {
      toast.success("Billing day updated. New signups will use it.");
      qc.invalidateQueries({ queryKey: ["dojo-stripe", activeDojoId] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not save billing day"),
  });
  const savingSchedule = scheduleMutation.isPending;
  const saveSchedule = (vars: { billingDayOfMonth: number; timezone: string }) => {
    if (!activeDojoId) return;
    scheduleMutation.mutate(vars);
  };

  const startOnboarding = useServerFn(startConnectOnboarding);
  const refreshStatus = useServerFn(refreshConnectStatus);
  const loginLink = useServerFn(createExpressLoginLink);

  const start = useMutation({
    mutationFn: async () => {
      console.log("[connect] Connect Stripe clicked", { activeDojoId });
      if (!activeDojoId) throw new Error("No active dojo");
      const res = await startOnboarding({ data: { dojoId: activeDojoId } });
      console.log("[connect] server responded", res);
      if (res.error || !res.url) throw new Error(res.error ?? "Could not start onboarding");
      return res.url;
    },
    onSuccess: (url) => {
      console.log("[connect] redirecting to Stripe", url);
      // Break out of the preview iframe — Stripe's onboarding pages set
      // X-Frame-Options: DENY, so navigating the inner frame fails silently.
      try {
        if (window.top && window.top !== window.self) {
          window.top.location.href = url;
          return;
        }
      } catch {
        // cross-origin top; fall through to opening in a new tab
      }
      const opened = window.open(url, "_top");
      if (!opened) window.location.href = url;
    },
    onError: (e: Error) => {
      console.error("[connect] onboarding failed", e);
      toast.error(e.message);
    },
  });


  const refresh = useMutation({
    mutationFn: async () => {
      if (!activeDojoId) throw new Error("No active dojo");
      const res = await refreshStatus({ data: { dojoId: activeDojoId } });
      if ((res as any).error) throw new Error((res as any).error);
      return res;
    },
    onSuccess: () => {
      toast.success("Status refreshed");
      qc.invalidateQueries({ queryKey: ["dojo-stripe", activeDojoId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const openDashboard = useMutation({
    mutationFn: async () => {
      if (!activeDojoId) throw new Error("No active dojo");
      const res = await loginLink({ data: { dojoId: activeDojoId } });
      if (res.error || !res.url) throw new Error(res.error ?? "Could not open dashboard");
      return res.url;
    },
    onSuccess: (url) => window.open(url, "_blank"),
    onError: (e: Error) => toast.error(e.message),
  });
  const reconcileFn = useServerFn(reconcileDuesSubscriptions);
  const sweep = useMutation({
    mutationFn: async () => {
      if (!activeDojoId) throw new Error("No active dojo");
      return await reconcileFn({ data: { dojoId: activeDojoId } });
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not run the sweep"),
  });
  const cancelOrphanFn = useServerFn(cancelOrphanedSubscription);
  const stopBilling = useMutation({
    mutationFn: async (stripeSubscriptionId: string) => {
      if (!activeDojoId) throw new Error("No active dojo");
      return await cancelOrphanFn({ data: { dojoId: activeDojoId, stripeSubscriptionId } });
    },
    onSuccess: () => {
      toast.success("Stripe confirmed the subscription is cancelled.");
      sweep.mutate();
    },
    onError: (e: Error) => toast.error(e.message ?? "Stripe would not cancel it"),
  });
  const cancelStripeFn = useServerFn(cancelStripeDuesSubscription);
  const stopStripeBilling = useMutation({
    mutationFn: async (stripeSubscriptionId: string) => {
      if (!activeDojoId) throw new Error("No active dojo");
      return await cancelStripeFn({ data: { dojoId: activeDojoId, stripeSubscriptionId } });
    },
    onSuccess: () => {
      toast.success("Stripe confirmed the subscription is cancelled.");
      sweep.mutate();
    },
    onError: (e: Error) => toast.error(e.message ?? "Stripe would not cancel it"),
  });



  const backfill = useMutation({
    mutationFn: async () => {
      if (!activeDojoId) throw new Error("No active dojo");
      const fn = backfillInvoicesFromStripe;
      const res = await fn({ data: { dojoId: activeDojoId } });
      if ((res as any).error) throw new Error((res as any).error);
      return res as { inserted: number; scanned: number };
    },
    onSuccess: (r) => toast.success(`Backfilled ${r.inserted} invoice(s) from Stripe`),
    onError: (e: Error) => toast.error(e.message),
  });


  const connected = !!data?.stripe_account_id;
  const ready = !!data?.stripe_charges_enabled;

  // Auto-refresh status when returning from Stripe onboarding, or when we
  // have a connected account that isn't yet marked ready (mirror latest
  // Stripe state into our DB without requiring a manual click).
  const autoRefreshed = useRef(false);
  useEffect(() => {
    if (!activeDojoId || !connected || autoRefreshed.current) return;
    const params = new URLSearchParams(window.location.search);
    const justReturned = params.get("connect") === "return" || params.get("connect") === "refresh";
    if (justReturned || !ready) {
      autoRefreshed.current = true;
      refresh.mutate();
    }
  }, [activeDojoId, connected, ready]);

  // Live-update the UI as soon as the Stripe Connect webhook writes new
  // charges_enabled / details_submitted values to this dojo row.
  useEffect(() => {
    if (!activeDojoId) return;
    const channel = supabase
      .channel(`dojo-stripe-${activeDojoId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "dojos", filter: `id=eq.${activeDojoId}` },
        () => {
          // Stripe/billing columns are staff-only, so the realtime payload no
          // longer carries them — refetch through the guarded server function.
          const wasReady = ready;
          qc.invalidateQueries({ queryKey: ["dojo-stripe", activeDojoId] }).then(() => {
            const next = qc.getQueryData<DojoStripeRow | null>(["dojo-stripe", activeDojoId]);
            if (!wasReady && next?.stripe_charges_enabled) {
              toast.success("Stripe charges enabled — you're ready to accept payments.");
            }
          });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeDojoId, qc, ready]);



  return (
    <main>
      <PageHeader
        title="Payment setup"
        subtitle="Connect Stripe to accept membership payments from your athletes"
      />
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <Link
          to="/settings"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Back to settings
        </Link>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Stripe Connect
              {ready ? (
                <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
                  <CheckCircle2 className="mr-1 size-3" /> Charges enabled
                </Badge>
              ) : connected ? (
                <Badge variant="secondary">
                  <CircleDashed className="mr-1 size-3" /> Onboarding in progress
                </Badge>
              ) : (
                <Badge variant="outline">Not connected</Badge>
              )}
            </CardTitle>
            <CardDescription>
              Members pay your gym directly through Stripe. Sthenos's fee is {PLATFORM_FEE_PERCENT}%
              of each payment, and card processing is deducted before payout — as it would be
              with any card provider. The rest lands in your Stripe payouts.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : !connected ? (
              <>
                <p className="text-sm">
                  Set up an Express Stripe account in about 5 minutes. You'll
                  provide your business details, bank account, and identity to
                  Stripe — no card data ever touches Sthenos.
                </p>
                <Button disabled={!canEdit || start.isPending} onClick={() => start.mutate()}>
                  {start.isPending ? "Redirecting…" : "Connect Stripe"}
                </Button>
                {!canEdit && (
                  <p className="text-xs text-muted-foreground">
                    Only owners and admins can set up payments.
                  </p>
                )}
              </>
            ) : (
              <>
                <dl className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Details submitted</dt>
                    <dd className="font-medium">
                      {data?.stripe_details_submitted ? "Yes" : "No"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Charges enabled</dt>
                    <dd className="font-medium">{ready ? "Yes" : "No"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Country</dt>
                    <dd className="font-medium">
                      {(data?.stripe_account_country ?? data?.country)?.toUpperCase() ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Currency</dt>
                    <dd className="font-medium">
                      {(data?.default_currency ?? "usd").toUpperCase()}
                    </dd>
                  </div>
                </dl>

                {!ready && (
                  <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-100 p-3 text-sm text-amber-900">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <div>
                      Onboarding isn't complete yet. Finish the Stripe form to
                      start accepting payments.
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  {!ready && (
                    <Button
                      disabled={!canEdit || start.isPending}
                      onClick={() => start.mutate()}
                    >
                      {start.isPending ? "Redirecting…" : "Continue Stripe onboarding"}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    disabled={!canEdit || refresh.isPending}
                    onClick={() => refresh.mutate()}
                  >
                    {refresh.isPending ? "Checking…" : "Refresh status"}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!canEdit || openDashboard.isPending}
                    onClick={() => openDashboard.mutate()}
                  >
                    Open Stripe dashboard <ExternalLink className="ml-1 size-4" />
                  </Button>
                  {ready && (
                    <Button
                      variant="outline"
                      disabled={!canEdit || backfill.isPending}
                      onClick={() => backfill.mutate()}
                    >
                      {backfill.isPending ? "Backfilling…" : "Backfill invoices from Stripe"}
                    </Button>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <GymLocaleCard
          dojoId={activeDojoId}
          country={data?.country ?? null}
          currency={data?.default_currency ?? null}
          locked={!!data?.stripe_account_id}
          canEdit={canEdit}
        />

        {connected && <PaymentMethodsCard dojoId={activeDojoId} />}

        {isOwner && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Billing reconciliation sweep</CardTitle>
              <CardDescription>
                Checks every dues subscription against Stripe: members still charged after
                a cancellation, covered family members or cash payers who should not have a
                subscription at all, and families holding more than one. Nothing is
                cancelled until you press "Stop billing" on a row.
              </CardDescription>

            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                variant="outline"
                disabled={sweep.isPending}
                onClick={() => sweep.mutate()}
              >
                {sweep.isPending ? "Checking Stripe…" : "Run reconciliation sweep"}
              </Button>

              {sweep.data && (
                <div className="space-y-4 text-sm">
                  <div>
                    <p className="font-medium">
                      Orphaned subscriptions live on Stripe (
                      {sweep.data.stripeOrphans?.length ?? 0})
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Found by listing dues subscriptions on Stripe, so it also catches
                      subscriptions whose member was deleted from the app.
                    </p>
                    {(sweep.data.stripeOrphans?.length ?? 0) === 0 ? (
                      <p className="text-muted-foreground">
                        None — every live subscription on Stripe matches an active member.
                      </p>
                    ) : (
                      <ul className="mt-1 space-y-1">
                        {sweep.data.stripeOrphans.map((r) => (
                          <li
                            key={r.stripeSubscriptionId}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-destructive/10 px-3 py-2"
                          >
                            <span>
                              <span className="font-medium">
                                {r.memberName ?? r.customerEmail ?? "Unknown member"}
                              </span>{" "}
                              <span className="text-muted-foreground">
                                — {r.reason} · Stripe {r.stripeStatus}
                                {r.amountCents != null
                                  ? ` · ${(r.amountCents / 100).toFixed(2)} ${(r.currency ?? "").toUpperCase()}`
                                  : ""}
                                {r.customerEmail ? ` · ${r.customerEmail}` : ""} ·{" "}
                                {r.stripeSubscriptionId}
                              </span>
                            </span>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={stopStripeBilling.isPending}
                              onClick={() => stopStripeBilling.mutate(r.stripeSubscriptionId)}
                            >
                              Cancel this subscription
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div>

                    <p className="font-medium">
                      Subscriptions that should not exist ({sweep.data.orphans.length})
                    </p>
                    {sweep.data.orphans.length === 0 ? (
                      <p className="text-muted-foreground">
                        None — no covered member or cash payer holds a subscription.
                      </p>
                    ) : (
                      <ul className="mt-1 space-y-1">
                        {sweep.data.orphans.map((r) => (
                          <li
                            key={r.stripeSubscriptionId}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-100 px-3 py-2"
                          >
                            <span>
                              <span className="font-medium">{r.memberName}</span>{" "}
                              <span className="text-muted-foreground">
                                — {r.reason} · Stripe {r.stripeStatus}
                                {r.amountCents != null
                                  ? ` · ${(r.amountCents / 100).toFixed(2)} ${(r.currency ?? "").toUpperCase()}`
                                  : ""}{" "}
                                · {r.stripeSubscriptionId}
                              </span>
                            </span>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={stopBilling.isPending}
                              onClick={() => stopBilling.mutate(r.stripeSubscriptionId)}
                            >
                              Stop billing
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div>

                    <p className="font-medium">
                      Still billing after cancellation ({sweep.data.stillBilling.length})
                    </p>
                    {sweep.data.stillBilling.length === 0 ? (
                      <p className="text-muted-foreground">None — nobody is being charged after cancellation.</p>
                    ) : (
                      <ul className="mt-1 space-y-1">
                        {sweep.data.stillBilling.map((r) => (
                          <li
                            key={r.stripeSubscriptionId}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-100 px-3 py-2"
                          >
                            <span>
                              <span className="font-medium">{r.memberName}</span>{" "}
                              <span className="text-muted-foreground">
                                — local {r.localSubStatus}, Stripe {r.stripeStatus}
                                {r.amountCents != null
                                  ? ` · ${(r.amountCents / 100).toFixed(2)} ${(r.currency ?? "").toUpperCase()}`
                                  : ""}{" "}
                                · {r.stripeSubscriptionId}
                              </span>
                            </span>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={stopBilling.isPending}
                              onClick={() => stopBilling.mutate(r.stripeSubscriptionId)}
                            >
                              Stop billing
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div>
                    <p className="font-medium">
                      Marked live locally but gone in Stripe ({sweep.data.reverseDrift.length})
                    </p>
                    {sweep.data.reverseDrift.length === 0 ? (
                      <p className="text-muted-foreground">
                        None — every live local row has a live Stripe subscription.
                      </p>
                    ) : (
                      <ul className="mt-1 space-y-1">
                        {sweep.data.reverseDrift.map((r) => (
                          <li
                            key={r.stripeSubscriptionId}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-zinc-50 px-3 py-2"
                          >
                            <span>
                              <span className="font-medium">{r.memberName}</span>{" "}
                              <span className="text-muted-foreground">
                                — local {r.localSubStatus}, Stripe {r.stripeStatus} ·{" "}
                                {r.stripeSubscriptionId}
                              </span>
                            </span>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={stopBilling.isPending}
                              onClick={() => stopBilling.mutate(r.stripeSubscriptionId)}
                            >
                              Close local row
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>


                  <div>
                    <p className="font-medium">
                      Charge date doesn't match what the member was told (
                      {sweep.data.trialDateDrift.length})
                    </p>
                    {sweep.data.trialDateDrift.length === 0 ? (
                      <p className="text-muted-foreground">
                        None — every trialling member will be charged on the day they were
                        promised.
                      </p>
                    ) : (
                      <ul className="mt-1 space-y-1">
                        {sweep.data.trialDateDrift.map((t) => (
                          <li
                            key={t.stripeSubscriptionId}
                            className="rounded-md bg-amber-100 px-3 py-2"
                          >
                            <p className="font-medium">{t.memberName}</p>
                            <p className="text-muted-foreground">
                              Told{" "}
                              {t.promisedOn
                                ? new Date(t.promisedOn).toLocaleDateString()
                                : "nothing"}
                              , Stripe charges{" "}
                              {t.stripeChargesOn
                                ? new Date(t.stripeChargesOn).toLocaleDateString()
                                : "unknown"}
                              {t.daysApart != null
                                ? ` — ${Math.abs(t.daysApart)} day${
                                    Math.abs(t.daysApart) === 1 ? "" : "s"
                                  } ${t.daysApart > 0 ? "later" : "earlier"}`
                                : ""}
                              .
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div>
                    <p className="font-medium">
                      Members billed twice ({sweep.data.doubleBilledMembers.length})
                    </p>
                    {sweep.data.doubleBilledMembers.length === 0 ? (
                      <p className="text-muted-foreground">
                        None — nobody holds more than one subscription.
                      </p>
                    ) : (
                      <ul className="mt-1 space-y-1">
                        {sweep.data.doubleBilledMembers.map((m) => (
                          <li key={m.memberId} className="space-y-1 rounded-md bg-red-50 px-3 py-2">
                            <p>
                              <span className="font-medium">{m.memberName}</span>{" "}
                              <span className="text-muted-foreground">
                                holds {m.subscriptions.length} live subscriptions and will be
                                charged for each. Keep one and stop the rest.
                              </span>
                            </p>
                            {m.subscriptions.map((s) => (
                              <div
                                key={s.stripeSubscriptionId}
                                className="flex flex-wrap items-center justify-between gap-2"
                              >
                                <span className="text-muted-foreground">
                                  {s.stripeSubscriptionId} ({s.stripeStatus})
                                  {s.amountCents != null
                                    ? ` · ${(s.amountCents / 100).toFixed(2)}`
                                    : ""}
                                </span>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={stopBilling.isPending}
                                  onClick={() => stopBilling.mutate(s.stripeSubscriptionId)}
                                >
                                  Stop billing
                                </Button>
                              </div>
                            ))}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div>
                    <p className="font-medium">
                      Families with more than one live subscription ({sweep.data.doubleBilled.length})
                    </p>
                    {sweep.data.doubleBilled.length === 0 ? (
                      <p className="text-muted-foreground">None — every family has at most one subscription.</p>
                    ) : (
                      <ul className="mt-1 space-y-1">
                        {sweep.data.doubleBilled.map((f) => (
                          <li key={f.groupId} className="space-y-1 rounded-md bg-amber-100 px-3 py-2">
                            <p>
                              <span className="font-medium">{f.groupName ?? "Family"}</span>{" "}
                              <span className="text-muted-foreground">
                                (payer {f.payerName ?? "unset"}) — keep the payer's
                                subscription and stop the others.
                              </span>
                            </p>
                            {f.subscriptions.map((s) => (
                              <div
                                key={s.stripeSubscriptionId}
                                className="flex flex-wrap items-center justify-between gap-2"
                              >
                                <span className="text-muted-foreground">
                                  {s.memberName}: {s.stripeSubscriptionId} ({s.stripeStatus})
                                  {s.amountCents != null
                                    ? ` · ${(s.amountCents / 100).toFixed(2)}`
                                    : ""}
                                </span>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={stopBilling.isPending}
                                  onClick={() => stopBilling.mutate(s.stripeSubscriptionId)}
                                >
                                  Stop billing
                                </Button>
                              </div>
                            ))}
                          </li>
                        ))}
                      </ul>

                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}


        <Card>
          <CardHeader>
            <CardTitle className="text-base">Monthly billing day</CardTitle>
            <CardDescription>
              {data?.billing_mode === "anniversary"
                ? "Your gym bills on each member's own anniversary, so this day is not used for new monthly memberships — they are charged in full at signup and renew on that date each month."
                : `Monthly memberships renew on the ${ordinal(data?.billing_day_of_month ?? 1)} of each month, in your gym's own timezone. Days are capped at 28 so the date always exists. Members joining mid-month pay a part-month amount first.`}
              {" "}Annual plans are charged in full on the signup date and renew on
              that same date each year — they are never pro-rated. Existing members
              keep their current cycle; this applies to new signups.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-xs text-muted-foreground">Day of month</span>
              <select
                className="h-9 rounded-md border bg-background px-2 text-sm"
                disabled={!canEdit || savingSchedule}
                value={String(data?.billing_day_of_month ?? 1)}
                onChange={(e) =>
                  saveSchedule({
                    billingDayOfMonth: Number(e.target.value),
                    timezone: data?.timezone ?? "UTC",
                  })
                }
              >
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs text-muted-foreground">Timezone</span>
              <select
                className="h-9 rounded-md border bg-background px-2 text-sm"
                disabled={!canEdit || savingSchedule}
                value={data?.timezone ?? "UTC"}
                onChange={(e) =>
                  saveSchedule({
                    billingDayOfMonth: data?.billing_day_of_month ?? 1,
                    timezone: e.target.value,
                  })
                }
              >
                {COMMON_TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </label>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Who pays the platform fee?</CardTitle>
            <CardDescription>
              Sthenos's {PLATFORM_FEE_PERCENT}% fee comes out of your payout by default. Turn this
              on to add it to the price members pay instead. Card processing is deducted from your
              payout either way — this setting only decides who covers Sthenos's {PLATFORM_FEE_PERCENT}%.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 size-4 accent-brand"
                disabled={!canEdit}
                checked={!!data?.pass_platform_fee_to_members}
                onChange={async (e) => {
                  if (!activeDojoId) return;
                  const next = e.target.checked;
                  const { error } = await supabase
                    .from("dojos")
                    .update({ pass_platform_fee_to_members: next })
                    .eq("id", activeDojoId);
                  if (error) {
                    toast.error(error.message);
                    return;
                  }
                  toast.success(
                    next
                      ? `Members will now be charged an extra ${PLATFORM_FEE_PERCENT}% at checkout.`
                      : `You will absorb the ${PLATFORM_FEE_PERCENT}% platform fee.`,
                  );
                  qc.invalidateQueries({ queryKey: ["dojo-stripe", activeDojoId] });
                }}
              />
              <span className="text-sm">
                <span className="font-medium">
                  Pass the {PLATFORM_FEE_PERCENT}% platform fee to members
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {(() => {
                    const ex = payoutExample(data?.default_currency, true);
                    return `On a ${ex.price} plan, members pay ${ex.memberPays} and you receive ${ex.youReceive} after card processing of about ${ex.card}.`;
                  })()}
                </span>
              </span>
            </label>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">How it works</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              • Athletes pay through Stripe Checkout — Sthenos never stores
              card details.
            </p>
            <p>
              •{" "}
              {data?.billing_mode === "anniversary"
                ? "Monthly subscriptions are charged in full at signup and renew on that same date each month — no pro-rating."
                : `Monthly subscriptions renew on the ${ordinal(data?.billing_day_of_month ?? 1)} of each month; the first invoice is pro-rated (skipped when it would be below Stripe's minimum charge).`}{" "}
              Annual plans charge in full on the signup date and renew on that date
              each year.
            </p>
            <p>
              • Sthenos's fee is {PLATFORM_FEE_PERCENT}% of each successful charge — deducted from
              your payout, or added to the member's price when enabled above.
            </p>
            <p>
              • Card processing — about 1.5% plus a small fixed amount per payment, Stripe's
              standard European rate — is deducted from your payout, as with any card provider.
              Cards from outside Europe cost a little more.{" "}
              {(() => {
                const ex = payoutExample(
                  data?.default_currency,
                  !!data?.pass_platform_fee_to_members,
                );
                return `With your current settings, on a ${ex.price} plan you receive ${ex.youReceive}.`;
              })()}
            </p>
            <p>
              • Family plans charge one payer and cover their dependents
              automatically.
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
