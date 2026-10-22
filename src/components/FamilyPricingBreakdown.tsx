import {
  familyExclusionLabel,
  formatFamilyMaths,
  formatMoney,
  trimPct,
  type FamilyQuote,
} from "@/lib/family-pricing";
import { grossChargeCents } from "@/lib/platform-fee";

/**
 * The family maths, always shown in full: per-member plan prices, the family
 * discount, and the resulting total. Never a bare final number.
 */
export function FamilyPricingBreakdown({
  quote,
  title = "Family total",
  compact = false,
  passPlatformFeeToMembers = false,
  platformFeePercent = 1,
}: {
  quote: FamilyQuote;
  title?: string;
  compact?: boolean;
  /**
   * Member-facing surfaces pass this so the payer's total is the amount that
   * will actually be collected (base + platform fee). Staff-facing surfaces
   * leave it off and keep seeing the plan-price total.
   */
  passPlatformFeeToMembers?: boolean;
  platformFeePercent?: number;
}) {
  const chargedCents = grossChargeCents(quote.totalCents, passPlatformFeeToMembers);
  if (compact) {
    return (
      <p className="text-xs text-muted-foreground">
        {formatFamilyMaths(quote)}
        {passPlatformFeeToMembers && chargedCents > 0
          ? ` · ${formatMoney(chargedCents, quote.currency)} charged, including ${platformFeePercent}% platform fee`
          : ""}
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-950/5 bg-card px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <ul className="mt-1.5 space-y-1">
        {quote.members.map((m, i) => (
          <li
            key={m.id ?? `${m.name}-${i}`}
            className="flex items-baseline justify-between gap-3 text-xs"
          >
            <span className="truncate">
              {m.name}
              {m.planName ? (
                <span className="text-muted-foreground"> · {m.planName}</span>
              ) : (
                <span className="text-amber-700"> · no plan yet</span>
              )}
              {m.nativeInterval ? (
                <span className="text-muted-foreground">
                  {" "}
                  · {formatMoney(m.nativePriceCents ?? 0, quote.currency)}{" "}
                  {m.nativeInterval === "year" ? "per year" : "per month"}, counted as{" "}
                  {quote.interval === "year" ? "yearly" : "monthly"}
                </span>
              ) : null}
            </span>
            <span className="tabular-nums">
              {formatMoney(m.priceCents, quote.currency)}
            </span>
          </li>
        ))}
      </ul>

      {quote.uncounted.length > 0 && (
        <ul className="mt-1.5 space-y-1 border-t border-dashed border-zinc-950/10 pt-1.5">
          {quote.uncounted.map((m, i) => (
            <li
              key={m.id ?? `unc-${m.name}-${i}`}
              className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground"
            >
              <span className="truncate">
                <span className="mr-1.5 rounded bg-muted px-1 py-px text-[9px] font-semibold uppercase tracking-wider">
                  {(m.status ?? "").toLowerCase() === "trial" ? "Trial" : (m.status ?? "")}
                </span>
                {m.name}
                {m.planName ? ` · ${m.planName}` : ""} · {familyExclusionLabel(m.status, m.trains)}
              </span>
              <span className="tabular-nums">—</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 space-y-1 border-t border-zinc-950/5 pt-2 text-xs">
        <div className="flex justify-between">
          <span className="text-muted-foreground">
            Subtotal · {quote.size} counted member{quote.size === 1 ? "" : "s"}
          </span>
          <span className="tabular-nums">
            {formatMoney(quote.subtotalCents, quote.currency)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">
            Family discount {trimPct(quote.discountPercent)}%
          </span>
          <span className="tabular-nums text-emerald-700">
            −{formatMoney(quote.discountCents, quote.currency)}
          </span>
        </div>
        <div className="flex justify-between font-semibold">
          <span>Payer is charged</span>
          <span className="tabular-nums">
            {formatMoney(chargedCents, quote.currency)}
            {quote.interval === "one_time"
              ? ""
              : quote.interval === "year"
                ? "/year"
                : "/month"}
          </span>
        </div>
        {passPlatformFeeToMembers && chargedCents > 0 && (
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            includes {platformFeePercent}% platform fee
          </div>
        )}
      </div>

      {quote.size === 0 && (
        <p className="mt-2 text-[11px] font-medium text-amber-700">
          Nobody in this family is on a paid plan yet, so the payer is not charged and
          should not be chased. Billing starts when the first member moves onto a paid
          plan.
        </p>
      )}

      <p className="mt-2 text-[11px] text-muted-foreground">{formatFamilyMaths(quote)}</p>
      {quote.missingPlanNames.length > 0 && (
        <p className="mt-1 text-[11px] text-amber-700">
          {quote.missingPlanNames.join(", ")} {quote.missingPlanNames.length === 1 ? "has" : "have"}{" "}
          no plan yet, so they add nothing to the total.
        </p>
      )}
    </div>
  );
}
