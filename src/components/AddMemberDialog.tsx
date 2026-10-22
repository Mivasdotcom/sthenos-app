import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { Checkbox } from "@/components/ui/checkbox";
import { MEDIA_CONSENT_HINT, isMinor, mediaConsentLabel } from "@/lib/consent";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

import { getBeltColors } from "@/lib/crm-presets";
import { buildDisciplineOptions, RANK_LABELS } from "@/lib/belt-colors";
import { LEAD_SOURCES, REFERRAL_LEAD_SOURCE } from "@/lib/lead-sources";

const NO_PLAN = "__none__";

type PlanRow = {
  id: string;
  name: string;
  price_cents: number;
  currency: string;
  interval: string | null;
};

function planLabel(interval: string | null): "Monthly" | "Annual" | "Drop-in" {
  if (interval === "year") return "Annual";
  if (interval === "one_time") return "Drop-in";
  return "Monthly";
}

export function AddMemberDialog({ open, onOpenChange }: Props) {
  const { activeDojoId, activeDojo } = useCurrentDojo();
  const qc = useQueryClient();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [discipline, setDiscipline] = useState("");
  const [beltColor, setBeltColor] = useState<string>("beginner");
  const [planId, setPlanId] = useState<string>(NO_PLAN);
  const [status, setStatus] = useState<"active" | "trial">("active");
  const [paymentMethod, setPaymentMethod] = useState<"card" | "cash">("card");
  const [leadSource, setLeadSource] = useState<string>("");
  const [referredBy, setReferredBy] = useState("");
  const [mediaConsent, setMediaConsent] = useState(false);
  const [guardianName, setGuardianName] = useState("");
  const [guardianEmail, setGuardianEmail] = useState("");
  const [guardianPhone, setGuardianPhone] = useState("");
  const [guardianRelationship, setGuardianRelationship] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const dojoName = (activeDojo as any)?.name ?? "the gym";
  const isUnder18 = isMinor(dateOfBirth || null);


  const { data: classTypes = [] } = useQuery({
    queryKey: ["class-types", activeDojoId],
    enabled: !!activeDojoId,
    queryFn: async () => {
      const { data } = await supabase
        .from("dojo_class_types")
        .select("id, name, discipline")
        .eq("dojo_id", activeDojoId!);
      return data ?? [];
    },
  });

  const { data: dojoRow } = useQuery({
    queryKey: ["add-member-dojo", activeDojoId],
    enabled: !!activeDojoId && open,
    queryFn: async () => {
      const { data } = await supabase
        .from("dojos")
        .select("pass_platform_fee_to_members")
        .eq("id", activeDojoId!)
        .maybeSingle();
      return data;
    },
  });
  const passFee = !!dojoRow?.pass_platform_fee_to_members;

  const { data: plans = [] } = useQuery({
    queryKey: ["add-member-plans", activeDojoId],
    enabled: !!activeDojoId && open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("dojo_plans")
        .select("id, name, price_cents, currency, interval")
        .eq("dojo_id", activeDojoId!)
        .eq("is_active", true)
        .order("sort_order");
      if (error) throw error;
      return (data ?? []) as PlanRow[];
    },
  });

  const disciplineOptions: string[] = buildDisciplineOptions(
    (classTypes as Array<{ discipline: string | null }>)
      .map((c) => c.discipline)
      .filter(Boolean) as string[],
  );


  const beltColorOptions = getBeltColors(discipline);

  // Default discipline once options are known
  useEffect(() => {
    if (!discipline && disciplineOptions.length > 0) {
      setDiscipline(disciplineOptions[0]);
    }
  }, [disciplineOptions, discipline]);

  // Reset belt color when discipline changes
  useEffect(() => {
    if (discipline) {
      setBeltColor(getBeltColors(discipline)[0] ?? "beginner");
    }
  }, [discipline]);

  function reset() {
    setName("");
    setEmail("");
    setPhone("");
    setDateOfBirth("");
    setDiscipline("");
    setBeltColor("beginner");
    setPlanId(NO_PLAN);
    setStatus("active");
    setPaymentMethod("card");
    setLeadSource("");
    setReferredBy("");
    setMediaConsent(false);
    setGuardianName("");
    setGuardianEmail("");
    setGuardianPhone("");
    setGuardianRelationship("");
  }

  useEffect(() => {
    if (!open) reset();
  }, [open]);


  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!activeDojoId || submitting) return;
    if (name.trim().length < 2) {
      toast.error("Name must be at least 2 characters");
      return;
    }
    if (!discipline) {
      toast.error("Please choose a discipline");
      return;
    }
    if (leadSource === REFERRAL_LEAD_SOURCE && referredBy.trim().length < 2) {
      toast.error("Please enter who referred them");
      return;
    }
    if (isUnder18 && (guardianName.trim().length < 2 || !guardianEmail.trim())) {
      toast.error("Under-18 members need a parent or guardian name and email");
      return;
    }

    setSubmitting(true);
    const selectedPlan = plans.find((p) => p.id === planId) ?? null;
    const planValue = planLabel(selectedPlan?.interval ?? null);

    const { error } = await supabase.from("members").insert({
      dojo_id: activeDojoId,
      name: name.trim(),
      email: email.trim() || null,
      phone: phone.trim() || null,
      discipline,
      selected_plan_id: planId === NO_PLAN ? null : planId,
      plan: planValue,
      status,
      payment_method: paymentMethod,
      payment_status: "none",
      belt_color: beltColor as any,
      belt_label: RANK_LABELS[beltColor as keyof typeof RANK_LABELS] ?? `${beltColor[0].toUpperCase()}${beltColor.slice(1)}`,
      stripes: 0,
      joined_at: new Date().toISOString(),
      waiver_signed_at: null,
      marketing_opt_out: false,
      signup_source: "manager_added",
      lead_source: leadSource || null,
      referred_by:
        leadSource === REFERRAL_LEAD_SOURCE ? referredBy.trim() || null : null,
      date_of_birth: dateOfBirth || null,
      guardian_name: isUnder18 ? guardianName.trim() || null : null,
      guardian_email: isUnder18 ? guardianEmail.trim() || null : null,
      guardian_phone: isUnder18 ? guardianPhone.trim() || null : null,
      guardian_relationship: isUnder18 ? guardianRelationship.trim() || null : null,
      media_consent: mediaConsent,
      media_consent_at: mediaConsent ? new Date().toISOString() : null,
    });


    if (error) {
      toast.error(error.message);
      setSubmitting(false);
      return;
    }

    toast.success("Member added");
    qc.invalidateQueries({ queryKey: ["members", activeDojoId] });
    setSubmitting(false);
    onOpenChange(false);
  }

  const fmtPrice = (cents: number, currency: string) =>
    (cents / 100).toLocaleString(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
      maximumFractionDigits: 0,
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Member</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="add-member-name">Full name</Label>
            <Input
              id="add-member-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={2}
              maxLength={120}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="add-member-email">Email</Label>
              <Input
                id="add-member-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                maxLength={255}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-member-phone">Phone</Label>
              <Input
                id="add-member-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                maxLength={40}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-member-dob">Date of birth (optional)</Label>
            <Input
              id="add-member-dob"
              type="date"
              value={dateOfBirth}
              onChange={(e) => setDateOfBirth(e.target.value)}
            />
          </div>

          {isUnder18 && (
            <div className="space-y-3 rounded-lg bg-muted/40 p-3">
              <div>
                <div className="text-sm font-medium">Parent or guardian</div>
                <p className="text-xs text-muted-foreground">
                  This member is under 18. The guardian signs the waiver and receives all
                  membership emails.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="add-member-guardian-name">Guardian full name</Label>
                  <Input
                    id="add-member-guardian-name"
                    value={guardianName}
                    onChange={(e) => setGuardianName(e.target.value)}
                    maxLength={200}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="add-member-guardian-rel">Relationship</Label>
                  <Input
                    id="add-member-guardian-rel"
                    value={guardianRelationship}
                    onChange={(e) => setGuardianRelationship(e.target.value)}
                    placeholder="Parent, guardian…"
                    maxLength={60}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="add-member-guardian-email">Guardian email</Label>
                  <Input
                    id="add-member-guardian-email"
                    type="email"
                    value={guardianEmail}
                    onChange={(e) => setGuardianEmail(e.target.value)}
                    maxLength={255}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="add-member-guardian-phone">Guardian phone</Label>
                  <Input
                    id="add-member-guardian-phone"
                    value={guardianPhone}
                    onChange={(e) => setGuardianPhone(e.target.value)}
                    maxLength={40}
                  />
                </div>
              </div>
            </div>
          )}



          <div className="space-y-1.5">
            <Label>Discipline</Label>
            <Select value={discipline} onValueChange={setDiscipline}>
              <SelectTrigger>
                <SelectValue placeholder="Choose discipline" />
              </SelectTrigger>
              <SelectContent>
                {disciplineOptions.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Belt / rank</Label>
            <Select value={beltColor} onValueChange={setBeltColor}>
              <SelectTrigger>
                <SelectValue placeholder="Choose belt" />
              </SelectTrigger>
              <SelectContent>
                {beltColorOptions.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c === "beginner" ? "Beginner — never trained before" : (RANK_LABELS[c] ?? `${c[0].toUpperCase()}${c.slice(1)}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Plan</Label>
            <Select value={planId} onValueChange={setPlanId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose plan" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PLAN}>No plan assigned</SelectItem>
                {plans.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} — {fmtPrice(p.price_cents, p.currency)}
                    {passFee && p.price_cents > 0 ? " (+1% platform fee)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Payment method</Label>
            <Select value={paymentMethod} onValueChange={(v) => setPaymentMethod(v as "card" | "cash")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="card">Card (online via Stripe)</SelectItem>
                <SelectItem value="cash">Cash / offline</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {paymentMethod === "cash"
                ? "Cash members don't go through Stripe — record their payments manually."
                : "Card members pay online through Stripe checkout."}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>How did you hear about us?</Label>
            <Select value={leadSource} onValueChange={setLeadSource}>
              <SelectTrigger>
                <SelectValue placeholder="Choose an option" />
              </SelectTrigger>
              <SelectContent>
                {LEAD_SOURCES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {leadSource === REFERRAL_LEAD_SOURCE && (
            <div className="space-y-1.5">
              <Label htmlFor="add-member-referred-by">Who referred you?</Label>
              <Input
                id="add-member-referred-by"
                value={referredBy}
                onChange={(e) => setReferredBy(e.target.value)}
                placeholder="Their name"
                maxLength={120}
                required
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as "active" | "trial")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="trial">Trial</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex items-start gap-3">
              <Checkbox
                id="add-member-media-consent"
                checked={mediaConsent}
                onCheckedChange={(v) => setMediaConsent(Boolean(v))}
                className="mt-0.5"
              />
              <Label
                htmlFor="add-member-media-consent"
                className="text-sm font-normal leading-snug"
              >
                {mediaConsentLabel(dojoName, isUnder18).replace(/^I confirm that, as parent or guardian, I consent/, "Parent/guardian consents")}
                <span className="mt-1 block text-xs text-muted-foreground">
                  {MEDIA_CONSENT_HINT}
                </span>
              </Label>
            </div>
            {isUnder18 && (
              <p className="text-xs font-medium text-amber-600">
                Under 18 — only tick this if a parent or guardian has agreed.
              </p>
            )}
          </div>


          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting}
              className="bg-brand text-brand-foreground hover:bg-brand/90"
            >
              {submitting ? "Adding…" : "Add member"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
