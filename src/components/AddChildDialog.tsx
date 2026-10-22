import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { GUARDIAN_RELATIONSHIPS, isUnder18 } from "@/lib/minors";
import { addMyChild, getAddChildContext } from "@/lib/my-children.functions";
import { createCheckoutSession } from "@/lib/payments.functions";

function money(cents: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: (currency || "eur").toUpperCase(),
  }).format(cents / 100);
}

function per(interval: string) {
  return interval === "year" ? "a year" : interval === "one_time" ? "one-off" : "a month";
}

/**
 * An adult member adding their own child: who they are, how old they are, a
 * signed waiver, and the membership the parent is agreeing to pay for.
 *
 * Each child is an ordinary member with their own plan and their own
 * subscription. There is deliberately no family plan and no sibling discount
 * here -- the gym asked for the ability to add children, not for family
 * pricing, and coupling the two put a billing concept in front of a
 * safeguarding one.
 */
export function AddChildDialog({ dojoId }: { dojoId: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");
  const [phone, setPhone] = useState("");
  const [relationship, setRelationship] = useState("");
  const [planId, setPlanId] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [termsAgreed, setTermsAgreed] = useState(false);
  const [signedName, setSignedName] = useState("");

  const qc = useQueryClient();
  const ctxFn = useServerFn(getAddChildContext);
  const addFn = useServerFn(addMyChild);
  const checkoutFn = useServerFn(createCheckoutSession);

  const { data: ctx } = useQuery({
    queryKey: ["add-child-context", dojoId],
    enabled: !!dojoId,
    queryFn: () => ctxFn({ data: { dojoId } }),
  });

  const reset = () => {
    setName("");
    setDob("");
    setPhone("");
    setRelationship("");
    setPlanId("");
    setAgreed(false);
    setSignedName("");
  };

  const add = useMutation({
    mutationFn: () =>
      addFn({
        data: {
          dojoId,
          name: name.trim(),
          dateOfBirth: dob,
          relationship,
          phone: phone.trim() || null,
          planId,
          waiverAgreed: agreed,
          termsAgreed,
          signedName: signedName.trim(),
        },
      }),
    onSuccess: async (res: any) => {
      qc.invalidateQueries({ queryKey: ["add-child-context", dojoId] });
      // The child now exists whether or not checkout opens. Without this, a
      // checkout that fails closes the dialog onto a stale "My children" list
      // -- empty, if they had none before -- and the child only appears after
      // a full reload.
      qc.invalidateQueries({ queryKey: ["my-children", dojoId] });
      // The new child is someone this login can now act for, so the portal's
      // switcher has to know about them.
      qc.invalidateQueries({ queryKey: ["my-members"] });
      // Straight to Stripe. The child exists either way, so a checkout that
      // cannot be created leaves a record the gym can pick up rather than
      // losing the whole thing.
      try {
        const out: any = await checkoutFn({
          data: { dojoId, memberId: res.childId, planId, returnPath: "/portal" },
        });
        if (out?.url) {
          window.location.href = out.url;
          return;
        }
        // Added, but not paid for. That is not a success -- saying so is how
        // a broken checkout looked like a working one.
        toast.warning(
          `${res.childName} was added, but payment couldn't be started${out?.error ? `: ${out.error}` : ""}. Tell your gym so they can set it up.`,
        );
      } catch (e: any) {
        toast.warning(
          `${res.childName} was added, but payment couldn't be started. Tell your gym so they can set it up.`,
        );
        console.error("[add-child] checkout failed", e);
      }
      setOpen(false);
      reset();
    },
    onError: (e: any) => toast.error(e?.message ?? "Couldn't add them. Please try again."),
  });

  if (!ctx || !ctx.canAdd) return null;

  const dobGiven = dob.trim().length > 0;
  const tooOld = dobGiven && !isUnder18(dob);
  const chosenPlan = ctx.plans.find((p) => p.id === planId) ?? null;
  const canSubmit =
    name.trim().length >= 2 &&
    dobGiven &&
    !tooOld &&
    relationship.trim().length > 0 &&
    !!chosenPlan &&
    agreed &&
    (!ctx.terms || termsAgreed) &&
    signedName.trim().length >= 2;

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-zinc-950/5 pt-4">
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Add my child
        </Button>
        <span className="text-xs text-muted-foreground">
          {ctx.childCount === 0
            ? "Training here with a son or daughter? Add them and choose their membership."
            : `You've added ${ctx.childCount} ${ctx.childCount === 1 ? "child" : "children"}.`}
        </span>
      </div>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset();
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add your child</DialogTitle>
            <DialogDescription>
              They'll get their own profile, attendance and belt tracking, with you recorded as
              their parent or guardian. Choose their membership below and you'll be taken to
              payment.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="childName">Child's full name</Label>
              <Input
                id="childName"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Maria Georgiou"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="childDob">Date of birth</Label>
                <Input
                  id="childDob"
                  type="date"
                  value={dob}
                  onChange={(e) => setDob(e.target.value)}
                />
                {tooOld && (
                  <p className="text-xs text-destructive">
                    They're 18 or over, so they'll need to join in their own name.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="childRel">You are their</Label>
                <Select value={relationship} onValueChange={setRelationship}>
                  <SelectTrigger id="childRel">
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {GUARDIAN_RELATIONSHIPS.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="childPhone">Their phone (optional)</Label>
              <Input
                id="childPhone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+357 99 123456"
              />
            </div>

            {/* The parent chooses the membership and agrees to it here, rather
                than the gym guessing afterwards. */}
            <div className="space-y-2">
              <Label>Their membership</Label>
              {ctx.plans.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Your gym hasn't published any memberships yet. Add your child and they'll sort
                  it out with you.
                </p>
              ) : (
                <div className="grid gap-2">
                  {ctx.plans.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setPlanId(p.id)}
                      className={`rounded-lg border p-3 text-left transition ${
                        planId === p.id
                          ? "border-brand bg-brand/5 ring-1 ring-brand"
                          : "border-zinc-950/10 hover:border-zinc-950/20"
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm font-semibold">{p.name}</span>
                        <span className="text-sm font-semibold tabular-nums">
                          {money(p.priceCents, p.currency)}{" "}
                          <span className="font-normal text-muted-foreground">
                            {per(p.interval)}
                          </span>
                        </span>
                      </div>
                      {p.description && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{p.description}</p>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {chosenPlan && (
                <p className="text-xs text-muted-foreground">
                  You'll pay {money(chosenPlan.priceCents, chosenPlan.currency)}{" "}
                  {per(chosenPlan.interval)} for {name.trim() || "your child"}. You can change or
                  cancel it later from your portal.
                </p>
              )}
            </div>

            {ctx.waiver && (
              <div className="space-y-3">
                <div className="rounded-lg bg-surface p-3 ring-1 ring-black/5">
                  <h4 className="text-sm font-semibold">{ctx.waiver.title}</h4>
                  <div className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">
                    {ctx.waiver.body}
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="childWaiver"
                    checked={agreed}
                    onCheckedChange={(v) => setAgreed(v === true)}
                    className="mt-0.5"
                  />
                  <Label htmlFor="childWaiver" className="text-sm font-normal leading-snug">
                    I am the parent or legal guardian of {name.trim() || "this child"}, and I
                    have read and agree to this waiver on their behalf.
                  </Label>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="childSig">Signature (type your full name)</Label>
                  <Input
                    id="childSig"
                    value={signedName}
                    onChange={(e) => setSignedName(e.target.value)}
                    placeholder={ctx.myName}
                  />
                </div>
              </div>
            )}

            {/* The gym's terms, where it has any. Asked for here so the child
                arrives with everything signed, rather than being told to
                accept an "update" the moment their portal opens. */}
            {ctx.terms && (
              <div className="space-y-3">
                <div className="rounded-lg bg-surface p-3 ring-1 ring-black/5">
                  <h4 className="text-sm font-semibold">{ctx.terms.title}</h4>
                  <div className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">
                    {ctx.terms.body}
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="childTerms"
                    checked={termsAgreed}
                    onCheckedChange={(v) => setTermsAgreed(v === true)}
                    className="mt-0.5"
                  />
                  <Label htmlFor="childTerms" className="text-sm font-normal leading-snug">
                    I have read and agree to these terms &amp; conditions on their behalf.
                  </Label>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!canSubmit || add.isPending}
              onClick={() => add.mutate()}
              className="bg-brand text-brand-foreground hover:bg-brand/90"
            >
              {add.isPending
                ? "Adding…"
                : chosenPlan
                  ? "Add and pay"
                  : "Add my child"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
