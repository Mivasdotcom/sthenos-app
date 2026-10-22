import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useSetPaymentMethod } from "@/components/use-set-payment-method";
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
import { isMinor } from "@/lib/consent";

interface MemberLite {
  id: string;
  dojo_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  discipline: string;
  plan: "Monthly" | "Annual" | "Drop-in" | "Family";
  status: "active" | "lapsed" | "trial";
}

interface Props {
  member: MemberLite | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

import { buildDisciplineOptions } from "@/lib/belt-colors";
import { EndMembershipDialog } from "@/components/EndMembershipDialog";
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

export function EditMemberDialog({ member, open, onOpenChange }: Props) {
  const { activeDojoId } = useCurrentDojo();
  const qc = useQueryClient();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [discipline, setDiscipline] = useState("");
  const [planId, setPlanId] = useState<string>(NO_PLAN);
  const [status, setStatus] = useState<"active" | "lapsed" | "trial">("active");
  const [paymentMethod, setPaymentMethod] = useState<"card" | "cash">("card");
  const { setPaymentMethod: setPaymentMethodForMembers, dialog: paymentMethodDialog } =
    useSetPaymentMethod(member?.dojo_id ?? null);
  const [mediaConsent, setMediaConsent] = useState(false);
  const [dateOfBirth, setDateOfBirth] = useState("");
  // Who stands behind a member under 18. Recorded at signup, and until now
  // impossible to correct afterwards -- so a record entered in a parent's name
  // could be fixed to the child's, and then had no parent on it at all.
  const [guardianName, setGuardianName] = useState("");
  const [guardianEmail, setGuardianEmail] = useState("");
  const [guardianPhone, setGuardianPhone] = useState("");
  const [guardianRelationship, setGuardianRelationship] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [endOpen, setEndOpen] = useState(false);

  const { data: classTypes = [] } = useQuery({
    queryKey: ["edit-member-class-types", activeDojoId],
    enabled: !!activeDojoId && open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("dojo_class_types")
        .select("discipline")
        .eq("dojo_id", activeDojoId!)
        .order("sort_order");
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: plans = [] } = useQuery({
    queryKey: ["edit-member-plans", activeDojoId],
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

  const { data: fullMember } = useQuery({
    queryKey: ["edit-member", member?.id],
    enabled: !!member?.id && open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("members")
        .select(
          "id, selected_plan_id, plan, payment_method, media_consent, date_of_birth, guardian_name, guardian_email, guardian_phone, guardian_relationship",
        )
        .eq("id", member!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  // The gym's own disciplines, plus whatever this member already has recorded so
  // an existing value is never dropped or made unselectable.
  const disciplineOptions: string[] = useMemo(() => {
    const gym = (classTypes as Array<{ discipline: string | null }>)
      .map((c) => c.discipline)
      .filter(Boolean) as string[];
    const opts = buildDisciplineOptions(gym);
    if (!discipline) return opts;
    const key = (s: string) => s.toLowerCase().replace(/[\s._-]+/g, " ").trim();
    return opts.some((o) => key(o) === key(discipline)) ? opts : [...opts, discipline];
  }, [classTypes, discipline]);


  useEffect(() => {
    if (member) {
      setName(member.name);
      setEmail(member.email ?? "");
      setPhone(member.phone ?? "");
      setDiscipline(member.discipline);
      setStatus(member.status);
    }
  }, [member]);

  useEffect(() => {
    if (fullMember) {
      setPlanId(fullMember.selected_plan_id ?? NO_PLAN);
      setPaymentMethod((fullMember as any).payment_method === "cash" ? "cash" : "card");
      setMediaConsent((fullMember as any).media_consent === true);
      setDateOfBirth(((fullMember as any).date_of_birth as string | null) ?? "");
      setGuardianName(((fullMember as any).guardian_name as string | null) ?? "");
      setGuardianEmail(((fullMember as any).guardian_email as string | null) ?? "");
      setGuardianPhone(((fullMember as any).guardian_phone as string | null) ?? "");
      setGuardianRelationship(
        ((fullMember as any).guardian_relationship as string | null) ?? "",
      );
    } else if (member) {
      setPlanId(NO_PLAN);
    }
  }, [fullMember, member]);

  function reset() {
    setName("");
    setEmail("");
    setPhone("");
    setDiscipline("");
    setPlanId(NO_PLAN);
    setStatus("active");
    setPaymentMethod("card");
    setMediaConsent(false);
    setDateOfBirth("");
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
    if (!member || !activeDojoId || submitting) return;
    if (name.trim().length < 2) {
      toast.error("Name must be at least 2 characters");
      return;
    }
    if (!discipline) {
      toast.error("Please choose a discipline");
      return;
    }

    setSubmitting(true);
    // Lapsing a member must stop Stripe/cash billing first, so it can never be
    // done by a plain row update — we save the other edits, then hand off to
    // the End membership flow.
    const lapsing = status === "lapsed" && member.status !== "lapsed";
    const selectedPlan = plans.find((p) => p.id === planId) ?? null;

    const priorConsent = (fullMember as any)?.media_consent === true;
    const updates: {
      name: string;
      phone: string | null;
      discipline: string;
      status: "active" | "lapsed" | "trial";
      selected_plan_id: string | null;
      media_consent: boolean;
      media_consent_at: string | null;
      date_of_birth: string | null;
      guardian_name: string | null;
      guardian_email: string | null;
      guardian_phone: string | null;
      guardian_relationship: string | null;
      plan?: "Monthly" | "Annual" | "Drop-in" | "Family";
    } = {
      name: name.trim(),
      phone: phone.trim() || null,
      discipline,
      status,
      selected_plan_id: planId === NO_PLAN ? null : planId,
      media_consent: mediaConsent,
      media_consent_at: mediaConsent
        ? priorConsent
          ? ((fullMember as any)?.media_consent_at ?? new Date().toISOString())
          : new Date().toISOString()
        : null,
      date_of_birth: dateOfBirth.trim() || null,
      guardian_name: guardianName.trim() || null,
      guardian_email: guardianEmail.trim() || null,
      guardian_phone: guardianPhone.trim() || null,
      guardian_relationship: guardianRelationship.trim() || null,
    };
    if (lapsing) delete (updates as { status?: unknown }).status;
    if (selectedPlan) {
      updates.plan = planLabel(selectedPlan.interval);
    }

    const { error } = await supabase
      .from("members")
      .update(updates)
      .eq("id", member.id);

    if (error) {
      toast.error(error.message);
      setSubmitting(false);
      return;
    }

    // Payment method goes through the shared setter so switching a card member
    // with live Stripe billing to cash asks for explicit confirmation first.
    const priorMethod = (fullMember as any)?.payment_method === "cash" ? "cash" : "card";
    if (paymentMethod !== priorMethod) {
      setPaymentMethodForMembers([member!.id], paymentMethod);
    }

    toast.success("Member updated");
    qc.invalidateQueries({ queryKey: ["members"] });
    qc.invalidateQueries({ queryKey: ["member", member.id] });
    setSubmitting(false);
    onOpenChange(false);
    if (lapsing) setEndOpen(true);
  }

  const fmtPrice = (cents: number, currency: string) =>
    (cents / 100).toLocaleString(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
      maximumFractionDigits: 0,
    });

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {member?.name}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="edit-member-name">Full name</Label>
            <Input
              id="edit-member-name"
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
              <Label htmlFor="edit-member-email">Email</Label>
              <Input id="edit-member-email" type="email" value={email} disabled readOnly />
              <p className="text-xs text-muted-foreground">
                Use “Change email” on the Contact card — the login and receipts are updated
                with it.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-member-phone">Phone</Label>
              <Input
                id="edit-member-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                maxLength={40}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-member-dob">Date of birth</Label>
            <Input
              id="edit-member-dob"
              type="date"
              value={dateOfBirth}
              onChange={(e) => setDateOfBirth(e.target.value)}
            />
          </div>

          {/* Shown for anyone under 18, and for anyone who already has a
              guardian on file, so correcting a date of birth reveals the
              fields that correction implies rather than leaving a child with
              no parent recorded. */}
          {(isMinor(dateOfBirth || null) || guardianName.trim().length > 0) && (
            <div className="space-y-3 rounded-md border border-black/5 p-3">
              <div>
                <div className="text-sm font-medium">Parent or guardian</div>
                <p className="text-xs text-muted-foreground">
                  Who the gym deals with about this membership.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="edit-guardian-name">Full name</Label>
                  <Input
                    id="edit-guardian-name"
                    value={guardianName}
                    onChange={(e) => setGuardianName(e.target.value)}
                    maxLength={100}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-guardian-relationship">Relationship</Label>
                  <Input
                    id="edit-guardian-relationship"
                    value={guardianRelationship}
                    onChange={(e) => setGuardianRelationship(e.target.value)}
                    placeholder="Mother, father, guardian…"
                    maxLength={40}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-guardian-email">Email</Label>
                  <Input
                    id="edit-guardian-email"
                    type="email"
                    value={guardianEmail}
                    onChange={(e) => setGuardianEmail(e.target.value)}
                    maxLength={200}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-guardian-phone">Phone</Label>
                  <Input
                    id="edit-guardian-phone"
                    value={guardianPhone}
                    onChange={(e) => setGuardianPhone(e.target.value)}
                    maxLength={40}
                  />
                </div>
              </div>
            </div>
          )}

          <label className="flex items-start gap-2 rounded-md border border-black/5 p-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={mediaConsent}
              onChange={(e) => setMediaConsent(e.target.checked)}
            />
            <span>
              Media consent granted
              <span className="block text-xs text-muted-foreground">
                {isMinor(dateOfBirth || null)
                  ? "This member is under 18 — a parent or guardian must agree."
                  : "Optional permission to use photos and training footage for marketing."}
              </span>
            </span>
          </label>



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
            <Label>Plan</Label>
            <Select value={planId} onValueChange={setPlanId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose plan" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PLAN}>
                  {member?.plan ? `No linked plan (currently: ${member.plan})` : "No plan assigned"}
                </SelectItem>
                {plans.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} — {fmtPrice(p.price_cents, p.currency)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {plans.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No plans defined yet. Create plans in Settings → Plans.
              </p>
            )}
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
            <Label>Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as "active" | "lapsed" | "trial")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="lapsed">Lapsed</SelectItem>
                <SelectItem value="trial">Trial</SelectItem>
              </SelectContent>
            </Select>
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
              {submitting ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <EndMembershipDialog
      open={endOpen}
      onOpenChange={setEndOpen}
      dojoId={activeDojoId ?? null}
      member={member ? { id: member.id, name: member.name } : null}
      source="edit member"
    />
    {paymentMethodDialog}
    </>
  );
}
