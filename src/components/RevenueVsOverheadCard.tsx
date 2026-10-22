import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getMonthlyPnL } from "@/lib/finance.functions";
import { getRevenueSummary, formatMoney } from "@/lib/revenue.functions";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { ArrowRight } from "lucide-react";

function formatMonthLabel(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString(undefined, {
    month: "short",
  });
}

export function RevenueVsOverheadCard() {
  const { activeDojoId } = useCurrentDojo();
  const pnlFn = useServerFn(getMonthlyPnL);
  const revFn = useServerFn(getRevenueSummary);

  const { data: pnl, isLoading: pnlLoading } = useQuery({
    queryKey: ["pnl", activeDojoId, 6],
    queryFn: () => pnlFn({ data: { dojoId: activeDojoId!, months: 6 } }),
    enabled: !!activeDojoId,
  });

  const { data: rev, isLoading: revLoading } = useQuery({
    queryKey: ["revenue-summary", activeDojoId],
    queryFn: () => revFn({ data: { dojoId: activeDojoId! } }),
    enabled: !!activeDojoId,
  });

  const isLoading = pnlLoading || revLoading;
  const primaryBucket = rev?.currencies[0] ?? null;
  const currency = primaryBucket?.currency ?? rev?.defaultCurrency ?? "usd";

  // Merge overheads (from PnL) with revenue (from getRevenueSummary primary bucket)
  const overheadByMonth = new Map<string, number>(
    (pnl?.points ?? []).map((p) => [p.month, p.overhead_cents]),
  );
  const revenueMonths = primaryBucket?.revenueByMonth.slice(-6) ?? [];
  const chartData = revenueMonths.map((r) => ({
    month: formatMonthLabel(r.month),
    Revenue: r.cents / 100,
    Overheads: (overheadByMonth.get(r.month) ?? 0) / 100,
  }));

  const currentMonth = revenueMonths[revenueMonths.length - 1];
  const currentRevenueCents = currentMonth?.cents ?? 0;
  const currentOverheadCents = currentMonth
    ? overheadByMonth.get(currentMonth.month) ?? 0
    : 0;
  const net = currentRevenueCents - currentOverheadCents;
  const netColor =
    net > 0 ? "text-emerald-600" : net < 0 ? "text-red-600" : "text-muted-foreground";

  const hasData = !!rev?.hasAnyPaymentData && chartData.length > 0;

  return (
    <div className="rounded-xl bg-card p-5 ring-1 ring-border">
      <div className="flex items-start justify-between">
        <div>
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Revenue vs Overheads
          </span>
          <div className="mt-1 font-display text-2xl font-medium tabular-nums">
            {isLoading
              ? "—"
              : hasData
                ? formatMoney(currentRevenueCents, currency)
                : "No payments yet"}
            {hasData && (
              <span className="ml-2 text-sm text-muted-foreground">
                · {formatMoney(currentOverheadCents, currency)} costs
              </span>
            )}
          </div>
          <div className={`mt-1 text-sm font-medium ${netColor}`}>
            {hasData ? `Net ${formatMoney(net, currency)}` : "Connect Stripe & receive payments to see revenue."}
          </div>
          {rev && rev.currencies.length > 1 && (
            <div className="mt-1 text-[11px] text-muted-foreground">
              Showing {currency.toUpperCase()} · other currencies tracked separately
            </div>
          )}
        </div>
        <Link
          to="/billing"
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Manage <ArrowRight className="inline size-3" />
        </Link>
      </div>

      <div className="mt-4 h-24">
        {hasData && (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} barCategoryGap={8}>
              <XAxis
                dataKey="month"
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis hide />
              <Tooltip
                cursor={{ fill: "transparent" }}
                contentStyle={{
                  fontSize: 12,
                  borderRadius: 6,
                  border: "1px solid hsl(var(--border))",
                }}
                formatter={(v: number) =>
                  v.toLocaleString(undefined, {
                    style: "currency",
                    currency: currency.toUpperCase(),
                    maximumFractionDigits: 0,
                  })
                }
              />
              <Bar dataKey="Revenue" fill="var(--brand)" radius={[3, 3, 0, 0]} />
              <Bar dataKey="Overheads" fill="#a1a1aa" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
