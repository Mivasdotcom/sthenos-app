import { PLATFORM_FEE_PERCENT } from "@/lib/platform-fee";
import { PUBLIC_SITE_URL } from "@/lib/site";
import {
  MemberPaymentAction,
  useMemberBilling,
  type MemberBillingState,
} from "@/components/MemberPaymentAction";

import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { isCashPayer } from "@/lib/cash-payments";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { getRevenueSummary, formatMoney } from "@/lib/revenue.functions";
import { useState } from "react";
import { reconcileCancelledSubscriptions } from "@/lib/cancellation.functions";
import { EndMembershipDialog } from "@/components/EndMembershipDialog";
import { DisputeAlerts } from "@/components/DisputeAlerts";
import { RefundDialog } from "@/components/RefundDialog";
import { RouteErrorPanel } from "@/components/RouteErrorPanel";
import { CostsAndIncomePanel } from "@/components/CostsAndIncomePanel";
import { getMonthlyPnL } from "@/lib/finance.functions";

export const Route = createFileRoute("/billing")({
  head: () => ({
    meta: [
      { title: "Billing \u2014 Sthenos" },
      { name: "description", content: "Membership plans, invoices, and dojo revenue at a glance." },
      { property: "og:title", content: "Billing \u2014 Sthenos" },
      {
        property: "og:description",
        content: "Membership plans, invoices, and dojo revenue at a glance.",
      },
      { property: "og:url", content: `${PUBLIC_SITE_URL}/billing` },
      { name: "twitter:title", content: "Billing \u2014 Sthenos" },
      {
        name: "twitter:description",
        content: "Membership plans, invoices, and dojo revenue at a glance.",
      },
    ],
    links: [{ rel: "canonical", href: `${PUBLIC_SITE_URL}/billing` }],
  }),
  component: BillingPage,
  errorComponent: ({ error, reset }) => (
    <RouteErrorPanel error={error} reset={reset} title="Billing didn't load" />
  ),
});

type InvoiceStatus = "paid" | "due" | "overdue" | "void" | "partially_refunded" | "refunded";

type InvoiceRow = {
  id: string;
  member_id: string | null;
  amount_cents: number;
  currency: string | null;
  plan: string | null;
  status: InvoiceStatus;
  due_date: string | null;
  paid_at: string | null;
  refunded_amount_cents?: number | null;
  members: { name: string } | null;
  method: "card" | "cash";
};

function BillingPage() {
  const { isStaff } = useAuth();
  return isStaff ? <StaffBilling /> : <MemberBilling />;
}

function formatCurrency(cents: number, currency?: string | null, fallback: string = "usd") {
  const cur = (currency || fallback || "usd").toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(
      cents / 100,
    );
  } catch {
    return `${cur} ${(cents / 100).toLocaleString()}`;
  }
}

function StaffBilling() {
  const { activeDojoId, activeDojo } = useCurrentDojo();
  const dojoDefault = activeDojo?.defaultCurrency ?? null;
  const revFn = useServerFn(getRevenueSummary);

  const revQ = useQuery({
    queryKey: ["billing-revenue-summary", activeDojoId],
    enabled: !!activeDojoId,
    queryFn: () => revFn({ data: { dojoId: activeDojoId! } }),
  });

  // The same monthly profit-and-loss the dashboard card reads, so the net
  // figure here and the chart there can never tell different stories.
  const pnlFn = useServerFn(getMonthlyPnL);
  const pnlQ = useQuery({
    queryKey: ["pnl", activeDojoId, 1],
    enabled: !!activeDojoId,
    queryFn: () => pnlFn({ data: { dojoId: activeDojoId!, months: 1 } }),
  });
  const thisMonthPnl = (pnlQ.data?.points ?? []).at(-1) ?? null;

  const invoicesQ = useQuery({
    queryKey: ["invoices", activeDojoId],
    enabled: !!activeDojoId,
    queryFn: async () => {
      const [cardRes, cashRes] = await Promise.all([
        supabase
          .from("invoices")
          .select(
            "id, member_id, amount_cents, currency, plan, status, due_date, paid_at, refunded_amount_cents, members(name)",
          )
          .eq("dojo_id", activeDojoId!),
        supabase
          .from("cash_payments")
          .select(
            "id,member_id,amount_cents,currency,paid_on,note,members(name,dojo_plans:selected_plan_id(name))",
          )
          .eq("dojo_id", activeDojoId!),
      ]);
      if (cardRes.error) throw cardRes.error;
      if (cashRes.error) throw cashRes.error;
      const cardRows = (cardRes.data ?? []).map((row) => ({ ...row, method: "card" as const }));
      const cashRows = (cashRes.data ?? []).map((row: any) => ({
        id: row.id,
        member_id: row.member_id,
        amount_cents: row.amount_cents,
        currency: row.currency,
        plan: row.members?.dojo_plans?.name ?? row.note ?? "Cash payment",
        status: "paid" as const,
        due_date: row.paid_on,
        paid_at: `${row.paid_on}T00:00:00Z`,
        refunded_amount_cents: null,
        members: row.members ? { name: row.members.name } : null,
        method: "cash" as const,
      }));
      return [...cardRows, ...cashRows].sort((a, b) =>
        (b.paid_at ?? b.due_date ?? "").localeCompare(a.paid_at ?? a.due_date ?? ""),
      ) as InvoiceRow[];
    },
  });

  const isLoading = invoicesQ.isLoading || revQ.isLoading;
  const isError = invoicesQ.isError || revQ.isError;
  const invoices = invoicesQ.data ?? [];
  const rev = revQ.data;
  const primary = rev?.currencies[0] ?? null;
  const netCurrency = primary?.currency ?? rev?.defaultCurrency ?? dojoDefault ?? "usd";
  const hasPayments = !!rev?.hasAnyPaymentData;

  const now = new Date();

  return (
    <main>
      <PageHeader
        title="Billing & Finance"
        subtitle={now.toLocaleString(undefined, { month: "long", year: "numeric" })}
        actions={
          <Button size="sm" variant="outline">
            <Download className="size-4" /> Export CSV
          </Button>
        }
      />

      <div className="mx-auto max-w-7xl space-y-8 p-8">
        <DisputeAlerts dojoId={activeDojoId ?? null} />

        <StillBillingPanel dojoId={activeDojoId ?? null} />

        {isError ? (
          <ErrorState />
        ) : isLoading ? (
          <LoadingState />
        ) : !hasPayments ? (
          <div className="rounded-xl bg-card p-8 text-center text-sm text-muted-foreground ring-1 ring-black/5">
            <div className="font-medium text-foreground">No payments yet</div>
            <div className="mt-1">
              Connect Stripe and start receiving payments to see collected revenue, overdue, LTV,
              and revenue by plan.
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
              <StatCard
                label="Collected this month"
                value={formatMoney(
                  primary?.revenueThisMonthCents ?? 0,
                  primary?.currency ?? rev?.defaultCurrency ?? dojoDefault ?? "usd",
                )}
                trend={`Last: ${formatMoney(primary?.revenueLastMonthCents ?? 0, primary?.currency ?? rev?.defaultCurrency ?? dojoDefault ?? "usd")}`}
                kind="up"
              />
              <StatCard
                label="Monthly membership revenue"
                value={formatMoney(
                  primary?.mrrCents ?? 0,
                  primary?.currency ?? rev?.defaultCurrency ?? dojoDefault ?? "usd",
                )}
                trend={`Yearly ${formatMoney(primary?.arrCents ?? 0, primary?.currency ?? rev?.defaultCurrency ?? dojoDefault ?? "usd")}`}
              />
              <StatCard
                label="Outstanding this month"
                value={formatMoney(
                  primary?.outstandingThisMonthCents ?? 0,
                  primary?.currency ?? rev?.defaultCurrency ?? dojoDefault ?? "usd",
                )}
                trend={
                  (primary?.overdueCount ?? 0) > 0
                    ? `Owed · ${primary?.overdueCount ?? 0} overdue invoice${(primary?.overdueCount ?? 0) === 1 ? "" : "s"}`
                    : "Owed this month"
                }
                kind="alert"
              />
              <StatCard
                label="Avg LTV"
                value={formatMoney(
                  primary?.ltvCents ?? 0,
                  primary?.currency ?? rev?.defaultCurrency ?? dojoDefault ?? "usd",
                )}
                trend={`${primary?.payingMembers ?? 0} paying ${(primary?.payingMembers ?? 0) === 1 ? "member" : "members"}`}
              />
            </div>

            {rev && rev.currencies.length > 1 && (
              <div className="rounded-xl bg-card p-5 ring-1 ring-black/5">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Revenue by currency
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {rev.currencies.map((b) => (
                    <div key={b.currency} className="rounded border border-border p-3 text-xs">
                      <div className="font-semibold uppercase tracking-wider text-muted-foreground">
                        {b.currency.toUpperCase()}
                      </div>
                      <div className="mt-1">Monthly {formatMoney(b.mrrCents, b.currency)}</div>
                      <div className="text-muted-foreground">
                        Overdue {formatMoney(b.overdueCents, b.currency)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {primary && primary.revenueByPlan.length > 0 && (
              <section className="space-y-3">
                <h2 className="font-display text-xl font-medium">Revenue by plan</h2>
                <div className="overflow-hidden rounded-xl bg-card ring-1 ring-black/5">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-zinc-950/5 bg-zinc-50/50 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        <th className="px-6 py-3">Plan</th>
                        <th className="px-6 py-3 text-right">Lifetime revenue</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-950/5">
                      {primary.revenueByPlan.map((p) => (
                        <tr key={p.plan}>
                          <td className="px-6 py-3 text-sm">{p.plan}</td>
                          <td className="px-6 py-3 text-right text-sm tabular-nums">
                            {formatMoney(p.cents, primary.currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <section className="space-y-4">
              <h2 className="font-display text-xl font-medium">Recent payments</h2>
              {invoices.length === 0 ? (
                <div className="rounded-xl bg-card p-6 text-sm text-muted-foreground ring-1 ring-black/5">
                  No payments yet.
                </div>
              ) : (
                <InvoiceTable
                  rows={invoices}
                  showMember
                  dojoDefaultCurrency={rev?.defaultCurrency ?? dojoDefault ?? null}
                  refundDojoId={activeDojoId ?? null}
                />
              )}
            </section>

          </>
        )}

        {/* What the gym actually kept. Shown once there are costs to subtract,
            whether or not a payment has ever been taken -- a gym that has
            recorded rent and taken nothing is down by the rent, and should be
            told so. With no costs it would restate "collected this month"
            under a second name, which is worse than showing nothing. The
            figures come from the same monthly P&L as the dashboard's chart, so
            the two can never disagree. */}
        {thisMonthPnl && thisMonthPnl.overhead_cents > 0 && (
          <div className="rounded-xl bg-card p-5 ring-1 ring-black/5">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Net this month
                </div>
                <div
                  className={`mt-1 font-display text-3xl font-medium tabular-nums ${
                    thisMonthPnl.net_cents < 0 ? "text-destructive" : ""
                  }`}
                >
                  {formatMoney(thisMonthPnl.net_cents, netCurrency)}
                </div>
              </div>
              <div className="text-sm text-muted-foreground">
                <span className="tabular-nums text-foreground">
                  {formatMoney(thisMonthPnl.revenue_cents, netCurrency)}
                </span>{" "}
                in, less{" "}
                <span className="tabular-nums text-foreground">
                  {formatMoney(thisMonthPnl.overhead_cents, netCurrency)}
                </span>{" "}
                of costs
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Money in includes cash and anything recorded under other income. Costs are this
              month's share of what you've entered below, with yearly ones spread across the
              year.
            </p>
          </div>
        )}

        {/* Costs and income that never went through Stripe. Outside the
            payments branch on purpose: a gym that has taken no payments yet
            still has rent to record, and is the most likely to be sitting
            down with its numbers. Inside it, the one section that doesn't
            depend on Stripe was hidden behind having used Stripe. */}
        {activeDojoId && (
          <section className="space-y-4">
            <div>
              <h2 className="font-display text-xl font-medium">Costs &amp; other income</h2>
              <p className="text-sm text-muted-foreground">
                Rent, mats, insurance — and money taken outside Sthenos, like seminars or kit.
                {hasPayments
                  ? " Recorded here, they turn the figures above into a profit."
                  : " You can record these before you take your first payment."}
              </p>
            </div>
            <CostsAndIncomePanel dojoId={activeDojoId} />
          </section>
        )}
      </div>
    </main>
  );
}

function MemberBilling() {
  const { user } = useAuth();
  const { activeDojoId, activeDojo } = useCurrentDojo();
  const dojoDefault = activeDojo?.defaultCurrency ?? null;

  const memberQ = useQuery({
    queryKey: ["my-member", activeDojoId, user?.id],
    enabled: !!activeDojoId && !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("members")
        .select("id, name, plan, discipline, payment_method")
        .eq("user_id", user!.id)
        .eq("dojo_id", activeDojoId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const memberId = memberQ.data?.id;
  const billingQ = useMemberBilling(memberId, activeDojoId);

  const invoicesQ = useQuery({
    queryKey: ["my-invoices", memberId],
    enabled: !!memberId,
    queryFn: async () => {
      const [cardRes, cashRes] = await Promise.all([
        supabase
          .from("invoices")
          .select(
            "id, member_id, amount_cents, currency, plan, status, due_date, paid_at, members(name)",
          )
          .eq("member_id", memberId!),
        supabase
          .from("cash_payments")
          .select(
            "id,member_id,amount_cents,currency,paid_on,note,members(name,dojo_plans:selected_plan_id(name))",
          )
          .eq("member_id", memberId!),
      ]);
      if (cardRes.error) throw cardRes.error;
      if (cashRes.error) throw cashRes.error;
      const cardRows = (cardRes.data ?? []).map((row) => ({ ...row, method: "card" as const }));
      const cashRows = (cashRes.data ?? []).map((row: any) => ({
        id: row.id,
        member_id: row.member_id,
        amount_cents: row.amount_cents,
        currency: row.currency,
        plan: row.members?.dojo_plans?.name ?? row.note ?? "Cash payment",
        status: "paid" as const,
        due_date: row.paid_on,
        paid_at: `${row.paid_on}T00:00:00Z`,
        members: row.members ? { name: row.members.name } : null,
        method: "cash" as const,
      }));
      return [...cardRows, ...cashRows].sort((a, b) =>
        (b.paid_at ?? b.due_date ?? "").localeCompare(a.paid_at ?? a.due_date ?? ""),
      ) as InvoiceRow[];
    },
  });

  const isLoading =
    memberQ.isLoading || (!!memberId && (invoicesQ.isLoading || billingQ.isLoading));
  const isError = memberQ.isError || invoicesQ.isError;

  return (
    <main>
      <PageHeader
        title="My Billing"
        subtitle={memberQ.data ? `${memberQ.data.plan} plan · ${memberQ.data.discipline}` : ""}
        actions={
          isCashPayer(memberQ.data?.payment_method) ? null : (
            <MemberPaymentAction
              memberId={memberId}
              dojoId={activeDojoId}
              billing={billingQ.data}
              returnPath="/billing"
            />
          )
        }
      />

      <div className="mx-auto max-w-5xl space-y-8 p-8">
        {isError ? (
          <ErrorState />
        ) : isLoading ? (
          <LoadingState />
        ) : !memberQ.data ? (
          <div className="rounded-xl bg-card p-6 text-sm text-muted-foreground ring-1 ring-black/5">
            No billing history found for your account.
          </div>
        ) : (
          <MemberBillingContent
            memberName={memberQ.data.name}
            memberPlan={memberQ.data.plan}
            isCash={isCashPayer(memberQ.data.payment_method)}
            invoices={invoicesQ.data ?? []}
            dojoDefaultCurrency={dojoDefault}
            billing={billingQ.data ?? null}
            action={
              <MemberPaymentAction
                memberId={memberId}
                dojoId={activeDojoId}
                billing={billingQ.data}
                returnPath="/billing"
              />
            }
          />
        )}
      </div>
    </main>
  );
}

function MemberBillingContent({
  memberPlan,
  isCash,
  invoices,
  dojoDefaultCurrency,
  billing,
  action,
}: {
  memberName: string;
  memberPlan: string;
  isCash: boolean;
  invoices: InvoiceRow[];
  dojoDefaultCurrency: string | null;
  billing: MemberBillingState | null;
  action: React.ReactNode;
}) {
  const year = new Date().getFullYear();
  const currency = billing?.planCurrency ?? invoices[0]?.currency ?? dojoDefaultCurrency ?? "usd";

  const paidThisYearCents = invoices
    .filter((i) => i.status === "paid" && i.paid_at && new Date(i.paid_at).getFullYear() === year)
    .reduce((s, i) => s + (i.amount_cents ?? 0), 0);
  const outstandingCents = invoices
    .filter((i) => i.status !== "paid")
    .reduce((s, i) => s + (i.amount_cents ?? 0), 0);
  const paidInvoices = invoices.filter((i) => i.status === "paid");
  const lastPaid = [...paidInvoices].sort((a, b) =>
    (b.paid_at ?? "").localeCompare(a.paid_at ?? ""),
  )[0];

  // Cash members are judged on whether their cash payments are up to date —
  // never on the absence of a Stripe subscription.
  const hasSub = !!billing?.hasActiveSubscription || isCash;
  const planName = billing?.planName ?? memberPlan;
  const priceCents = billing?.planPriceCents ?? lastPaid?.amount_cents ?? 0;
  // What Stripe will actually bill next: plan price plus the platform fee when
  // the gym passes it through. Never show the base price as the amount payable.
  const chargeCents = billing?.nextChargeCents ?? priceCents;
  const passFee = !!billing?.passPlatformFee;
  const intervalLabel =
    billing?.planInterval === "year" ? "/yr" : billing?.planInterval === "one_time" ? "" : "/mo";
  const nextDate = billing?.subscription?.current_period_end
    ? new Date(billing.subscription.current_period_end).toLocaleDateString()
    : nextBillingDate(lastPaid?.paid_at ?? null);

  return (
    <>
      {!hasSub && !isCash && (
        <div className="flex flex-col gap-3 rounded-xl border border-amber-500/30 bg-amber-100/60 p-5 sm:flex-row sm:items-center sm:justify-between dark:bg-amber-950/20">
          <div>
            <div className="font-display text-base font-medium">Payment not set up</div>
            <p className="text-sm text-muted-foreground">
              {billing?.planId
                ? `Add a card to start your ${planName} membership.`
                : "Your gym hasn't assigned you a plan yet."}
            </p>
          </div>
          {action}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard
          label="Current Plan"
          value={planName ?? "No plan"}
          trend={
            priceCents
              ? `${formatCurrency(chargeCents, currency)}${intervalLabel}${passFee ? ` (incl. ${PLATFORM_FEE_PERCENT}% platform fee)` : ""}`
              : "No price set"
          }
        />
        <StatCard
          label={outstandingCents > 0 ? "You owe" : hasSub ? "Next charge" : "Status"}
          value={
            outstandingCents > 0
              ? formatCurrency(outstandingCents, currency)
              : hasSub
                ? formatCurrency(chargeCents, currency)
                : "Not set up"
          }
          trend={
            outstandingCents > 0
              ? "Please settle to avoid interruption"
              : hasSub
                ? `Scheduled ${nextDate}${passFee ? ` · incl. ${PLATFORM_FEE_PERCENT}% platform fee` : ""}`
                : "No active subscription"
          }
          kind={outstandingCents > 0 || !hasSub ? "alert" : "neutral"}
        />
        <StatCard
          label={`Paid in ${year}`}
          value={formatCurrency(paidThisYearCents, currency)}
          trend={`${paidInvoices.length} invoices`}
          kind="up"
        />
      </div>

      <section className="space-y-4">
        <h2 className="font-display text-xl font-medium">My payment history</h2>
        {invoices.length === 0 ? (
          <div className="rounded-xl bg-card p-6 text-sm text-muted-foreground ring-1 ring-black/5">
            No payments yet.
          </div>
        ) : (
          <InvoiceTable rows={invoices} dojoDefaultCurrency={dojoDefaultCurrency} />
        )}
      </section>
    </>
  );
}

function nextBillingDate(lastPaid: string | null) {
  if (!lastPaid) return "—";
  const d = new Date(lastPaid);
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

function InvoiceTable({
  rows,
  showMember = false,
  dojoDefaultCurrency = null,
  refundDojoId = null,
}: {
  rows: InvoiceRow[];
  showMember?: boolean;
  dojoDefaultCurrency?: string | null;
  /** When set, staff get a Refund action on refundable invoices. */
  refundDojoId?: string | null;
}) {
  const [refundTarget, setRefundTarget] = useState<string | null>(null);
  return (
    <div className="overflow-hidden rounded-xl bg-card ring-1 ring-black/5">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-zinc-950/5 bg-zinc-50/50">
            <th className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Payment
            </th>
            {showMember && (
              <th className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Member
              </th>
            )}
            <th className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Plan
            </th>
            <th className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Date
            </th>
            <th className="px-6 py-3 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Amount
            </th>
            <th className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Status
            </th>
            <th className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Method
            </th>
            {refundDojoId && <th className="px-6 py-3" />}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-950/5">
          {rows.map((inv) => {
            const date = inv.paid_at?.slice(0, 10) ?? inv.due_date ?? "—";
            return (
              <tr key={inv.id} className="transition-colors hover:bg-zinc-50/40">
                <td className="px-6 py-3 font-mono text-xs text-muted-foreground">
                  {inv.id.slice(0, 8).toUpperCase()}
                </td>
                {showMember && (
                  <td className="px-6 py-3 text-sm font-medium">{inv.members?.name ?? "—"}</td>
                )}
                <td className="px-6 py-3 text-sm text-zinc-600">{inv.plan ?? "—"}</td>
                <td className="px-6 py-3 text-sm text-muted-foreground">{date}</td>
                <td className="px-6 py-3 text-right text-sm font-medium tabular-nums">
                  {formatCurrency(
                    inv.amount_cents ?? 0,
                    inv.currency,
                    dojoDefaultCurrency ?? "usd",
                  )}
                </td>
                <td className="px-6 py-3">
                  <StatusPill status={inv.status} />
                  {(inv.refunded_amount_cents ?? 0) > 0 && (
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      {formatCurrency(
                        inv.refunded_amount_cents ?? 0,
                        inv.currency,
                        dojoDefaultCurrency ?? "usd",
                      )}{" "}
                      refunded
                    </div>
                  )}
                </td>
                <td className="px-6 py-3 text-xs font-medium">
                  {inv.method === "cash" ? "Cash" : "Card"}
                </td>
                {refundDojoId && (
                  <td className="px-6 py-3 text-right">
                    {inv.method === "card" &&
                    (inv.status === "paid" || inv.status === "partially_refunded") ? (
                      <Button size="sm" variant="outline" onClick={() => setRefundTarget(inv.id)}>
                        Refund
                      </Button>
                    ) : null}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <RefundDialog
        open={!!refundTarget}
        onOpenChange={(o) => !o && setRefundTarget(null)}
        dojoId={refundDojoId}
        invoiceId={refundTarget}
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  trend,
  kind = "neutral",
}: {
  label: string;
  value: string;
  trend: string;
  kind?: "up" | "alert" | "neutral";
}) {
  const color =
    kind === "up"
      ? "text-emerald-600"
      : kind === "alert"
        ? "text-destructive"
        : "text-muted-foreground";
  return (
    <div className="rounded-xl bg-card p-5 ring-1 ring-black/5">
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="mt-1 font-display text-3xl font-medium tabular-nums">{value}</div>
      <div className={`mt-2 text-[11px] font-medium ${color}`}>{trend}</div>
    </div>
  );
}

function StatusPill({ status }: { status: InvoiceStatus }) {
  const map: Record<InvoiceStatus, string> = {
    paid: "bg-emerald-50 text-emerald-700 ring-emerald-500/20",
    due: "bg-amber-100 text-amber-700 ring-amber-500/20",
    overdue: "bg-red-50 text-red-700 ring-red-500/20",
    void: "bg-zinc-100 text-zinc-600 ring-zinc-500/20",
    partially_refunded: "bg-violet-50 text-violet-700 ring-violet-500/20",
    refunded: "bg-zinc-100 text-zinc-700 ring-zinc-500/20",
  };
  return (
    <span
      className={cn(
        "rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset",
        map[status] ?? map.due,
      )}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-zinc-100 ring-1 ring-black/5" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-xl bg-zinc-100 ring-1 ring-black/5" />
    </div>
  );
}

function ErrorState() {
  return (
    <div className="rounded-xl bg-card p-6 text-sm text-muted-foreground ring-1 ring-black/5">
      Couldn't load billing data. Please try again.
    </div>
  );
}

/**
 * Safety net: members marked lapsed locally who still have a live subscription.
 * Ex-members being charged is the worst possible billing failure, so staff get
 * a one-click way to find and stop them.
 */
function StillBillingPanel({ dojoId }: { dojoId: string | null }) {
  const reconcileFn = useServerFn(reconcileCancelledSubscriptions);
  const [ran, setRan] = useState(false);
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  const q = useQuery({
    queryKey: ["cancellation-reconciliation", dojoId],
    enabled: !!dojoId && ran,
    queryFn: () => reconcileFn({ data: { dojoId: dojoId! } }),
  });
  const rows = q.data?.rows ?? [];

  return (
    <div className="rounded-xl bg-card p-5 ring-1 ring-black/5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-medium">Still being billed after cancelling</div>
          <div className="text-sm text-muted-foreground">
            Checks for members marked lapsed who still have a live subscription in Stripe.
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => setRan(true)} disabled={q.isFetching}>
          {q.isFetching ? "Checking…" : ran ? "Re-check" : "Run check"}
        </Button>
      </div>

      {q.isError && <p className="mt-3 text-sm text-destructive">{(q.error as Error).message}</p>}

      {ran &&
        !q.isFetching &&
        !q.isError &&
        (rows.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            All clear — no cancelled members are still being billed.
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {rows.map((r) => (
              <li
                key={r.memberId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-destructive/5 p-3 text-sm ring-1 ring-destructive/20"
              >
                <div>
                  <div className="font-medium">{r.name}</div>
                  <div className="text-xs text-muted-foreground">
                    Local: {r.localStatus} · subscription: {r.stripeStatus ?? r.localSubStatus}
                    {r.stripeSubscriptionId ? ` · ${r.stripeSubscriptionId}` : ""}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => setTarget({ id: r.memberId, name: r.name })}
                >
                  Stop billing
                </Button>
              </li>
            ))}
          </ul>
        ))}

      <EndMembershipDialog
        open={!!target}
        onOpenChange={(o) => !o && setTarget(null)}
        dojoId={dojoId}
        member={target}
        source="billing reconciliation"
        onDone={() => {
          setTarget(null);
          void q.refetch();
        }}
      />
    </div>
  );
}
