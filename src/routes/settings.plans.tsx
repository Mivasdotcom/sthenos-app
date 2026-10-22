import { PUBLIC_SITE_URL } from "@/lib/site";
import { familyPlanExplainer } from "@/lib/family";
import { FamilyDiscountTiersCard } from "@/components/FamilyDiscountTiersCard";
import { getFamilyPricingConfig } from "@/lib/family-pricing.functions";
import { pricingModeExplainer } from "@/lib/family-pricing";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  listDojoPlans,
  upsertPlan,
  archivePlan,
  getPlanMemberCounts,
  type DojoPlan,
} from "@/lib/plans.functions";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { useAuth } from "@/hooks/use-auth";
import { Plus, Pencil, Archive, ArchiveRestore, Info, TrendingUp, CheckCircle2 } from "lucide-react";
import { PlanPriceChangeDialog } from "@/components/PlanPriceChangeDialog";
import { MembershipPolicyCard } from "@/components/MembershipPolicyCard";
import { GrandfatheredPricesCard } from "@/components/GrandfatheredPricesCard";
import { toast } from "sonner";
import { RouteErrorPanel } from "@/components/RouteErrorPanel";
import { allowedPlanCurrencies, nativeCurrencyForCountry } from "@/lib/payment-methods";


export const Route = createFileRoute("/settings/plans")({
  head: () => ({
    meta: [
      { title: "Plans \u2014 Sthenos" },
      { name: "description", content: "Create and manage the membership plans your athletes can choose from." },
      { property: "og:title", content: "Plans \u2014 Sthenos" },
      { property: "og:description", content: "Create and manage the membership plans your athletes can choose from." },
      { property: "og:url", content: `${PUBLIC_SITE_URL}/settings/plans` },
      { name: "twitter:title", content: "Plans \u2014 Sthenos" },
      { name: "twitter:description", content: "Create and manage the membership plans your athletes can choose from." },
    ],
    links: [
      { rel: "canonical", href: `${PUBLIC_SITE_URL}/settings/plans` },
    ],
  }),
  component: PlansPage,
  errorComponent: ({ error, reset }) => (
    <RouteErrorPanel error={error} reset={reset} title="Plans didn't load" />
  ),
});

type EditState = {
  open: boolean;
  plan: DojoPlan | null;
};

const emptyEdit: EditState = { open: false, plan: null };

function PlansPage() {
  const { isStaff } = useAuth();
  const { activeDojoId, activeDojo, loading } = useCurrentDojo();
  const qc = useQueryClient();
  const [edit, setEdit] = useState<EditState>(emptyEdit);
  const [priceChange, setPriceChange] = useState<DojoPlan | null>(null);

  const listFn = useServerFn(listDojoPlans);
  const archiveFn = useServerFn(archivePlan);
  const countsFn = useServerFn(getPlanMemberCounts);
  // Plan pending archive — never archive straight from the row click, because
  // the owner needs to see who is on it first.
  const [confirmArchive, setConfirmArchive] = useState<DojoPlan | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["dojo-plans", activeDojoId, "all"],
    queryFn: () =>
      listFn({ data: { dojoId: activeDojoId!, includeArchived: true } }),
    enabled: !!activeDojoId,
  });

  const { data: countsData } = useQuery({
    queryKey: ["dojo-plan-member-counts", activeDojoId],
    queryFn: () => countsFn({ data: { dojoId: activeDojoId! } }),
    enabled: !!activeDojoId,
  });
  const counts = countsData?.counts ?? {};

  const archiveMut = useMutation({
    mutationFn: (vars: { id: string; archived: boolean }) =>
      archiveFn({ data: vars }),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: ["dojo-plans"] });
      qc.invalidateQueries({ queryKey: ["dojo-plan-member-counts"] });
      setConfirmArchive(null);
      toast.success(vars.archived ? "Plan archived" : "Plan restored");
    },
    onError: (e: any) => toast.error(e?.message ?? "Couldn't update that plan"),
  });

  if (loading) {
    return <main className="p-8 text-sm text-muted-foreground">Loading…</main>;
  }

  if (!activeDojoId || !isStaff) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <div className="rounded-xl bg-card p-8 text-center ring-1 ring-black/5">
          <p className="text-sm text-muted-foreground">
            Only dojo managers and coaches can manage plans.
          </p>
        </div>
      </main>
    );
  }

  const plans = data?.plans ?? [];
  const activePlans = plans.filter((p) => p.is_active);
  const archivedPlans = plans.filter((p) => !p.is_active);

  return (
    <main>
      <PageHeader
        title="Membership Plans"
        subtitle={activeDojo?.name ?? "Set the options members see at signup"}
        actions={
          <Button
            size="sm"
            className="bg-brand text-brand-foreground hover:bg-brand/90"
            onClick={() => setEdit({ open: true, plan: null })}
          >
            <Plus className="size-4" /> New plan
          </Button>
        }
      />

      <div className="mx-auto max-w-5xl space-y-6 p-8">
        {(() => {
          const paymentsActive = !!activeDojo?.stripeChargesEnabled;
          if (paymentsActive) {
            return (
              <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                <CheckCircle2 className="mt-0.5 size-4 flex-none" />
                <div>
                  <div className="font-semibold">Card billing is active.</div>
                  <div className="mt-1 text-emerald-800/80">
                    Members can pay by card at signup and through their member portal.
                  </div>
                </div>
              </div>
            );
          }
          return (
            <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-100 p-4 text-sm text-amber-900">
              <Info className="mt-0.5 size-4 flex-none" />
              <div>
                <div className="font-semibold">Online payments are not active yet.</div>
                <div className="mt-1 text-amber-800/80">
                  Members can pick a plan during signup and you can collect payment offline.
                  Card billing turns on once you finish connecting your payout account.
                </div>
                <div className="mt-2">
                  <Link
                    to="/settings/payments"
                    className="text-amber-900 underline underline-offset-2"
                  >
                    Set up payments
                  </Link>
                </div>
              </div>
            </div>
          );
        })()}


        <FamilyDiscountTiersCard dojoId={activeDojoId} />

        <MembershipPolicyCard dojoId={activeDojoId} />

        <GrandfatheredPricesCard dojoId={activeDojoId} />



        {isLoading && (
          <div className="rounded-xl bg-card p-8 text-center text-sm text-muted-foreground ring-1 ring-black/5">
            Loading plans…
          </div>
        )}

        {!isLoading && plans.length === 0 && (
          <div className="rounded-xl border border-dashed border-zinc-950/10 bg-card/40 p-10 text-center">
            <p className="text-sm text-muted-foreground">
              You haven't created any plans yet.
            </p>
            <Button
              className="mt-4 bg-brand text-brand-foreground hover:bg-brand/90"
              onClick={() => setEdit({ open: true, plan: null })}
            >
              <Plus className="size-4" /> Create your first plan
            </Button>
          </div>
        )}

        {!isLoading && activePlans.length > 0 && (
          <PlanRows
            plans={activePlans}
            counts={counts}
            onEdit={(p) => setEdit({ open: true, plan: p })}
            onPriceChange={setPriceChange}
            onArchive={setConfirmArchive}
            onRestore={(p) => archiveMut.mutate({ id: p.id, archived: false })}
          />
        )}

        {!isLoading && archivedPlans.length > 0 && (
          <section className="space-y-2">
            <div>
              <h2 className="text-sm font-semibold">Archived plans</h2>
              <p className="text-xs text-muted-foreground">
                Hidden from signup and the member portal. Anyone still on one
                keeps it and is billed as normal — restore a plan if you
                archived it by mistake.
              </p>
            </div>
            <PlanRows
              plans={archivedPlans}
              counts={counts}
              onEdit={(p) => setEdit({ open: true, plan: p })}
              onPriceChange={setPriceChange}
              onArchive={setConfirmArchive}
              onRestore={(p) => archiveMut.mutate({ id: p.id, archived: false })}
            />
          </section>
        )}
      </div>

      <ArchivePlanDialog
        plan={confirmArchive}
        memberCount={confirmArchive ? (counts[confirmArchive.id] ?? 0) : 0}
        pending={archiveMut.isPending}
        onCancel={() => setConfirmArchive(null)}
        onConfirm={() =>
          confirmArchive &&
          archiveMut.mutate({ id: confirmArchive.id, archived: true })
        }
      />



      <PlanPriceChangeDialog
        open={!!priceChange}
        plan={priceChange}
        dojoId={activeDojoId}
        onClose={() => setPriceChange(null)}
      />

      <PlanEditDialog
        state={edit}
        dojoId={activeDojoId}
        onClose={() => setEdit(emptyEdit)}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ["dojo-plans"] });
          setEdit(emptyEdit);
        }}
      />
    </main>
  );
}

function PlanEditDialog({
  state,
  dojoId,
  onClose,
  onSaved,
}: {
  state: EditState;
  dojoId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const upsertFn = useServerFn(upsertPlan);
  const plan = state.plan;

  const getPricingCfg = useServerFn(getFamilyPricingConfig);
  const { data: pricingCfg } = useQuery({
    queryKey: ["family-pricing-config", dojoId],
    enabled: !!dojoId,
    queryFn: () => getPricingCfg({ data: { dojoId } }),
  });


  const { data: dojo } = useQuery({
    queryKey: ["dojo-default-currency", dojoId],
    queryFn: async () => {
      const { supabase } = await import("@/integrations/supabase/client");
      const { data } = await supabase
        .from("dojos")
        .select("default_currency, stripe_account_country, country")
        .eq("id", dojoId)
        .maybeSingle();
      return data as {
        default_currency: string;
        stripe_account_country: string | null;
        country: string | null;
      } | null;
    },
    enabled: !!dojoId,
  });

  const nativeCurrency = nativeCurrencyForCountry(
    dojo?.stripe_account_country ?? dojo?.country,
  );
  const planCurrencies = allowedPlanCurrencies({
    accountCountry: dojo?.stripe_account_country ?? dojo?.country,
    defaultCurrency: dojo?.default_currency,
  });

  const [name, setName] = useState(plan?.name ?? "");
  const [description, setDescription] = useState(plan?.description ?? "");
  const [price, setPrice] = useState(
    plan ? (plan.price_cents / 100).toString() : "",
  );
  const [currency, setCurrency] = useState(plan?.currency ?? dojo?.default_currency ?? "usd");

  const [interval, setInterval] = useState<"month" | "year" | "one_time">(
    (plan?.interval as any) ?? "month",
  );
  const [isActive, setIsActive] = useState(plan?.is_active ?? true);
  const [planType, setPlanType] = useState<"individual" | "family">(
    plan?.plan_type ?? "individual",
  );
  const [maxFamily, setMaxFamily] = useState<string>(
    plan?.max_family_members ? String(plan.max_family_members) : "4",
  );


  // Reset when dialog opens
  if (state.open && plan?.id !== (plan ? plan.id : undefined)) {
    // no-op; useEffect alternative below
  }

  const mut = useMutation({
    mutationFn: () =>
      upsertFn({
        data: {
          id: plan?.id,
          dojoId,
          name,
          description,
          priceCents: Math.round(parseFloat(price || "0") * 100),
          currency,
          interval,
          isActive,
          planType,
          maxFamilyMembers:
            planType === "family" && maxFamily.trim() !== ""
              ? Math.max(2, Math.floor(Number(maxFamily)))
              : null,
        },
      }),
    onSuccess: () => {
      toast.success(plan ? "Plan updated" : "Plan created");
      onSaved();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not save plan"),
  });


  return (
    <Dialog
      open={state.open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{plan ? "Edit plan" : "New plan"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Unlimited Monthly"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="desc">Description (optional)</Label>
            <Input
              id="desc"
              value={description ?? ""}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="All classes, all week"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="price">Price</Label>
              <Input
                id="price"
                type="number"
                min="0"
                step="0.01"
                value={price}
                disabled={!!plan}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="149.00"
              />
              {plan && (
                <p className="text-xs text-muted-foreground">
                  Use <span className="font-medium">Change price</span> to alter the price
                  of a live plan — it shows exactly who is affected and gives members
                  notice before anything changes.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Currency</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {planCurrencies.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c.toUpperCase()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {nativeCurrency && currency !== nativeCurrency && (
                <p className="text-xs text-amber-700">
                  Your Stripe account settles in {nativeCurrency.toUpperCase()}, so pricing
                  in {currency.toUpperCase()} means Stripe converts every payment and adds
                  a conversion fee (~4%) on top of what your members pay. Price in the
                  currency your members actually bank in to avoid it.
                </p>
              )}
              {nativeCurrency &&
                currency === nativeCurrency &&
                nativeCurrency !== "eur" && (
                  <p className="text-xs text-muted-foreground">
                    Members in the euro area will see a converted EUR price (Stripe adds
                    ~4%) and can't use SEPA Direct Debit. If most of your members are in
                    the euro area, price in EUR instead.
                  </p>
                )}

            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Billing interval</Label>
            <Select
              value={interval}
              onValueChange={(v) =>
                setInterval(v as "month" | "year" | "one_time")
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="month">Monthly</SelectItem>
                <SelectItem value="year">Yearly</SelectItem>
                <SelectItem value="one_time">One-time</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Plan type</Label>
            <Select
              value={planType}
              onValueChange={(v) => setPlanType(v as "individual" | "family")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="individual">Individual</SelectItem>
                <SelectItem value="family">Family</SelectItem>
              </SelectContent>
            </Select>
            {planType === "family" && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  {familyPlanExplainer(Number(maxFamily) || null)}
                </p>
                {pricingCfg && (
                  <p className="text-xs text-muted-foreground">
                    This gym uses{" "}
                    <span className="font-medium">
                      {pricingCfg.mode === "tiered"
                        ? "tiered family discounts"
                        : "flat family pricing"}
                    </span>
                    . {pricingModeExplainer(pricingCfg.mode)}
                    {pricingCfg.mode === "tiered"
                      ? " The price you set here is only used if you switch this gym back to flat pricing."
                      : ""}
                  </p>
                )}
              </div>
            )}

          </div>

          {planType === "family" && (
            <div className="space-y-1.5">
              <Label htmlFor="max-family">Max family members</Label>
              <Input
                id="max-family"
                type="number"
                min={2}
                step={1}
                value={maxFamily}
                onChange={(e) => setMaxFamily(e.target.value)}
                placeholder="4"
              />
              <p className="text-xs text-muted-foreground">
                Counts everyone on the plan, payer included. One subscription covers them
                all — leave blank for unlimited.
              </p>
            </div>
          )}



          <div className="flex items-center justify-between rounded-lg border border-zinc-950/5 bg-card px-3 py-2">
            <div>
              <div className="text-sm font-medium">Active</div>
              <div className="text-xs text-muted-foreground">
                Members can pick this plan at signup
              </div>
            </div>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>

          {/* TODO(stripe): when payments are enabled, sync price to Stripe here */}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="bg-brand text-brand-foreground hover:bg-brand/90"
            disabled={!name.trim() || mut.isPending}
            onClick={() => mut.mutate()}
          >
            {mut.isPending ? "Saving…" : plan ? "Save changes" : "Create plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


// ---------------------------------------------------------------------------

function PlanRows({
  plans,
  counts,
  onEdit,
  onPriceChange,
  onArchive,
  onRestore,
}: {
  plans: DojoPlan[];
  counts: Record<string, number>;
  onEdit: (p: DojoPlan) => void;
  onPriceChange: (p: DojoPlan) => void;
  onArchive: (p: DojoPlan) => void;
  onRestore: (p: DojoPlan) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl bg-card ring-1 ring-black/5">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-zinc-950/5 bg-zinc-50/50">
            {["Plan", "Price", "Interval", "Members", "Status"].map((h) => (
              <th
                key={h}
                className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {h}
              </th>
            ))}
            <th className="px-6 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-950/5">
          {plans.map((p) => {
            const count = counts[p.id] ?? 0;
            return (
              <tr key={p.id} className="transition-colors hover:bg-zinc-50/40">
                <td className="px-6 py-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {p.name}
                    {p.plan_type === "family" && (
                      <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-violet-700 ring-1 ring-inset ring-violet-500/20">
                        Family{p.max_family_members ? ` · up to ${p.max_family_members}` : ""}
                      </span>
                    )}
                  </div>
                  {p.description && (
                    <div className="text-[11px] text-muted-foreground">
                      {p.description}
                    </div>
                  )}
                </td>
                <td className="px-6 py-3 text-sm tabular-nums">
                  {(p.price_cents / 100).toLocaleString(undefined, {
                    style: "currency",
                    currency: p.currency.toUpperCase(),
                  })}
                </td>
                <td className="px-6 py-3 text-sm capitalize text-zinc-600">
                  {p.interval.replace("_", " ")}
                </td>
                <td className="px-6 py-3 text-sm tabular-nums text-zinc-600">
                  {count}
                </td>
                <td className="px-6 py-3">
                  <span
                    className={
                      p.is_active
                        ? "rounded bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700 ring-1 ring-inset ring-emerald-500/20"
                        : "rounded bg-zinc-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-zinc-600 ring-1 ring-inset ring-zinc-400/20"
                    }
                  >
                    {p.is_active ? "Active" : "Archived"}
                  </span>
                </td>
                <td className="px-6 py-3 text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1.5 text-xs"
                      onClick={() => onEdit(p)}
                    >
                      <Pencil className="size-3.5" /> Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1.5 text-xs"
                      onClick={() => onPriceChange(p)}
                    >
                      <TrendingUp className="size-3.5" /> Change price
                    </Button>
                    {p.is_active ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1.5 text-xs"
                        onClick={() => onArchive(p)}
                      >
                        <Archive className="size-3.5" /> Archive
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1.5 text-xs"
                        onClick={() => onRestore(p)}
                      >
                        <ArchiveRestore className="size-3.5" /> Restore
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Archiving is safe but not obvious: existing members keep the plan while new
 * ones can no longer choose it. Spell that out, with the headcount, so nobody
 * retires their main plan by accident.
 */
function ArchivePlanDialog({
  plan,
  memberCount,
  pending,
  onCancel,
  onConfirm,
}: {
  plan: DojoPlan | null;
  memberCount: number;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={!!plan} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Archive “{plan?.name}”?</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">
            {memberCount === 0
              ? "Nobody is currently on this plan."
              : `${memberCount} ${memberCount === 1 ? "member is" : "members are"} on this plan.`}
          </p>
          {memberCount > 0 && (
            <p>
              They keep it and continue to be billed as normal — nothing changes
              for them, so this is how legacy or founding-member pricing is kept
              alive.
            </p>
          )}
          <p>
            New members will no longer be able to choose it on signup or in the
            member portal. You can restore it at any time.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            className="bg-brand text-brand-foreground hover:bg-brand/90"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? "Archiving…" : "Archive plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
