import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import { grossChargeCents } from "@/lib/platform-fee";
import type { DojoPlan } from "@/lib/plans.functions";

function formatPrice(cents: number, currency: string, interval: string) {
  const amount = (cents / 100).toLocaleString(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  });
  const suffix =
    interval === "month" ? "/mo" : interval === "year" ? "/yr" : "";
  return { amount, suffix };
}

interface PlanPickerProps {
  plans: DojoPlan[];
  value: string | null;
  onChange: (planId: string | null) => void;
  showNoneOption?: boolean;
  /**
   * Copy for the no-paid-plan tile. Signup uses this to name the choice
   * ("Free Trial Class") instead of the meaningless "No plan", so a prospect
   * is actively picking a trial rather than falling through the step.
   */
  noneOptionTitle?: string;
  noneOptionDescription?: string;
  /**
   * Whether the no-plan tile is the current choice. Needed because `value` is
   * null both before anyone has chosen anything and after the trial is picked,
   * and those two states must not look the same.
   */
  noneSelected?: boolean;
  className?: string;
  /**
   * When true, plan prices are shown GROSS — base price plus the platform fee —
   * because that is what checkout charges. The badge below each price says so.
   */
  passPlatformFeeToMembers?: boolean;
  /** Platform fee percent to show on the badge. Defaults to 1. */
  platformFeePercent?: number;
}

export function PlanPicker({
  plans,
  value,
  onChange,
  showNoneOption = false,
  noneOptionTitle = "No plan",
  noneOptionDescription = "Skip plan selection for now",
  noneSelected,
  className,
  passPlatformFeeToMembers = false,
  platformFeePercent = 1,
}: PlanPickerProps) {

  // With no paid plans there may still be a free-trial tile to show, so only
  // bail out when there is genuinely nothing to choose from.
  if (!plans.length && !showNoneOption) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-950/10 bg-card/40 p-6 text-center text-sm text-muted-foreground">
        No plans have been set up yet.
      </div>
    );
  }

  return (
    <div
      className={cn(
        "grid gap-3 sm:grid-cols-2 lg:grid-cols-3",
        className,
      )}
    >
      {plans.map((p) => {
        const selected = value === p.id;
        // Show the amount the member will actually be charged, from the same
        // helper the checkout and portal use, so the figures cannot diverge.
        const { amount, suffix } = formatPrice(
          grossChargeCents(p.price_cents, passPlatformFeeToMembers),
          p.currency,
          p.interval,
        );
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(p.id)}
            className={cn(
              "relative rounded-xl border bg-card p-5 text-left transition-all hover:border-brand/40 hover:shadow-sm",
              selected
                ? "border-brand ring-2 ring-brand/20"
                : "border-zinc-950/10",
            )}
          >
            {selected && (
              <span className="absolute right-3 top-3 grid size-6 place-items-center rounded-full bg-brand text-brand-foreground">
                <Check className="size-3.5" />
              </span>
            )}
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold">{p.name}</div>
              {p.plan_type === "family" && (
                <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-violet-700 ring-1 ring-inset ring-violet-500/20">
                  Family{p.max_family_members ? ` · up to ${p.max_family_members}` : ""}
                </span>
              )}
            </div>
            {p.description && (
              <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                {p.description}
              </div>
            )}
            {p.plan_type === "family" && (
              <div className="mt-1 text-[11px] text-violet-700">
                You can add family members after signup from your portal.
              </div>
            )}

            <div className="mt-4 flex items-baseline gap-1">
              <span className="font-display text-2xl font-medium tabular-nums">
                {amount}
              </span>
              <span className="text-xs text-muted-foreground">{suffix}</span>
            </div>
            {passPlatformFeeToMembers && p.price_cents > 0 && (
              <div className="mt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                includes {platformFeePercent}% platform fee
              </div>
            )}
          </button>
        );
      })}
      {showNoneOption && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className={cn(
            "relative rounded-xl border border-dashed bg-card/40 p-5 text-left transition-all hover:border-zinc-400",
            (noneSelected ?? value === null)
              ? "border-brand ring-2 ring-brand/20"
              : "border-zinc-950/15",
          )}
        >
          {(noneSelected ?? value === null) && (
            <span className="absolute right-3 top-3 grid size-6 place-items-center rounded-full bg-brand text-brand-foreground">
              <Check className="size-3.5" />
            </span>
          )}
          <div className="text-sm font-semibold">{noneOptionTitle}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {noneOptionDescription}
          </div>
        </button>
      )}

    </div>
  );
}
