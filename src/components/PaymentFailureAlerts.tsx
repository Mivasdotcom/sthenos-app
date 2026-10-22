import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CreditCard, MailCheck, MailWarning } from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";

import { supabase } from "@/integrations/supabase/client";
import { paymentMethodShortLabel } from "@/lib/payment-methods";
import { cn } from "@/lib/utils";

export type DunningRow = {
  id: string;
  member_id: string;
  stripe_invoice_id: string;
  stage: "first" | "reminder" | "final" | "recovered";
  amount_cents: number;
  currency: string;
  payment_method: string | null;
  first_failed_at: string;
  emailed: boolean;
  send_error: string | null;
  members: { name: string } | null;
};

const STAGE_LABEL: Record<string, string> = {
  first: "First notice sent",
  reminder: "Reminder sent",
  final: "Final notice sent",
};

function money(cents: number, currency: string) {
  const cur = (currency || "usd").toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(cents / 100);
  } catch {
    return `${cur} ${(cents / 100).toFixed(2)}`;
  }
}

/**
 * Open payment failures for a gym, newest first. Only unresolved cases — a
 * recovered payment disappears from staff surfaces the same way it stops the
 * member's emails.
 */
export function useOpenPaymentFailures(dojoId: string | null, memberId?: string | null) {
  return useQuery({
    queryKey: ["dunning-open", dojoId, memberId ?? "all"],
    enabled: !!dojoId,
    queryFn: async () => {
      let q = supabase
        .from("dunning_notices")
        .select(
          "id, member_id, stripe_invoice_id, stage, amount_cents, currency, payment_method, first_failed_at, emailed, send_error, members(name)",
        )
        .eq("dojo_id", dojoId!)
        .is("resolved_at", null)
        .neq("stage", "recovered")
        .order("first_failed_at", { ascending: false });
      if (memberId) q = q.eq("member_id", memberId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as DunningRow[];
    },
  });
}

/** One entry per member with an open failure — the latest stage reached. */
export function useFailedPaymentsByMember(dojoId: string | null) {
  const { data } = useOpenPaymentFailures(dojoId);
  const map = new Map<string, DunningRow>();
  for (const row of data ?? []) {
    if (!map.has(row.member_id)) map.set(row.member_id, row);
  }
  return map;
}

/** Compact "payment failed" badge for the members list. */
export function PaymentFailedBadge({ row }: { row: DunningRow }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive"
      title={`${paymentMethodShortLabel(row.payment_method)} payment of ${money(
        row.amount_cents,
        row.currency,
      )} failed ${formatDistanceToNowStrict(new Date(row.first_failed_at))} ago · ${
        STAGE_LABEL[row.stage] ?? "notice sent"
      }`}
    >
      <CreditCard className="size-3" /> Payment failed
    </span>
  );
}

/**
 * Dashboard alert for failed payments. Staff see this BEFORE the member turns
 * up at the desk, which is the whole point — a failed collection is a
 * conversation, not an ambush.
 */
export function PaymentFailureAlerts({
  dojoId,
  className,
}: {
  dojoId: string | null;
  className?: string;
}) {
  const { data } = useOpenPaymentFailures(dojoId);
  const rows = data ?? [];
  // One row per member, latest stage first.
  const byMember = new Map<string, DunningRow>();
  for (const r of rows) if (!byMember.has(r.member_id)) byMember.set(r.member_id, r);
  const cases = [...byMember.values()];
  if (cases.length === 0) return null;

  return (
    <section
      className={cn("rounded-xl border border-amber-500/50 bg-amber-500/5 p-5", className)}
      aria-live="polite"
    >
      <div className="flex items-center gap-2 text-amber-700">
        <CreditCard className="size-5" />
        <h2 className="font-display text-base font-semibold">
          {cases.length === 1 ? "1 payment failed" : `${cases.length} payments failed`}
        </h2>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        These members have been emailed a link to fix it themselves. Worth a friendly word before
        their next class.
      </p>
      <ul className="mt-4 space-y-2">
        {cases.map((c) => (
          <li
            key={c.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-card p-3 text-sm ring-1 ring-amber-500/20"
          >
            <div>
              <div className="font-medium">
                {c.members?.name ?? "Member"} · {money(c.amount_cents, c.currency)}
              </div>
              <div className="text-xs text-muted-foreground">
                {paymentMethodShortLabel(c.payment_method)} ·{" "}
                {formatDistanceToNowStrict(new Date(c.first_failed_at))} ago ·{" "}
                <span className="inline-flex items-center gap-1">
                  {c.emailed ? (
                    <>
                      <MailCheck className="size-3 text-emerald-600" />
                      {STAGE_LABEL[c.stage] ?? "Notice sent"}
                    </>
                  ) : (
                    <>
                      <MailWarning className="size-3 text-destructive" />
                      Email not delivered{c.send_error ? ` — ${c.send_error}` : ""}
                    </>
                  )}
                </span>
              </div>
            </div>
            <Link
              to="/members/$memberId"
              params={{ memberId: c.member_id }}
              className="inline-flex items-center gap-1 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
            >
              Open member
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
