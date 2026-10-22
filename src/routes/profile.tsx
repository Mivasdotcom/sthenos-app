import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Loader2, User, AlertTriangle, CheckCircle2, CreditCard } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useServerFn } from "@tanstack/react-start";
import { notifyCancellationRequested } from "@/lib/cancellation.functions";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { supabase } from "@/integrations/supabase/client";
import { ChangeMemberEmailDialog } from "@/components/ChangeMemberEmailDialog";
import { toast } from "sonner";
import { MemberPaymentAction, useMemberBilling } from "@/components/MemberPaymentAction";
import { isCashPayer } from "@/lib/cash-payments";

export const Route = createFileRoute("/profile")({
  head: () => ({
    meta: [
      { title: "My Profile \u2014 Sthenos" },
      { name: "description", content: "Update your contact details or hand notice to your gym." },
    ],
  }),
  component: ProfilePage,
});

function ProfilePage() {
  const { user, isStaff } = useAuth();
  const { activeDojoId } = useCurrentDojo();
  const queryClient = useQueryClient();
  const profileKey = ["my-profile", user?.id, activeDojoId] as const;
  const readOnly = isStaff; // manager view = read-only

  const { data: member, isLoading } = useQuery({
    queryKey: profileKey,
    enabled: !!user?.id && !!activeDojoId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("members")
        .select("*")
        .eq("user_id", user!.id)
        .eq("dojo_id", activeDojoId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  if (isLoading) {
    return (
      <main>
        <PageHeader title="My Profile" subtitle="Loading…" />
        <div className="mx-auto flex max-w-2xl items-center justify-center p-16">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        </div>
      </main>
    );
  }

  if (!member) {
    return (
      <main>
        <PageHeader title="My Profile" subtitle="No member profile linked" />
        <div className="mx-auto max-w-2xl p-8">
          <div className="rounded-xl border border-dashed border-zinc-950/10 bg-card/50 p-6 text-center text-sm text-muted-foreground">
            Your profile isn't set up yet in this dojo. Contact your gym manager.
          </div>
        </div>
      </main>
    );
  }

  const invalidate = () => queryClient.invalidateQueries({ queryKey: profileKey });

  return (
    <main>
      <PageHeader
        title="My Profile"
        subtitle={
          readOnly
            ? "Read-only in manager view. Switch to Member view to edit."
            : "Update your details or hand notice to your gym."
        }
      />
      <div className="mx-auto max-w-3xl space-y-6 p-8">
        <ContactSection member={member} onSaved={invalidate} readOnly={readOnly} />
        <AccountEmailSection />
        <PaymentSection member={member} dojoId={activeDojoId} />
        <CancellationSection member={member} onSaved={invalidate} readOnly={readOnly} />
        <div className="text-center text-xs text-muted-foreground">
          Looking for attendance and plan details?{" "}
          <Link to="/portal" className="underline hover:text-foreground">
            Go to your portal
          </Link>
          .
        </div>
      </div>
    </main>
  );
}


function PaymentSection({ member, dojoId }: { member: any; dojoId: string | null }) {
  const billingQ = useMemberBilling(member?.id, dojoId);
  const b = billingQ.data;
  const hasSub = !!b?.hasActiveSubscription;
  // Cash members pay at the dojo — no card prompt, no "not set up" copy.
  const isCash = isCashPayer(member?.payment_method);

  return (
    <section className="rounded-xl bg-card p-6 ring-1 ring-black/5">
      <div className="mb-2 flex items-center gap-2">
        <CreditCard className="size-4 text-brand" />
        <h2 className="font-display text-base font-medium">Payment</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        {isCash
          ? "You pay in cash at the dojo. Your gym records each payment — no card needed."
          : billingQ.isLoading
          ? "Checking your payment status…"
          : hasSub
            ? `Active subscription${b?.planName ? ` · ${b.planName}` : ""}${
                b?.subscription?.current_period_end
                  ? ` · next charge ${new Date(b.subscription.current_period_end).toLocaleDateString()}`
                  : ""
              }`
            : b?.planId
              ? "No payment set up yet. Add a card to start your membership."
              : "No plan assigned yet — ask your gym to assign a membership plan."}
      </p>
      {!isCash && (
        <div className="mt-4">
          <MemberPaymentAction
            memberId={member?.id}
            dojoId={dojoId}
            billing={b}
            returnPath="/profile"
          />
        </div>
      )}
    </section>
  );
}

function ContactSection({ member, onSaved, readOnly }: { member: any; onSaved: () => void; readOnly?: boolean }) {
  const [emailOpen, setEmailOpen] = useState(false);
  const [form, setForm] = useState({
    name: member.name ?? "",
    email: member.email ?? "",
    phone: member.phone ?? "",
    marketing_opt_out: !!member.marketing_opt_out,
  });

  useEffect(() => {
    setForm({
      name: member.name ?? "",
      email: member.email ?? "",
      phone: member.phone ?? "",
      marketing_opt_out: !!member.marketing_opt_out,
    });
  }, [member.id]);

  const save = useMutation({
    mutationFn: async () => {
      if (!form.name.trim()) throw new Error("Name is required");
      const { error } = await supabase.rpc("update_my_contact", {
        p_member_id: member.id,
        p_name: form.name.trim(),
        p_email: member.email || null,
        p_phone: form.phone.trim() || null,
        p_marketing_opt_out: form.marketing_opt_out,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Profile updated");
      onSaved();
    },
    onError: (e: any) => toast.error(e.message ?? "Failed to update"),
  });

  return (
    <section className="rounded-xl bg-card p-6 ring-1 ring-black/5">
      <div className="mb-4 flex items-center gap-2">
        <User className="size-4 text-brand" />
        <h2 className="font-display text-base font-medium">Your details</h2>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <Label>Full name</Label>
          <Input value={form.name} disabled={readOnly} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div>
          <Label>Email</Label>
          <Input type="email" value={form.email} disabled readOnly />
          {!readOnly && (
            <button
              type="button"
              className="mt-1 text-xs text-brand underline"
              onClick={() => setEmailOpen(true)}
            >
              Change email
            </button>
          )}
        </div>
        <div>
          <Label>Phone</Label>
          <Input value={form.phone} disabled={readOnly} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
        <div className="flex items-center justify-between rounded-md border border-border/60 p-3 md:col-span-1">
          <div>
            <Label className="m-0">Marketing emails</Label>
            <p className="text-xs text-muted-foreground">Receive promos and updates.</p>
          </div>
          <Switch
            checked={!form.marketing_opt_out}
            disabled={readOnly}
            onCheckedChange={(v) => setForm({ ...form, marketing_opt_out: !v })}
          />
        </div>
      </div>
      <div className="mt-4 text-xs text-muted-foreground">
        Belt rank, plan, and payment status are managed by your gym.
      </div>
      {!readOnly && (
        <div className="mt-4">
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      )}
      <ChangeMemberEmailDialog
        memberId={member.id}
        currentEmail={member.email}
        open={emailOpen}
        onOpenChange={(o) => {
          setEmailOpen(o);
          if (!o) onSaved();
        }}
      />
    </section>
  );
}

function CancellationSection({ member, onSaved, readOnly }: { member: any; onSaved: () => void; readOnly?: boolean }) {
  const requested = !!member.cancellation_requested_at;
  const [reason, setReason] = useState(member.cancellation_reason ?? "");
  const notifyCancellation = useServerFn(notifyCancellationRequested);

  const submit = useMutation({
    mutationFn: async () => {
      const reasonTrim = reason.trim() || null;
      const { error } = await supabase.rpc("request_my_cancellation", {
        p_member_id: member.id,
        p_reason: reasonTrim,
      });
      if (error) throw error;
      if (member.email) {
        try {
          const { data: sess } = await supabase.auth.getSession();
          await fetch("/lovable/email/transactional/send", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(sess.session?.access_token
                ? { Authorization: `Bearer ${sess.session.access_token}` }
                : {}),
            },
            body: JSON.stringify({
              templateName: "cancellation-requested",
              recipientEmail: member.email,
              idempotencyKey: `cancel-req-${member.id}-${Date.now()}`,
              templateData: { name: member.name, reason: reasonTrim },
            }),
          });
        } catch {}
      }
      // Tell the gym. The request itself is written by a database function, so
      // there was no server code in this path to hang an email on -- and the
      // toast below has been promising the gym was told since day one.
      try {
        await notifyCancellation({
          data: { dojoId: member.dojo_id, memberId: member.id },
        });
      } catch {
        // Their notice is recorded either way; never fail it over an email.
      }
    },
    onSuccess: () => {
      toast.success("Cancellation notice sent to your gym");
      onSaved();
    },
    onError: (e: any) => toast.error(e.message ?? "Failed to submit notice"),
  });

  const withdraw = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("withdraw_my_cancellation", {
        p_member_id: member.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setReason("");
      toast.success("Cancellation notice withdrawn");
      onSaved();
    },
    onError: (e: any) => toast.error(e.message ?? "Failed to withdraw"),
  });

  if (requested) {
    return (
      <section className="rounded-xl border border-amber-500/30 bg-amber-100/60 p-6 dark:bg-amber-950/20">
        <div className="mb-2 flex items-center gap-2">
          <CheckCircle2 className="size-4 text-amber-700" />
          <h2 className="font-display text-base font-medium">Cancellation notice submitted</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Submitted{" "}
          {new Date(member.cancellation_requested_at).toLocaleDateString()}. Your gym has been
          notified and will be in touch to confirm next steps.
        </p>
        {member.cancellation_reason && (
          <p className="mt-2 text-sm">
            <span className="text-muted-foreground">Reason:</span> {member.cancellation_reason}
          </p>
        )}
        {!readOnly && (
          <div className="mt-4">
            <Button
              size="sm"
              variant="outline"
              onClick={() => withdraw.mutate()}
              disabled={withdraw.isPending}
            >
              {withdraw.isPending ? "Withdrawing…" : "Withdraw notice"}
            </Button>
          </div>
        )}
      </section>
    );
  }

  if (readOnly) {
    return (
      <section className="rounded-xl bg-card p-6 ring-1 ring-black/5">
        <div className="mb-2 flex items-center gap-2">
          <AlertTriangle className="size-4 text-muted-foreground" />
          <h2 className="font-display text-base font-medium">Cancellation</h2>
        </div>
        <p className="text-sm text-muted-foreground">No cancellation notice on file.</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl bg-card p-6 ring-1 ring-black/5">
      <div className="mb-2 flex items-center gap-2">
        <AlertTriangle className="size-4 text-destructive" />
        <h2 className="font-display text-base font-medium">Cancel my membership</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Send a cancellation notice to your gym. Your membership remains active until staff confirm
        the cancellation in line with your plan terms.
      </p>
      <div className="mt-4">
        <Label>Reason (optional)</Label>
        <Textarea
          rows={3}
          placeholder="Help your gym understand why you're leaving."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="mt-4">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" variant="destructive">
              Hand notice to gym
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Submit cancellation notice?</AlertDialogTitle>
              <AlertDialogDescription>
                Your gym will be notified that you wish to cancel. You can withdraw the notice at
                any time before it's processed.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep membership</AlertDialogCancel>
              <AlertDialogAction onClick={() => submit.mutate()} disabled={submit.isPending}>
                {submit.isPending ? "Submitting…" : "Submit notice"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </section>
  );
}


/**
 * Changing the address you sign in with. This is the only entry point to the
 * email-change confirmation email — Supabase sends it to both the old and new
 * address, and nothing takes effect until the link is clicked.
 */
function AccountEmailSection() {
  const { user } = useAuth();
  const current = user?.email ?? "";
  const [email, setEmail] = useState(current);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    setEmail(current);
  }, [current]);

  const change = useMutation({
    mutationFn: async () => {
      const next = email.trim().toLowerCase();
      if (!next || next === current.toLowerCase()) {
        throw new Error("Enter a different email address.");
      }
      const { error } = await supabase.auth.updateUser(
        { email: next },
        { emailRedirectTo: `${window.location.origin}/profile` },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      setSent(true);
      toast.success("Check both inboxes to confirm the change");
    },
    onError: (e: any) => toast.error(e.message ?? "Couldn't change your email"),
  });

  const reset = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.auth.resetPasswordForEmail(current, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
    },
    onSuccess: () => toast.success("Password reset link sent to your email"),
    onError: (e: any) => toast.error(e.message ?? "Couldn't send the reset link"),
  });

  return (
    <section className="rounded-xl bg-card p-6 ring-1 ring-black/5">
      <div className="mb-2 flex items-center gap-2">
        <User className="size-4 text-brand" />
        <h2 className="font-display text-base font-medium">Sign-in &amp; security</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        The email you sign in with. Changing it needs confirmation from both the old and the new
        address.
      </p>
      <div className="mt-4 max-w-sm">
        <Label>Account email</Label>
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      {sent && (
        <p className="mt-2 text-xs text-muted-foreground">
          Confirmation sent — your sign-in email changes once you click the link.
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => change.mutate()} disabled={change.isPending}>
          {change.isPending ? "Sending…" : "Change email"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => reset.mutate()}
          disabled={reset.isPending || !current}
        >
          {reset.isPending ? "Sending…" : "Send password reset link"}
        </Button>
      </div>
    </section>
  );
}
