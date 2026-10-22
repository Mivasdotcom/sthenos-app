import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";

import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

export type DisputeRow = {
  id: string;
  stripe_dispute_id: string;
  member_id: string | null;
  invoice_id: string | null;
  amount_cents: number;
  currency: string;
  reason: string | null;
  status: string;
  evidence_due_by: string | null;
  outcome: string | null;
  created_at: string;
  members: { name: string } | null;
};

const OPEN_STATUSES = ["warning_needs_response", "needs_response", "under_review", "warning_under_review"];

function money(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: (currency || "usd").toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `${(currency || "usd").toUpperCase()} ${(cents / 100).toFixed(2)}`;
  }
}

/**
 * Dispute deadlines are hard, money-losing cut-offs, so they are ALWAYS shown
 * with their time and an explicit timezone. Formatting the UTC instant as a
 * bare local date used to tip it into the next calendar day for gyms east of
 * UTC, disagreeing with the countdown next to it.
 */
export function formatDeadline(due: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(due);
  return `${parts.replace(",", "")} UTC`;
}


export function useDisputes(dojoId: string | null, memberId?: string | null) {
  return useQuery({
    queryKey: ["disputes", dojoId, memberId ?? "all"],
    enabled: !!dojoId,
    queryFn: async () => {
      let q = supabase
        .from("disputes")
        .select(
          "id, stripe_dispute_id, member_id, invoice_id, amount_cents, currency, reason, status, evidence_due_by, outcome, created_at, members(name)",
        )
        .eq("dojo_id", dojoId!)
        .order("created_at", { ascending: false });
      if (memberId) q = q.eq("member_id", memberId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as DisputeRow[];
    },
  });
}

export function isDisputeOpen(d: DisputeRow) {
  return OPEN_STATUSES.includes(d.status) || (!d.outcome && d.status !== "won" && d.status !== "lost");
}

/**
 * Unmissable chargeback alert. A dispute means money has ALREADY been pulled
 * back out of the gym's account and there is a hard deadline to respond, so
 * this is deliberately loud and always links straight into Stripe.
 */
export function DisputeAlerts({
  dojoId,
  memberId,
  className,
}: {
  dojoId: string | null;
  memberId?: string | null;
  className?: string;
}) {
  const { data } = useDisputes(dojoId, memberId);
  const open = (data ?? []).filter(isDisputeOpen);
  if (open.length === 0) return null;

  return (
    <section
      className={cn(
        "rounded-xl border-2 border-destructive/60 bg-destructive/5 p-5",
        className,
      )}
      aria-live="polite"
    >
      <div className="flex items-center gap-2 text-destructive">
        <AlertTriangle className="size-5" />
        <h2 className="font-display text-base font-semibold">
          {open.length === 1 ? "Chargeback opened" : `${open.length} chargebacks opened`}
        </h2>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        The money has already been withdrawn from your account. Respond in Stripe before the
        deadline or the payment is lost for good.
      </p>
      <ul className="mt-4 space-y-2">
        {open.map((d) => {
          const due = d.evidence_due_by ? new Date(d.evidence_due_by) : null;
          const overdue = due ? due.getTime() < Date.now() : false;
          return (
            <li
              key={d.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-card p-3 text-sm ring-1 ring-destructive/20"
            >
              <div>
                <div className="font-medium">
                  {d.members?.name ?? "Unknown member"} · {money(d.amount_cents, d.currency)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {(d.reason ?? "disputed").replace(/_/g, " ")} · {d.status.replace(/_/g, " ")}
                  {due
                    ? overdue
                      ? ` · evidence deadline passed (${formatDeadline(due)})`
                      : ` · evidence due ${formatDeadline(due)} (in ${formatDistanceToNowStrict(due)})`
                    : ""}
                </div>
              </div>

              <a
                href={`https://dashboard.stripe.com/disputes/${d.stripe_dispute_id}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-md bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground hover:bg-destructive/90"
              >
                Respond in Stripe <ExternalLink className="size-3" />
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
