import { PUBLIC_SITE_URL } from "@/lib/site";
import { useEffect, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Building2, Loader2, Plus, Trash2, Check } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCurrentDojo } from "@/hooks/use-current-dojo";

type DraftPlan = {
  id: string;
  name: string;
  price_cents: number;
  interval: "month" | "year" | "one_time";
  description: string | null;
};

import { DEFAULT_WAIVER_BODY, DEFAULT_WAIVER_TITLE } from "@/lib/waiver-defaults";
import { DEFAULT_TERMS_BODY, DEFAULT_TERMS_TITLE } from "@/lib/agreements";
import {
  CONNECT_COUNTRIES,
  allowedAccountCurrencies,
  normalizeConnectCountry,
} from "@/lib/connect-countries";

export const Route = createFileRoute("/onboarding")({
  head: () => ({
    meta: [
      { title: "Welcome \u2014 Sthenos" },
      { name: "description", content: "Create your gym to get started with Sthenos." },
      { property: "og:title", content: "Welcome \u2014 Sthenos" },
      { property: "og:description", content: "Create your gym to get started with Sthenos." },
      { property: "og:url", content: `${PUBLIC_SITE_URL}/onboarding` },
      { name: "twitter:title", content: "Welcome \u2014 Sthenos" },
      { name: "twitter:description", content: "Create your gym to get started with Sthenos." },
    ],
    links: [
      { rel: "canonical", href: `${PUBLIC_SITE_URL}/onboarding` },
    ],
  }),
  component: OnboardingPage,
});

function slugify(input: string) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 48);
}

const CURRENCY_OPTIONS: { value: string; label: string; symbol: string }[] = [
  { value: "gbp", label: "GBP £", symbol: "£" },
  { value: "usd", label: "USD $", symbol: "$" },
  { value: "eur", label: "EUR €", symbol: "€" },
  { value: "aed", label: "AED د.إ", symbol: "د.إ" },
  { value: "sar", label: "SAR ﷼", symbol: "﷼" },
  { value: "qar", label: "QAR ﷼", symbol: "﷼" },
  { value: "aud", label: "AUD A$", symbol: "A$" },
  { value: "cad", label: "CAD C$", symbol: "C$" },
  { value: "sgd", label: "SGD S$", symbol: "S$" },
  { value: "jpy", label: "JPY ¥", symbol: "¥" },
  { value: "krw", label: "KRW ₩", symbol: "₩" },
  { value: "inr", label: "INR ₹", symbol: "₹" },
  { value: "brl", label: "BRL R$", symbol: "R$" },
];

function currencySymbol(code: string): string {
  return CURRENCY_OPTIONS.find((c) => c.value === code)?.symbol ?? code.toUpperCase();
}

function OnboardingPage() {
  const { user, refreshRoles } = useAuth();
  const { refresh, setActiveDojoId } = useCurrentDojo();
  const router = useRouter();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState("");
  // No default: a plausible-but-wrong country (e.g. GB for a Cyprus gym) is
  // permanent once Stripe is connected, so the owner must choose explicitly.
  const [currency, setCurrency] = useState<string>("");
  const [country, setCountry] = useState<string>("");
  const [busy, setBusy] = useState(false);

  // Created dojo context (available after Step 1)
  const [dojoId, setDojoId] = useState<string | null>(null);
  const [dojoName, setDojoName] = useState<string>("");

  // Step 2 — plans
  const [plans, setPlans] = useState<DraftPlan[]>([]);
  const [planName, setPlanName] = useState("");
  const [planPrice, setPlanPrice] = useState<string>("");
  const [planInterval, setPlanInterval] = useState<"month" | "year" | "one_time">("month");
  const [planDescription, setPlanDescription] = useState("");
  const [addingPlan, setAddingPlan] = useState(false);

  // Step 3 — waiver
  const [waiverId, setWaiverId] = useState<string | null>(null);
  const [waiverBody, setWaiverBody] = useState<string>(DEFAULT_WAIVER_BODY);
  const [savingWaiver, setSavingWaiver] = useState(false);

  // Currencies Stripe will accept for the chosen country.
  const currencyChoices = allowedAccountCurrencies(country);

  // Keep the currency valid for the chosen country; never guess for them.
  useEffect(() => {
    if (!country) {
      setCurrency("");
      return;
    }
    setCurrency((prev) => (currencyChoices.includes(prev) ? prev : ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !name.trim() || !country || !currency) return;
    setBusy(true);
    try {
      const base = slugify(name) || "dojo";
      const slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;

      const { data: dojo, error: dojoErr } = await supabase
        .from("dojos")
        .insert({
          name: name.trim(),
          slug,
          owner_user_id: user.id,
          default_currency: currency,
          country: normalizeConnectCountry(country),
          public_page_enabled: false,
        })
        .select("id")
        .single();
      if (dojoErr) throw dojoErr;

      const { error: memErr } = await supabase
        .from("dojo_memberships")
        .insert({ dojo_id: dojo.id, user_id: user.id, role: "owner" });
      if (memErr) throw memErr;

      // Seed default class types
      try {
        // No "No-Gi": it is BJJ without the gi, not a separate art, and seeding
        // it here is what put two names for the same thing in front of every
        // member signing up.
        const defaults = [
          "BJJ", "MMA", "Muay Thai", "Boxing",
          "Wrestling", "Judo", "Karate",
        ];
        const { data: existing } = await supabase
          .from("dojo_class_types")
          .select("id")
          .eq("dojo_id", dojo.id)
          .limit(1);
        if (!existing || existing.length === 0) {
          const { error: ctErr } = await supabase
            .from("dojo_class_types")
            .insert(
              defaults.map((n, i) => ({
                dojo_id: dojo.id,
                name: n,
                discipline: n,
                sort_order: i,
              })),
            );
          if (ctErr) console.error("Seed class types failed:", ctErr);
        }
      } catch (err) {
        console.error("Seed class types failed:", err);
      }

      // Seed default waiver and capture its id for Step 3
      let seededWaiverId: string | null = null;
      try {
        const { data: waiverRow, error: wErr } = await supabase
          .from("dojo_waivers")
          .insert({
            dojo_id: dojo.id,
            title: DEFAULT_WAIVER_TITLE,
            is_current: true,
            body_markdown: DEFAULT_WAIVER_BODY,
          })
          .select("id, body_markdown")
          .single();
        if (wErr) {
          console.error("Seed waiver failed:", wErr);
        } else if (waiverRow) {
          seededWaiverId = waiverRow.id;
          setWaiverBody(waiverRow.body_markdown ?? DEFAULT_WAIVER_BODY);
        }
      } catch (err) {
        console.error("Seed waiver failed:", err);
      }

      // Seed a starter Terms & Conditions the gym can edit or clear
      try {
        const { error: tErr } = await supabase.from("dojo_terms").insert({
          dojo_id: dojo.id,
          title: DEFAULT_TERMS_TITLE,
          body_markdown: DEFAULT_TERMS_BODY,
          is_current: true,
        });
        if (tErr) console.error("Seed terms failed:", tErr);
      } catch (err) {
        console.error("Seed terms failed:", err);
      }

      setActiveDojoId(dojo.id);
      await refresh();
      setDojoId(dojo.id);
      setDojoName(name.trim());
      setWaiverId(seededWaiverId);
      toast.success(`Created ${name.trim()}`);
      setStep(2);
    } catch (err: any) {
      toast.error(err?.message ?? "Could not create dojo");
    } finally {
      setBusy(false);
    }
  };

  const addPlan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dojoId || !planName.trim()) return;
    const priceNum = Number(planPrice);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      toast.error("Enter a valid price");
      return;
    }
    setAddingPlan(true);
    try {
      const payload = {
        dojo_id: dojoId,
        name: planName.trim(),
        description: planDescription.trim() || null,
        price_cents: Math.round(priceNum * 100),
        currency: currency.toLowerCase(),
        interval: planInterval,
        is_active: true,
        sort_order: plans.length,
      };
      const { data, error } = await supabase
        .from("dojo_plans")
        .insert(payload)
        .select("id, name, price_cents, interval, description")
        .single();
      if (error) throw error;
      setPlans((prev) => [
        ...prev,
        {
          id: data.id,
          name: data.name,
          price_cents: data.price_cents,
          interval: data.interval as DraftPlan["interval"],
          description: data.description,
        },
      ]);
      setPlanName("");
      setPlanPrice("");
      setPlanDescription("");
      setPlanInterval("month");
      toast.success("Plan added");
    } catch (err: any) {
      toast.error(err?.message ?? "Could not add plan");
    } finally {
      setAddingPlan(false);
    }
  };

  const removePlan = async (id: string) => {
    try {
      const { error } = await supabase.from("dojo_plans").delete().eq("id", id);
      if (error) throw error;
      setPlans((prev) => prev.filter((p) => p.id !== id));
    } catch (err: any) {
      toast.error(err?.message ?? "Could not remove plan");
    }
  };

  const saveWaiver = async (): Promise<boolean> => {
    if (!dojoId) return true;
    setSavingWaiver(true);
    try {
      if (waiverId) {
        const { error } = await supabase
          .from("dojo_waivers")
          .update({ body_markdown: waiverBody })
          .eq("id", waiverId);
        if (error) throw error;
      } else {
        // Legacy path: no waiver was seeded (e.g. seed failed under RLS).
        // Insert one now so the gym always has an active waiver.
        const { data, error } = await supabase
          .from("dojo_waivers")
          .insert({
            dojo_id: dojoId,
            title: DEFAULT_WAIVER_TITLE,
            is_current: true,
            body_markdown: waiverBody,
          })
          .select("id")
          .single();
        if (error) throw error;
        if (data) setWaiverId(data.id);
      }
      toast.success("Waiver saved");
      return true;
    } catch (err: any) {
      toast.error(err?.message ?? "Could not save waiver");
      return false;
    } finally {
      setSavingWaiver(false);
    }
  };

  const finishSetup = async (saveFirst: boolean) => {
    if (saveFirst) {
      const ok = await saveWaiver();
      if (!ok) return;
    }
    // Refresh auth roles so isStaff/isManager reflect the new owner membership
    // before the app frame re-evaluates sidebar/view. Without this, the user
    // lands on "/" but the sidebar still renders member navigation.
    await refreshRoles();
    await refresh();
    toast.success(`Welcome to ${dojoName || "your dojo"}`);
    router.navigate({ to: "/" });
  };

  const intervalLabel = (i: DraftPlan["interval"]) =>
    i === "month" ? "/mo" : i === "year" ? "/yr" : " one-time";

  return (
    <div className="grid min-h-screen place-items-center bg-background px-4 py-10">
      <div className="w-full max-w-xl">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 grid size-12 place-items-center rounded-md bg-primary text-primary-foreground">
            <Building2 className="size-6" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Welcome to Sthenos</h1>
          {dojoId ? (
            <p className="mt-2 text-sm text-muted-foreground">Step {step} of 3</p>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              Set up your gym to get started.
            </p>
          )}
        </div>

        <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
          {step === 1 ? (

            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium">Dojo name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Iron Wolves BJJ Academy"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
                  required
                  minLength={2}
                  maxLength={80}
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  You become the owner. You can invite coaches and add members afterwards.
                </p>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium">Country</label>
                <select
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  required
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="">Select your country</option>
                  {CONNECT_COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>{c.label}</option>
                  ))}
                </select>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  The country your gym is registered in. Used when you connect your payout
                  account &mdash; Stripe won&rsquo;t let it change once payouts are connected.
                </p>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium">Default currency</label>
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  required
                  disabled={!country}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
                >
                  <option value="">
                    {country ? "Select your currency" : "Choose a country first"}
                  </option>
                  {currencyChoices.map((c) => (
                    <option key={c} value={c}>{c.toUpperCase()}</option>
                  ))}
                </select>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Only currencies Stripe supports for your country are listed. New membership
                  plans use this by default.
                </p>
              </div>
              <button
                type="submit"
                disabled={busy || !name.trim() || !country || !currency}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {busy && <Loader2 className="size-4 animate-spin" />}
                Next
              </button>
            </form>
          ) : step === 2 ? (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold">Set up your membership plans</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Add the plans members can sign up to. You can edit or add more later.
                </p>
              </div>

              {plans.length > 0 && (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {plans.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3 p-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{p.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {currencySymbol(currency)}
                          {(p.price_cents / 100).toFixed(2)}
                          {intervalLabel(p.interval)}
                          {p.description ? ` — ${p.description}` : ""}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => removePlan(p.id)}
                        className="shrink-0 rounded-md border border-input bg-background p-2 text-muted-foreground hover:text-destructive"
                        aria-label={`Remove ${p.name}`}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <form onSubmit={addPlan} className="space-y-3 rounded-md border border-border p-4">
                <div>
                  <label className="mb-1.5 block text-sm font-medium">Plan name</label>
                  <input
                    type="text"
                    value={planName}
                    onChange={(e) => setPlanName(e.target.value)}
                    placeholder="e.g. Unlimited Monthly"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium">Price</label>
                    <div className="flex">
                      <span className="inline-flex items-center rounded-l-md border border-r-0 border-input bg-muted px-3 text-sm text-muted-foreground">
                        {currencySymbol(currency)}
                      </span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={planPrice}
                        onChange={(e) => setPlanPrice(e.target.value)}
                        placeholder="0.00"
                        className="w-full rounded-r-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium">Currency</label>
                    <input
                      type="text"
                      value={currency.toUpperCase()}
                      readOnly
                      className="w-full cursor-not-allowed rounded-md border border-input bg-muted px-3 py-2 text-sm text-muted-foreground"
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium">Interval</label>
                    <select
                      value={planInterval}
                      onChange={(e) => setPlanInterval(e.target.value as DraftPlan["interval"])}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
                    >
                      <option value="month">Monthly</option>
                      <option value="year">Yearly</option>
                      <option value="one_time">One-time</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium">Description (optional)</label>
                  <input
                    type="text"
                    value={planDescription}
                    onChange={(e) => setPlanDescription(e.target.value)}
                    placeholder="e.g. Access to all classes"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
                <button
                  type="submit"
                  disabled={addingPlan || !planName.trim() || !planPrice.trim()}
                  className="inline-flex items-center justify-center gap-2 rounded-md border border-input bg-background px-4 py-2 text-sm font-semibold transition-colors hover:bg-accent disabled:opacity-50"
                >
                  {addingPlan ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                  Add plan
                </button>
              </form>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setStep(3)}
                  className="flex-1 rounded-md border border-input bg-background px-4 py-2 text-sm font-semibold hover:bg-accent"
                >
                  Skip for now
                </button>
                <button
                  type="button"
                  onClick={() => setStep(3)}
                  className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
                >
                  Next
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold">Your membership waiver</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  This is the waiver your members will sign at signup. Review and edit it before you open your doors.
                </p>
              </div>

              <textarea
                value={waiverBody}
                onChange={(e) => setWaiverBody(e.target.value)}
                rows={12}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
              />

              <div className="flex flex-wrap gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => saveWaiver()}
                  disabled={savingWaiver || !dojoId}
                  className="inline-flex items-center justify-center gap-2 rounded-md border border-input bg-background px-4 py-2 text-sm font-semibold hover:bg-accent disabled:opacity-50"
                >
                  {savingWaiver ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                  Save waiver
                </button>
                <button
                  type="button"
                  onClick={() => finishSetup(false)}
                  className="rounded-md border border-input bg-background px-4 py-2 text-sm font-semibold hover:bg-accent"
                >
                  Skip for now
                </button>
                <button
                  type="button"
                  onClick={() => finishSetup(true)}
                  disabled={savingWaiver}
                  className="ml-auto inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  Looks good, finish setup
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
