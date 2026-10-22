import { PLATFORM_FEE_PERCENT, grossChargeCents } from "@/lib/platform-fee";
import { PUBLIC_SITE_URL } from "@/lib/site";
import { getMemberPlaybookActions } from "@/lib/workflows.functions";
import { logManualOutreach, listMemberInterventions } from "@/lib/retention.functions";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getTrialUsage, getTrialWindowBreaches } from "@/lib/trial.functions";
import { trialOffered, trialProgressText } from "@/lib/trial-policy";
import {
  ArrowLeft,
  Copy,
  CreditCard,
  Mail,
  Phone,
  Pencil,
  Award,
  Activity,
  AlertTriangle,
  ShieldCheck,
  MessageSquare,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { useAuth } from "@/hooks/use-auth";
import { BeltChip, MemberAvatar } from "@/components/BeltChip";
import { ConversationView } from "@/components/ConversationView";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DisputeAlerts } from "@/components/DisputeAlerts";
import { MemberRetentionCard } from "@/components/MemberRetentionCard";
import { RefundDialog } from "@/components/RefundDialog";
import { EditMemberDialog } from "@/components/EditMemberDialog";
import { ChangeMemberEmailDialog } from "@/components/ChangeMemberEmailDialog";
import { PromoteDialog } from "@/components/PromoteDialog";
import { cn } from "@/lib/utils";
import { RouteErrorPanel } from "@/components/RouteErrorPanel";
import { isMinor } from "@/lib/consent";
import { isUnder18, needsAdultWaiverTransition } from "@/lib/minors";
import type { Belt, BeltColor } from "@/lib/belt-colors";
import { assessReadiness, type ReadinessLevel } from "@/lib/belt-readiness";
import { scoreRetentionRisk, type RiskLevel } from "@/lib/retention";
import { setMemberPlan, setMemberPaymentStatus } from "@/lib/plans.functions";
import {
  listFamilyGroups,
  createFamilyGroup,
  setMemberFamilyGroup,
  setMemberFamilyPlan,
  getFamilyOverview,
} from "@/lib/family.functions";
import { familyPlanExplainer } from "@/lib/family";
import {
  getFamilyQuote,
  applyFamilyPricing,
  transferFamilyPayer,
  cancelCoveredMemberSubscription,
} from "@/lib/family-pricing.functions";
import { FamilyPricingBreakdown } from "@/components/FamilyPricingBreakdown";
import { createCheckoutSession } from "@/lib/payments.functions";
import { CashPaidToggle } from "@/components/CashPaidToggle";
import { AddToFamilyDialog } from "@/components/AddToFamilyDialog";
import { RemoveFromFamilyDialog } from "@/components/RemoveFromFamilyDialog";
import { ChangeFamilyPayerDialog } from "@/components/ChangeFamilyPayerDialog";
import { MergeFamiliesDialog } from "@/components/MergeFamiliesDialog";

import { useSetPaymentMethod } from "@/components/use-set-payment-method";
import { RecordCashPaymentDialog } from "@/components/RecordCashPaymentDialog";
import { listCashPayments, deleteCashPayment } from "@/lib/cash-payments.functions";
import { currentPeriod, isCashPayer, shortPeriodLabel } from "@/lib/cash-payments";
import {
  isDirectDebitMethod,
  isAwaitingFirstDirectDebit,
  DIRECT_DEBIT_PENDING_SHORT,
  paymentMethodLabel,
  paymentMethodShortLabel,
} from "@/lib/payment-methods";

import { deleteMember } from "@/lib/members.functions";
import { ConvertTrialDialog } from "@/components/ConvertTrialDialog";
import { EndMembershipDialog } from "@/components/EndMembershipDialog";
import { PauseMembershipDialog } from "@/components/PauseMembershipDialog";
import { MembershipPauseCard } from "@/components/MembershipPauseCard";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Ban, Trash2, PauseCircle, PlayCircle } from "lucide-react";

export const Route = createFileRoute("/members/$memberId")({
  head: ({ params }) => {
    const url = `/members/${params.memberId}`;
    const title = "Member profile — Sthenos";
    const description =
      "Detailed athlete profile: contact info, belt rank, attendance, billing, and promotion history.";
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:url", content: url },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: description },
        { name: "robots", content: "noindex" },
      ],
      links: [{ rel: "canonical", href: url }],
    };
  },
  component: MemberDetailPage,
  errorComponent: ({ error, reset }) => (
    <RouteErrorPanel error={error} reset={reset} title="This member's profile didn't load" />
  ),
  notFoundComponent: () => (
    <div className="mx-auto max-w-xl p-6 text-sm text-muted-foreground">
      We couldn't find that member.
    </div>
  ),
});

type MemberRow = {
  id: string;
  dojo_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  discipline: string;
  belt_color: BeltColor;
  belt_label: string;
  stripes: number;
  dan: number | null;
  status: "active" | "lapsed" | "trial" | "paused" | "pending";
  paused_at: string | null;
  pause_reason: string | null;
  pause_note: string | null;
  pause_resumes_at: string | null;
  plan_price_cents: number | null;
  pending_price_cents: number | null;
  pending_price_effective_at: string | null;
  plan: "Monthly" | "Annual" | "Drop-in" | "Family";
  payment_status: "current" | "due" | "overdue" | "none" | "disputed";
  last_seen_at: string | null;
  joined_at: string;
  selected_plan_id: string | null;
  payment_method: string | null;
  family_group_id: string | null;
  plan_covered_by: string | null;
  media_consent: boolean | null;
  media_consent_at: string | null;
  date_of_birth: string | null;
  guardian_name: string | null;
  guardian_email: string | null;
  guardian_phone: string | null;
  guardian_relationship: string | null;
  waiver_audience_accepted: string | null;
  waiver_signed_by: string | null;
  waiver_signed_at: string | null;
  waiver_version_accepted: number | null;
  terms_version_accepted: number | null;
  terms_accepted_at: string | null;
  dojo_plans: {
    id: string;
    name: string;
    price_cents: number;
    currency: string;
    interval: string | null;
    plan_type: "individual" | "family" | null;
    max_family_members: number | null;
  } | null;
  family_groups: { id: string; name: string } | null;
  covered_by_member: {
    id: string;
    name: string;
    payment_method: string | null;
    dojo_plans: { name: string } | null;
  } | null;
};

type AttendanceRow = {
  id: string;
  checked_in_at: string;
  classes: { name: string } | null;
};

type PromotionRow = {
  id: string;
  promoted_at: string;
  discipline: string;
  from_color: BeltColor;
  from_label: string;
  from_stripes: number;
  to_color: BeltColor;
  to_label: string;
  to_stripes: number;
  awarded_by: string | null;
  note: string | null;
};

function PaymentsRefundsCard({ member }: { member: MemberRow }) {
  const [refundTarget, setRefundTarget] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["member-invoices", member.id],
    queryFn: async () => {
      const [cardRes, cashRes] = await Promise.all([
        supabase
          .from("invoices")
          .select(
            "id, amount_cents, currency, status, due_date, paid_at, refunded_amount_cents, hosted_invoice_url, payment_method",
          )
          .eq("member_id", member.id)
          .limit(24),
        supabase
          .from("cash_payments")
          .select("id,amount_cents,currency,paid_on")
          .eq("member_id", member.id)
          .limit(24),
      ]);
      if (cardRes.error) throw cardRes.error;
      if (cashRes.error) throw cashRes.error;
      return [
        ...(cardRes.data ?? []).map((row: any) => ({
          ...row,
          method: (row.payment_method ?? "card") as string,
        })),

        ...(cashRes.data ?? []).map((row) => ({
          id: row.id,
          amount_cents: row.amount_cents,
          currency: row.currency,
          status: "paid",
          due_date: row.paid_on,
          paid_at: `${row.paid_on}T00:00:00Z`,
          refunded_amount_cents: null,
          hosted_invoice_url: null,
          method: "cash" as const,
        })),
      ].sort((a, b) =>
        (b.paid_at ?? b.due_date ?? "").localeCompare(a.paid_at ?? a.due_date ?? ""),
      );
    },
  });

  const fmt = (cents: number, currency: string) => {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: (currency || "usd").toUpperCase(),
      }).format(cents / 100);
    } catch {
      return `${(cents / 100).toFixed(2)}`;
    }
  };

  return (
    <section className="rounded-xl bg-card p-5 ring-1 ring-black/5">
      <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Payments &amp; refunds
      </h2>
      {isLoading ? (
        <div className="mt-4 h-16 animate-pulse rounded-lg bg-muted" />
      ) : (data ?? []).length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No payments yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border text-sm">
          {(data ?? []).map((inv: any) => (
            <li key={inv.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <div>
                <div className="font-medium tabular-nums">
                  {fmt(inv.amount_cents, inv.currency)}{" "}
                  <span className="text-xs font-normal uppercase tracking-wider text-muted-foreground">
                    {String(inv.status).replace(/_/g, " ")}
                    {` · ${paymentMethodLabel(inv.method)}`}

                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {inv.paid_at
                    ? `Paid ${new Date(inv.paid_at).toLocaleDateString()}`
                    : `Due ${inv.due_date}`}
                  {(inv.refunded_amount_cents ?? 0) > 0
                    ? ` · ${fmt(inv.refunded_amount_cents, inv.currency)} refunded`
                    : ""}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {/* Cash payments have no Stripe invoice, so there is simply no
                    link rather than a broken one. */}
                {inv.hosted_invoice_url ? (
                  <Button size="sm" variant="outline" asChild>
                    <a
                      href={inv.hosted_invoice_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View invoice
                    </a>
                  </Button>
                ) : null}
                {inv.method !== "cash" &&
                (inv.status === "paid" || inv.status === "partially_refunded") ? (
                  <Button size="sm" variant="outline" onClick={() => setRefundTarget(inv.id)}>
                    Refund
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <RefundDialog
        open={!!refundTarget}
        onOpenChange={(o) => !o && setRefundTarget(null)}
        dojoId={member.dojo_id}
        invoiceId={refundTarget}
      />
    </section>
  );
}

function MemberDetailPage() {
  const { memberId } = Route.useParams();
  const { activeDojoId, activeDojo, loading: dojoLoading } = useCurrentDojo();
  const { loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const role = activeDojo?.role;
  const isStaff = role === "owner" || role === "admin" || role === "coach";

  // Staff-only guard: real members bounce to their portal.
  useEffect(() => {
    if (authLoading || dojoLoading) return;
    if (activeDojo && !isStaff) {
      navigate({ to: "/portal" });
    }
  }, [authLoading, dojoLoading, activeDojo, isStaff, navigate]);

  const memberQ = useQuery({
    queryKey: ["member-detail", memberId, activeDojoId],
    enabled: !!activeDojoId && isStaff,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("members")
        .select(
          "id,dojo_id,name,email,phone,discipline,belt_color,belt_label,stripes,dan,status,plan,payment_status,payment_method,last_seen_at,joined_at,selected_plan_id,family_group_id,plan_covered_by,media_consent,media_consent_at,date_of_birth," +
            "guardian_name,guardian_email,guardian_phone,guardian_relationship,waiver_audience_accepted,waiver_signed_by," +
            "waiver_signed_at,waiver_version_accepted,terms_version_accepted,terms_accepted_at," +
            "paused_at,pause_reason,pause_note,pause_resumes_at,plan_price_cents,pending_price_cents,pending_price_effective_at," +
            "dojo_plans:selected_plan_id(id,name,price_cents,currency,interval,plan_type,max_family_members)," +
            "family_groups:family_group_id(id,name)," +
            "covered_by_member:plan_covered_by(id,name,payment_method,dojo_plans:selected_plan_id(name))",
        )
        .eq("id", memberId)
        .eq("dojo_id", activeDojoId!)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as MemberRow | null;
    },
  });

  if (!activeDojoId || memberQ.isLoading) {
    return (
      <main className="mx-auto max-w-5xl space-y-6 p-8">
        <div className="h-8 w-32 animate-pulse rounded bg-zinc-100" />
        <div className="h-32 animate-pulse rounded-xl bg-zinc-100" />
        <div className="h-64 animate-pulse rounded-xl bg-zinc-100" />
      </main>
    );
  }

  if (activeDojo && !isStaff) {
    return null; // effect above will navigate
  }

  const member = memberQ.data;
  if (!member) {
    return (
      <main className="mx-auto max-w-5xl space-y-4 p-8">
        <Link
          to="/members"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Back to members
        </Link>
        <div className="rounded-xl bg-card p-10 text-center ring-1 ring-black/5">
          <h1 className="font-display text-2xl">Member not found</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This member doesn't exist or isn't part of this dojo.
          </p>
          <Button asChild className="mt-4">
            <Link to="/members">Back to members</Link>
          </Button>
        </div>
      </main>
    );
  }

  return <MemberDetail member={member} dojoSlug={activeDojo?.slug ?? ""} />;
}

function MemberDetail({ member, dojoSlug }: { member: MemberRow; dojoSlug: string }) {
  const [editOpen, setEditOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);

  const { activeDojo } = useCurrentDojo();
  const canDelete = activeDojo?.role === "owner" || activeDojo?.role === "admin";

  const belt: Belt = {
    color: member.belt_color,
    label: member.belt_label,
    stripes: member.stripes ?? 0,
    dan: member.dan ?? undefined,
  };
  const joined = new Date(member.joined_at);

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4 md:p-8">
      <div className="flex items-center justify-between">
        <Link
          to="/members"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Back to members
        </Link>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditOpen(true)} className="gap-2">
            <Pencil className="size-3.5" /> Edit profile
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPromoteOpen(true)}
            className="gap-2"
          >
            <Award className="size-3.5" /> Record promotion
          </Button>
          {["active", "trial"].includes(member.status) && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPauseOpen(true)}
              className="gap-2"
            >
              <PauseCircle className="size-3.5" /> Pause membership
            </Button>
          )}
          {canDelete && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCancelOpen(true)}
              className="gap-2"
            >
              <Ban className="size-3.5" /> Cancel membership
            </Button>
          )}
          {canDelete && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDeleteOpen(true)}
              className="gap-2 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="size-3.5" /> Erase data (GDPR)
            </Button>
          )}
        </div>
      </div>

      {member.status === "trial" && (
        <TrialUsageCard dojoId={member.dojo_id} memberId={member.id} name={member.name} />
      )}

      <MemberRetentionCard dojoId={member.dojo_id} memberId={member.id} canEdit={canDelete} />

      <DisputeAlerts dojoId={member.dojo_id} memberId={member.id} />


      <MembershipPauseCard
        dojoId={member.dojo_id}
        member={{
          id: member.id,
          name: member.name,
          status: member.status,
          paused_at: member.paused_at,
          pause_reason: member.pause_reason,
          pause_note: member.pause_note,
          pause_resumes_at: member.pause_resumes_at,
          pending_price_cents: member.pending_price_cents,
          pending_price_effective_at: member.pending_price_effective_at,
          currency: member.dojo_plans?.currency ?? "usd",
        }}
      />

      {/* Header */}
      <section className="rounded-xl bg-card p-6 ring-1 ring-black/5">
        <div className="flex flex-wrap items-start gap-5">
          <MemberAvatar name={member.name} className="size-16 text-base" />
          <div className="flex-1 min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-display text-2xl font-medium">{member.name}</h1>
              <StatusPill status={member.status} />
              {isUnder18(member.date_of_birth) && (
                <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                  Minor · guardian required
                </span>
              )}
              {needsAdultWaiverTransition(member) && (
                <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                  Turned 18 — adult waiver needed
                </span>
              )}
              <StatusQuickSelect
                memberId={member.id}
                dojoId={member.dojo_id}
                current={member.status}
                memberName={member.name}
              />
            </div>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <BeltChip belt={belt} discipline={member.discipline} />
              <span className="text-xs text-muted-foreground">{member.discipline}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              Member since {format(joined, "MMMM d, yyyy")}
            </div>
          </div>
        </div>
      </section>

      {/* Contact */}
      <ContactCard memberId={member.id} email={member.email} phone={member.phone} />

      {/* Parent or guardian (minors only) */}
      <GuardianCard member={member} />

      {/* Data & consent */}
      <ConsentCard member={member} dojoSlug={dojoSlug} />

      {/* Membership */}
      <MembershipCard member={member} dojoSlug={dojoSlug} />

      <PaymentsRefundsCard member={member} />

      {/* Family */}
      <FamilySection member={member} />

      {/* Attendance + Retention side-by-side on wide screens */}
      <div className="grid gap-4 md:grid-cols-2">
        <AttendanceCard memberId={member.id} dojoId={member.dojo_id} />
        <RetentionCard member={member} />
      </div>

      {/* Progression */}
      <ProgressionCard member={member} onPromote={() => setPromoteOpen(true)} />

      {/* Communications */}
      <CommunicationsCard memberId={member.id} dojoId={member.dojo_id} />

      <EditMemberDialog
        member={{
          id: member.id,
          dojo_id: member.dojo_id,
          name: member.name,
          email: member.email,
          phone: member.phone,
          discipline: member.discipline,
          plan: member.plan,
          status:
            member.status === "paused" || member.status === "pending" ? "active" : member.status,
        }}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
      <PromoteDialog
        member={{
          id: member.id,
          dojo_id: member.dojo_id,
          name: member.name,
          discipline: member.discipline,
          belt_color: member.belt_color,
          belt_label: member.belt_label,
          stripes: member.stripes,
          dan: member.dan,
        }}
        open={promoteOpen}
        onOpenChange={setPromoteOpen}
      />
      <PauseMembershipDialog
        open={pauseOpen}
        dojoId={member.dojo_id}
        memberId={member.id}
        memberName={member.name}
        onClose={() => setPauseOpen(false)}
      />
      {canDelete && (
        <EndMembershipDialog
          open={cancelOpen}
          onOpenChange={setCancelOpen}
          dojoId={member.dojo_id}
          member={{ id: member.id, name: member.name }}
          source="member profile header"
        />
      )}
      {canDelete && (
        <DeleteMemberDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          memberId={member.id}
          memberName={member.name}
          dojoId={member.dojo_id}
        />
      )}
    </main>
  );
}

/* ---------- Contact ---------- */

function ContactCard({
  memberId,
  email,
  phone,
}: {
  memberId: string;
  email: string | null;
  phone: string | null;
}) {
  const [changeOpen, setChangeOpen] = useState(false);

  // The login email is what password resets and other account emails go to, so
  // staff need to see when it has drifted from the member's contact email.
  const { data: loginEmail } = useQuery({
    queryKey: ["member-login-email", memberId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("member_login_email", {
        _member_id: memberId,
      });
      if (error) throw error;
      return (data as string | null) ?? null;
    },
  });

  const mismatch = !!loginEmail && !!email && loginEmail.toLowerCase() !== email.toLowerCase();

  return (
    <section className="rounded-xl bg-card p-5 ring-1 ring-black/5">
      <div className="flex items-start justify-between gap-3">
        <SectionHeader icon={<Mail className="size-4" />} title="Contact" />
        <Button size="sm" variant="outline" onClick={() => setChangeOpen(true)}>
          Change email
        </Button>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <CopyRow
          icon={<Mail className="size-4 text-muted-foreground" />}
          label="Email"
          value={email}
        />
        <CopyRow
          icon={<Phone className="size-4 text-muted-foreground" />}
          label="Phone"
          value={phone}
        />
      </div>
      {mismatch && (
        <p className="mt-3 rounded-md bg-amber-100 p-3 text-xs text-amber-800">
          Their login email is <strong>{loginEmail}</strong>, not the address above.
          Password resets and other account emails go to the login address, so they will
          not reach them. Use “Change email” to bring both into line.
        </p>
      )}
      {loginEmail && !mismatch && (
        <p className="mt-3 text-xs text-muted-foreground">
          Login email matches — password resets go to this address.
        </p>
      )}
      <ChangeMemberEmailDialog
        memberId={memberId}
        currentEmail={email}
        loginEmail={loginEmail ?? null}
        open={changeOpen}
        onOpenChange={setChangeOpen}
      />
    </section>
  );
}

/* ---------- Data & consent ---------- */

const formatDate = (s: string | null) => (s ? format(new Date(s), "d MMM yyyy") : "—");

function AgreementPill({
  tone,
  children,
}: {
  tone: "ok" | "stale" | "missing";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1",
        tone === "ok" && "bg-brand/10 text-brand-strong ring-brand/30",
        tone === "stale" && "bg-amber-500/10 text-amber-600 ring-amber-500/30",
        tone === "missing" && "bg-destructive/10 text-destructive ring-destructive/30",
      )}
    >
      {children}
    </span>
  );
}

function GuardianCard({ member }: { member: MemberRow }) {
  const minor = isUnder18(member.date_of_birth);
  const transitioned = needsAdultWaiverTransition(member);
  if (!minor && !transitioned) return null;

  return (
    <section className="rounded-xl bg-card p-5 ring-1 ring-black/5">
      <SectionHeader icon={<Mail className="size-4" />} title="Parent or guardian" />
      {transitioned && !minor ? (
        <p className="mt-3 text-sm text-amber-700">
          This member has turned 18. Ask them to sign the adult waiver themselves — guardian
          requirements no longer apply, and you can clear the guardian details below.
        </p>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          This member is under 18. All membership contact goes to the guardian's email.
        </p>
      )}
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Name</dt>
          <dd className="font-medium">{member.guardian_name ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Relationship</dt>
          <dd className="font-medium">{member.guardian_relationship ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Email (used for all contact)</dt>
          <dd className="font-medium">{member.guardian_email ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Phone</dt>
          <dd className="font-medium">{member.guardian_phone ?? "—"}</dd>
        </div>
      </dl>
      {minor && !member.guardian_email && (
        <p className="mt-3 text-xs font-medium text-amber-700">
          No guardian email on file — messages and invites for this member cannot be delivered.
        </p>
      )}
    </section>
  );
}

function ConsentCard({ member, dojoSlug }: { member: MemberRow; dojoSlug?: string }) {
  const qc = useQueryClient();
  const minor = isMinor(member.date_of_birth);
  const granted = member.media_consent === true;

  const toggle = useMutation({
    mutationFn: async (next: boolean) => {
      const { error } = await supabase
        .from("members")
        .update({
          media_consent: next,
          media_consent_at: next ? new Date().toISOString() : null,
        })
        .eq("id", member.id)
        .eq("dojo_id", member.dojo_id);
      if (error) throw error;
      return next;
    },
    onSuccess: (next) => {
      toast.success(next ? "Media consent recorded" : "Media consent withdrawn");
      qc.invalidateQueries({ queryKey: ["member-detail", member.id] });
      qc.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const { data: current } = useQuery({
    queryKey: ["dojo-agreement-versions", member.dojo_id, member.date_of_birth ?? null],
    queryFn: async () => {
      const [w, t] = await Promise.all([
        supabase
          .from("dojo_waivers")
          .select("version, audience")
          .eq("dojo_id", member.dojo_id)
          .eq("is_current", true),
        supabase
          .from("dojo_terms")
          .select("version,body_markdown")
          .eq("dojo_id", member.dojo_id)
          .eq("is_current", true)
          .maybeSingle(),
      ]);
      const termsSet = (t.data?.body_markdown ?? "").trim().length > 0;
      // Compare against the waiver this member is required to sign.
      const waivers = (w.data ?? []) as any[];
      const adultW = waivers.find((x) => (x.audience ?? "adult") === "adult") ?? null;
      const minorW = waivers.find((x) => x.audience === "minor") ?? null;
      const relevant = isUnder18(member.date_of_birth ?? null) ? (minorW ?? adultW) : adultW;
      return {
        waiverVersion: relevant?.version ?? null,
        termsVersion: termsSet ? (t.data?.version ?? null) : null,
      };
    },
  });

  const waiverSigned = !!member.waiver_signed_at;
  const waiverStale =
    waiverSigned &&
    current?.waiverVersion != null &&
    (member.waiver_version_accepted ?? 0) < current.waiverVersion;
  const termsRequired = current?.termsVersion != null;
  const termsAccepted = !!member.terms_accepted_at;
  const termsStale =
    termsRequired &&
    termsAccepted &&
    (member.terms_version_accepted ?? 0) < (current!.termsVersion as number);

  return (
    <section className="rounded-xl bg-card p-5 ring-1 ring-black/5">
      <SectionHeader icon={<Mail className="size-4" />} title="Agreements & consent" />
      <div className="mt-3 space-y-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
          <div>
            <div className="font-medium">Waiver</div>
            <div className="text-xs text-muted-foreground">
              {waiverSigned
                ? `${member.waiver_signed_by === "guardian" ? "Signed by guardian" : "Signed"} ${formatDate(member.waiver_signed_at)}${
                    member.waiver_version_accepted != null
                      ? ` · version ${member.waiver_version_accepted}`
                      : ""
                  }${member.waiver_audience_accepted === "minor" ? " · minors waiver" : ""}`
                : "Not signed"}
            </div>
          </div>
          <AgreementPill tone={waiverSigned ? (waiverStale ? "stale" : "ok") : "missing"}>
            {waiverSigned ? (waiverStale ? "Out of date" : "Signed") : "Missing"}
          </AgreementPill>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
          <div>
            <div className="font-medium">Terms &amp; conditions</div>
            <div className="text-xs text-muted-foreground">
              {!termsRequired
                ? "This gym has not published terms"
                : termsAccepted
                  ? `Accepted ${formatDate(member.terms_accepted_at)}${
                      member.terms_version_accepted != null
                        ? ` · version ${member.terms_version_accepted}`
                        : ""
                    }`
                  : "Not accepted"}
            </div>
          </div>
          {termsRequired && (
            <AgreementPill tone={termsAccepted ? (termsStale ? "stale" : "ok") : "missing"}>
              {termsAccepted ? (termsStale ? "Out of date" : "Accepted") : "Missing"}
            </AgreementPill>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-medium">Media consent</div>
            <p className="text-xs text-muted-foreground">
              {minor
                ? "This member is under 18 — consent must come from a parent or guardian."
                : "Optional permission to use photos and training footage for marketing."}
            </p>
            {granted && member.media_consent_at && (
              <p className="text-xs text-muted-foreground">
                Granted {format(new Date(member.media_consent_at), "MMM d, yyyy")}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                granted ? "bg-emerald-500/10 text-emerald-700" : "bg-zinc-500/10 text-zinc-600",
              )}
            >
              {granted ? "Granted" : "Not granted"}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate(!granted)}
            >
              {granted ? "Withdraw" : "Record consent"}
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-black/5 pt-3">
          <div>
            <div className="font-medium">Date of birth</div>
            <p className="text-xs text-muted-foreground">
              {member.date_of_birth
                ? `${format(new Date(member.date_of_birth), "MMM d, yyyy")}${minor ? " · minor" : ""}`
                : "Not recorded"}
            </p>
          </div>
          <a
            href={dojoSlug ? `/j/${dojoSlug}/privacy` : "/privacy"}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-muted-foreground underline"
          >
            Privacy notice
          </a>
        </div>
      </div>
    </section>
  );
}

function CopyRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`${label} copied`);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error("Couldn't copy");
    }
  };
  return (
    <div className="flex items-center gap-2 rounded-md border border-zinc-950/5 bg-background px-3 py-2">
      {icon}
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div className="truncate text-sm">{value ?? "—"}</div>
      </div>
      {value && (
        <Button size="sm" variant="ghost" onClick={copy} className="h-8 gap-1 px-2">
          <Copy className="size-3.5" /> {copied ? "Copied" : "Copy"}
        </Button>
      )}
    </div>
  );
}

/* ---------- Membership ---------- */

function MembershipCard({ member, dojoSlug }: { member: MemberRow; dojoSlug: string }) {
  const qc = useQueryClient();
  const setPlan = useServerFn(setMemberPlan);
  const checkout = useServerFn(createCheckoutSession);
  const { activeDojo } = useCurrentDojo();
  const dojoDefaultCurrency = activeDojo?.defaultCurrency ?? null;
  const [payLoading, setPayLoading] = useState(false);
  const [cashDialogOpen, setCashDialogOpen] = useState(false);
  // The payer's payment method governs the whole family, so a covered member's
  // effective method is always their payer's.
  const effectiveMethod = member.plan_covered_by
    ? (member.covered_by_member?.payment_method ?? member.payment_method)
    : member.payment_method;
  const isCash = isCashPayer(effectiveMethod);
  const isDD = isDirectDebitMethod(effectiveMethod);
  // Mandate authorised, first collection not yet cleared — not unpaid, and
  // nobody should be chased for it.
  const awaitingDirectDebit = isAwaitingFirstDirectDebit({
    paymentMethod: effectiveMethod,
    paymentStatus: member.payment_status,
  });

  const {
    setPaymentMethod,
    isPending: methodPending,
    dialog: methodDialog,
  } = useSetPaymentMethod(member.dojo_id);
  const listCash = useServerFn(listCashPayments);
  const removeCash = useServerFn(deleteCashPayment);

  const cashQ = useQuery({
    queryKey: ["cash-payments", member.id],
    enabled: isCash,
    queryFn: () => listCash({ data: { dojoId: member.dojo_id, memberId: member.id } }),
  });

  const period = currentPeriod(member.dojo_plans?.interval ?? "month");
  const paidThisPeriod = (cashQ.data ?? []).some(
    (p) => p.period_start <= period.end && p.period_end >= period.start,
  );

  const removeCashMut = useMutation({
    mutationFn: (paymentId: string) => removeCash({ data: { dojoId: member.dojo_id, paymentId } }),
    onSuccess: () => {
      toast.success("Cash payment removed");
      qc.invalidateQueries({ queryKey: ["cash-payments", member.id] });
      qc.invalidateQueries({ queryKey: ["member-detail", member.id] });
      qc.invalidateQueries({ queryKey: ["cash-dues"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not remove payment"),
  });

  // Whether this gym passes the platform fee to members — needed so any FUTURE
  // amount shown here matches what Stripe will actually charge.
  const feeQ = useQuery({
    queryKey: ["dojo-pass-fee", member.dojo_id],
    queryFn: async () => {
      const { data } = await supabase
        .from("dojos")
        .select("pass_platform_fee_to_members")
        .eq("id", member.dojo_id)
        .maybeSingle();
      return !!(data as any)?.pass_platform_fee_to_members;
    },
  });
  const passFee = !!feeQ.data;

  const plansQ = useQuery({
    queryKey: ["dojo-plans-active", member.dojo_id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("dojo_plans")
        .select("id,name,price_cents,currency,interval,plan_type,max_family_members")
        .eq("dojo_id", member.dojo_id)
        .eq("is_active", true)
        .order("sort_order")
        .order("price_cents");
      if (error) throw error;
      return data ?? [];
    },
  });

  const changePlanMut = useMutation({
    mutationFn: async (planId: string | null) => {
      return (await setPlan({
        data: { memberId: member.id, dojoId: member.dojo_id, planId },
      })) as any;
    },
    onSuccess: (res: any) => {
      // Say what actually happened to their billing, not just that a field
      // changed -- the old "Plan updated" was equally cheerful when Stripe
      // hadn't been touched at all.
      const b = res?.billing;
      if (b?.changed) {
        const amount = new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: String(b.currency || "eur").toUpperCase(),
        }).format(b.chargeCents / 100);
        toast.success(`Plan updated. From their next payment they'll be charged ${amount}.`);
      } else if (b?.reason === "no_live_subscription") {
        toast.success("Plan updated. They have no card subscription, so nothing changes in Stripe.");
      } else {
        toast.success("Plan updated");
      }
      qc.invalidateQueries({ queryKey: ["member-detail", member.id] });
      qc.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not update plan"),
  });

  const sendPayLink = async () => {
    if (!member.selected_plan_id) {
      toast.error("Assign a plan first");
      return;
    }
    setPayLoading(true);
    try {
      const res = await checkout({
        data: {
          memberId: member.id,
          dojoId: member.dojo_id,
          planId: member.selected_plan_id,
        },
      });
      if (res.error || !res.url) throw new Error(res.error ?? "Could not create link");
      try {
        await navigator.clipboard.writeText(res.url);
        toast.success("Payment link copied", { description: "Send it to the member." });
      } catch {
        toast.success("Payment link ready", { description: res.url });
      }
    } catch (e) {
      toast.error((e as Error).message ?? "Could not create link");
    } finally {
      setPayLoading(false);
    }
  };

  const isCovered = !!member.plan_covered_by;
  const currentPlanName = isCovered
    ? `Covered by ${member.covered_by_member?.dojo_plans?.name ?? "family plan"}`
    : (member.dojo_plans?.name ?? "No plan assigned");
  const priceLabel =
    !isCovered && member.dojo_plans
      ? `${formatCurrency(grossChargeCents(member.dojo_plans.price_cents, passFee), member.dojo_plans.currency ?? dojoDefaultCurrency)} / ${intervalLabel(member.dojo_plans.interval)}${passFee ? ` (incl. ${PLATFORM_FEE_PERCENT}% platform fee)` : ""}`
      : null;
  const payLink = `${PUBLIC_SITE_URL}/j/${dojoSlug}/pay/${member.id}`;

  return (
    <section className="rounded-xl bg-card p-5 ring-1 ring-black/5">
      <SectionHeader icon={<CreditCard className="size-4" />} title="Membership" />
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Current plan
          </div>
          <div className="mt-1 text-sm font-medium">{currentPlanName}</div>
          {priceLabel && <div className="text-xs text-muted-foreground">{priceLabel}</div>}
          {isCovered && member.covered_by_member && (
            <div className="text-xs text-muted-foreground">
              Payer: {member.covered_by_member.name}
              {member.family_groups ? ` · ${member.family_groups.name}` : ""}
            </div>
          )}
          {!isCovered && (
            <div className="mt-3">
              <Select
                value={member.selected_plan_id ?? "__none__"}
                onValueChange={(v) => changePlanMut.mutate(v === "__none__" ? null : v)}
                disabled={changePlanMut.isPending || plansQ.isLoading}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select plan" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No plan</SelectItem>
                  {(plansQ.data ?? [])
                    .filter((p: any) => p.plan_type !== "family")
                    .map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} —{" "}
                        {formatCurrency(
                          grossChargeCents(p.price_cents, passFee),
                          p.currency ?? dojoDefaultCurrency,
                        )}{" "}
                        / {intervalLabel(p.interval)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Assign family plans from the Family section below.
              </p>
            </div>
          )}
        </div>

        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Payment status
          </div>
          <div className="mt-1 flex items-center gap-2">
            {awaitingDirectDebit ? (
              <span className="rounded bg-sky-50 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-sky-700 ring-1 ring-inset ring-sky-500/20">
                {DIRECT_DEBIT_PENDING_SHORT}
              </span>
            ) : (
              <PaymentBadge status={member.payment_status} />
            )}
            <span className="rounded bg-zinc-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-zinc-600">
              {paymentMethodLabel(effectiveMethod)}
            </span>
          </div>
          {awaitingDirectDebit && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Mandate authorised — first collection takes a few working days. Nothing to chase.
            </p>
          )}

          {isCovered ? (
            <div className="mt-3 rounded-md border border-zinc-950/5 bg-background p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">
                Covered by {member.covered_by_member?.name ?? "the family payer"} ·{" "}
                {paymentMethodShortLabel(effectiveMethod)}
              </p>
              <p className="mt-1">
                {isCash
                  ? `The family total is expected from ${member.covered_by_member?.name ?? "the payer"} in cash. ${member.name} is never chased individually.`
                  : `Billed through ${member.covered_by_member?.name ?? "the payer"}'s ${paymentMethodShortLabel(effectiveMethod)} subscription. ${member.name} is never expected to pay separately.`}{" "}
                To change how this family pays, change the payer&apos;s payment method.
              </p>
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Payment method
              </Label>
              <Select
                value={isCash ? "cash" : "card"}
                onValueChange={(v) => setPaymentMethod([member.id], v as "card" | "cash")}
                disabled={methodPending}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="card">
                    {isDD ? `${paymentMethodLabel(effectiveMethod)} (Stripe)` : "Card (Stripe)"}
                  </SelectItem>
                  <SelectItem value="cash">Cash / offline</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {isCash
                  ? "Tracked from recorded cash payments — never charged automatically."
                  : isDD
                    ? "Collected by direct debit — first collections take a few working days to clear."
                    : "Judged on their Stripe subscription and paid invoices."}
              </p>

            </div>
          )}

          {isCash && !isCovered && (
            <div className="mt-3 space-y-2 rounded-md border border-zinc-950/5 bg-background p-3">
              <div className="flex flex-wrap items-center gap-2">
                <CashPaidToggle
                  dojoId={member.dojo_id}
                  memberId={member.id}
                  paid={paidThisPeriod}
                  interval={member.dojo_plans?.interval ?? "month"}
                  size="md"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setCashDialogOpen(true)}
                  className="gap-2"
                >
                  Record cash payment…
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                One tap records {shortPeriodLabel(member.dojo_plans?.interval ?? "month")} at the
                plan price. Use the dialog for partial, backdated or different periods.
              </p>
              {(cashQ.data ?? []).length > 0 && (
                <ul className="space-y-1 pt-1">
                  {(cashQ.data ?? []).slice(0, 5).map((p) => (
                    <li key={p.id} className="flex items-center gap-2 text-[11px]">
                      <span className="font-medium tabular-nums">
                        {formatCurrency(p.amount_cents, p.currency)}
                      </span>
                      <span className="text-muted-foreground">
                        {p.paid_on} · covers {p.period_start} → {p.period_end}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeCashMut.mutate(p.id)}
                        disabled={removeCashMut.isPending}
                        className="ml-auto text-destructive hover:underline"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="mt-3 flex flex-col gap-2">
            <Button
              size="sm"
              onClick={sendPayLink}
              disabled={payLoading || !member.selected_plan_id || isCash}
              className="gap-2"
            >
              <CreditCard className="size-3.5" />
              {payLoading ? "Creating…" : "Send payment link"}
            </Button>
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={payLink}
                className="font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(payLink);
                  toast.success("Link copied");
                }}
                className="shrink-0 gap-2"
              >
                <Copy className="size-3.5" /> Copy
              </Button>
            </div>
          </div>
        </div>
      </div>
      <RecordCashPaymentDialog
        member={{ id: member.id, dojo_id: member.dojo_id, name: member.name }}
        open={cashDialogOpen}
        onOpenChange={setCashDialogOpen}
      />
      {methodDialog}
    </section>
  );
}

function StatusQuickSelect({
  memberId,
  dojoId,
  current,
  memberName,
}: {
  memberId: string;
  dojoId: string;
  current: "active" | "lapsed" | "trial" | "paused" | "pending";
  memberName: string;
}) {
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const mut = useMutation({
    mutationFn: async (status: "active" | "lapsed" | "trial") => {
      setPending(true);
      const { error } = await supabase
        .from("members")
        .update({ status })
        .eq("id", memberId)
        .eq("dojo_id", dojoId);
      if (error) throw error;
    },
    onSettled: () => setPending(false),
    onSuccess: () => {
      toast.success("Status updated");
      qc.invalidateQueries({ queryKey: ["member-detail", memberId] });
      qc.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not update status"),
  });
  if (current === "paused") {
    return (
      <span className="text-[11px] text-muted-foreground">
        Paused — restart it from the pause card below
      </span>
    );
  }

  return (
    <>
      <Select
        value={current}
        onValueChange={(v) => {
          // Lapsing a member must always stop billing first.
          if (v === "lapsed") {
            setEndOpen(true);
            return;
          }
          // Converting a trial to a paid plan can move the family payer's
          // total, so it is always confirmed before/after, never silent.
          if (v === "active" && current === "trial") {
            setConvertOpen(true);
            return;
          }
          mut.mutate(v as "active" | "trial");
        }}
        disabled={pending}
      >
        <SelectTrigger className="h-7 w-[110px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="active">Active</SelectItem>
          <SelectItem value="trial">Trial</SelectItem>
          <SelectItem value="lapsed">Lapsed</SelectItem>
        </SelectContent>
      </Select>
      <ConvertTrialDialog
        open={convertOpen}
        onOpenChange={setConvertOpen}
        dojoId={dojoId}
        memberId={memberId}
        memberName={memberName}
        onDone={() => {
          qc.invalidateQueries({ queryKey: ["member-detail", memberId] });
        }}
      />
      <EndMembershipDialog
        open={endOpen}
        onOpenChange={setEndOpen}
        dojoId={dojoId}
        member={{ id: memberId, name: memberName }}
        source="member profile"
        onDone={() => {
          qc.invalidateQueries({ queryKey: ["member-detail", memberId] });
        }}
      />
    </>
  );
}

/* ---------- Attendance ---------- */

function AttendanceCard({ memberId, dojoId }: { memberId: string; dojoId: string }) {
  const since30 = useMemo(() => new Date(Date.now() - 30 * 86400000).toISOString(), []);

  const countQ = useQuery({
    queryKey: ["member-att-30d", memberId, dojoId],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("attendances")
        .select("id", { count: "exact", head: true })
        .eq("member_id", memberId)
        .eq("dojo_id", dojoId)
        .gte("checked_in_at", since30);
      if (error) throw error;
      return count ?? 0;
    },
  });

  const listQ = useQuery({
    queryKey: ["member-att-list", memberId, dojoId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("attendances")
        .select("id, checked_in_at, classes(name)")
        .eq("member_id", memberId)
        .eq("dojo_id", dojoId)
        .order("checked_in_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as unknown as AttendanceRow[];
    },
  });

  const rows = listQ.data ?? [];

  return (
    <section className="rounded-xl bg-card p-5 ring-1 ring-black/5">
      <div className="flex items-center justify-between">
        <SectionHeader icon={<Activity className="size-4" />} title="Attendance" />
        <div className="text-right">
          <div className="font-display text-2xl font-medium">
            {countQ.isLoading ? "…" : (countQ.data ?? 0)}
          </div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            last 30 days
          </div>
        </div>
      </div>
      <div className="mt-3">
        {listQ.isLoading ? (
          <div className="h-24 animate-pulse rounded bg-zinc-100" />
        ) : rows.length === 0 ? (
          <div className="rounded-md bg-zinc-50 p-4 text-sm text-muted-foreground">
            No check-ins recorded yet.
          </div>
        ) : (
          <ul className="divide-y divide-zinc-950/5 rounded-md ring-1 ring-black/5">
            {rows.map((r) => {
              const d = new Date(r.checked_in_at);
              return (
                <li key={r.id} className="flex items-center justify-between px-4 py-2">
                  <div className="text-sm">
                    <div className="font-medium">{format(d, "MMM d, yyyy")}</div>
                    <div className="text-xs text-muted-foreground">{format(d, "h:mm a")}</div>
                  </div>
                  <div className="text-sm text-zinc-600">{r.classes?.name ?? "—"}</div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

/* ---------- Progression ---------- */

function ProgressionCard({ member, onPromote }: { member: MemberRow; onPromote: () => void }) {
  const since90 = useMemo(() => new Date(Date.now() - 90 * 86400000).toISOString(), []);

  const sessions90Q = useQuery({
    queryKey: ["member-att-90d", member.id, member.dojo_id],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("attendances")
        .select("id", { count: "exact", head: true })
        .eq("member_id", member.id)
        .eq("dojo_id", member.dojo_id)
        .gte("checked_in_at", since90);
      if (error) throw error;
      return count ?? 0;
    },
  });

  const promotionsQ = useQuery({
    queryKey: ["member-promotions", member.id, member.dojo_id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("promotions")
        .select(
          "id, promoted_at, discipline, from_color, from_label, from_stripes, to_color, to_label, to_stripes, awarded_by, note",
        )
        .eq("member_id", member.id)
        .eq("dojo_id", member.dojo_id)
        .order("promoted_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as PromotionRow[];
    },
  });

  const readiness = useMemo(() => {
    if (sessions90Q.data == null) return null;
    return assessReadiness({
      id: member.id,
      name: member.name,
      discipline: member.discipline,
      belt_color: member.belt_color,
      stripes: member.stripes,
      joined_at: member.joined_at,
      sessionsLast90: sessions90Q.data,
    });
  }, [
    sessions90Q.data,
    member.id,
    member.name,
    member.discipline,
    member.belt_color,
    member.stripes,
    member.joined_at,
  ]);

  const promotions = promotionsQ.data ?? [];

  return (
    <section className="rounded-xl bg-card p-5 ring-1 ring-black/5">
      <div className="flex items-center justify-between">
        <SectionHeader icon={<Award className="size-4" />} title="Progression" />
        <Button size="sm" variant="outline" onClick={onPromote} className="gap-2">
          <Award className="size-3.5" /> Record promotion
        </Button>
      </div>

      <div className="mt-4 rounded-md border border-zinc-950/5 bg-background p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Belt readiness
          </div>
          {readiness && <ReadinessPill level={readiness.level} />}
        </div>
        {sessions90Q.isLoading || !readiness ? (
          <div className="mt-2 h-4 w-40 animate-pulse rounded bg-zinc-100" />
        ) : (
          <p className="mt-2 text-sm text-zinc-700">{readiness.notes}</p>
        )}
      </div>

      <div className="mt-4">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Promotion history
        </div>
        {promotionsQ.isLoading ? (
          <div className="mt-3 h-16 animate-pulse rounded bg-zinc-100" />
        ) : promotions.length === 0 ? (
          <div className="mt-3 rounded-md bg-zinc-50 p-4 text-sm text-muted-foreground">
            No promotions recorded yet.
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-zinc-950/5 rounded-md ring-1 ring-black/5">
            {promotions.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <BeltChip
                    belt={{
                      color: p.to_color,
                      label: p.to_label,
                      stripes: p.to_stripes,
                    }}
                    discipline={p.discipline}
                  />
                  <div className="text-sm">
                    <div className="font-medium">
                      {p.from_label} → {p.to_label}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {p.awarded_by ? `Awarded by ${p.awarded_by}` : "Awarded"}
                      {p.note ? ` · ${p.note}` : ""}
                    </div>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  {format(new Date(p.promoted_at), "MMM d, yyyy")}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/* ---------- Retention ---------- */

function RetentionCard({ member }: { member: MemberRow }) {
  const now = Date.now();
  const since30 = useMemo(() => new Date(now - 30 * 86400000).toISOString(), [now]);
  const since60 = useMemo(() => new Date(now - 60 * 86400000).toISOString(), [now]);

  const q = useQuery({
    queryKey: ["member-retention", member.id, member.dojo_id],
    queryFn: async () => {
      const bookingsSince = since30.slice(0, 10);
      const [
        { count: recent, error: e1 },
        { count: prev, error: e2 },
        { data: bookings, error: e3 },
      ] = await Promise.all([
        supabase
          .from("attendances")
          .select("id", { count: "exact", head: true })
          .eq("member_id", member.id)
          .eq("dojo_id", member.dojo_id)
          .gte("checked_in_at", since30),
        supabase
          .from("attendances")
          .select("id", { count: "exact", head: true })
          .eq("member_id", member.id)
          .eq("dojo_id", member.dojo_id)
          .gte("checked_in_at", since60)
          .lt("checked_in_at", since30),
        supabase
          .from("class_bookings")
          .select("booked_for_date, status")
          .eq("member_id", member.id)
          .eq("dojo_id", member.dojo_id)
          .gte("booked_for_date", bookingsSince),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;
      if (e3) throw e3;
      return {
        recent: recent ?? 0,
        previous: prev ?? 0,
        bookings: (bookings ?? []) as {
          booked_for_date: string;
          status: "booked" | "attended" | "no_show";
        }[],
      };
    },
  });

  const risk = useMemo(() => {
    if (!q.data) return null;
    return scoreRetentionRisk({
      id: member.id,
      name: member.name,
      belt_color: member.belt_color,
      stripes: member.stripes,
      joined_at: member.joined_at,
      last_seen_at: member.last_seen_at,
      recentSessions: q.data.recent,
      previousSessions: q.data.previous,
      recentBookings: q.data.bookings,
    });
  }, [q.data, member]);

  return (
    <section className="rounded-xl bg-card p-5 ring-1 ring-black/5">
      <div className="flex items-center justify-between">
        <SectionHeader icon={<AlertTriangle className="size-4" />} title="Retention" />
        {risk && <RiskPill level={risk.level} />}
      </div>
      <div className="mt-3 space-y-3">
        <div className="text-xs text-muted-foreground">
          Last seen{" "}
          <span className="text-zinc-700">
            {member.last_seen_at
              ? formatDistanceToNow(new Date(member.last_seen_at), { addSuffix: true })
              : "never"}
          </span>
        </div>
        {q.isLoading || !risk ? (
          <div className="h-16 animate-pulse rounded bg-zinc-100" />
        ) : risk.reasons.length === 0 ? (
          <div className="flex items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-500/20">
            <ShieldCheck className="size-4" /> No risk factors detected.
          </div>
        ) : (
          <ul className="space-y-1 text-sm text-zinc-700">
            {risk.reasons.map((r, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-1 size-1.5 shrink-0 rounded-full bg-amber-500" />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        )}
        <PlaybookActions dojoId={member.dojo_id} memberId={member.id} />
        <OutreachLog dojoId={member.dojo_id} memberId={member.id} />
      </div>
    </section>
  );
}

function OutreachLog({ dojoId, memberId }: { dojoId: string; memberId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listMemberInterventions);
  const logFn = useServerFn(logManualOutreach);
  const [notes, setNotes] = useState("");
  const [open, setOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ["member-interventions", dojoId, memberId],
    queryFn: () => listFn({ data: { dojoId, memberId } }),
  });

  const save = useMutation({
    mutationFn: () => logFn({ data: { dojoId, memberId, notes } }),
    onSuccess: () => {
      toast.success("Outreach logged");
      setNotes("");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["member-interventions", dojoId, memberId] });
      qc.invalidateQueries({ queryKey: ["retention-impact"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not log outreach"),
  });

  const rows = (data ?? []) as any[];

  return (
    <div className="rounded-md bg-zinc-50 px-3 py-2 ring-1 ring-black/5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Retention outreach
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
          Log outreach
        </Button>
      </div>

      {open && (
        <div className="mt-2 space-y-2">
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional notes — e.g. called, coming back Thursday"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">No at-risk flags recorded yet.</p>
      ) : (
        <ul className="mt-1 space-y-1 text-xs text-zinc-700">
          {rows.slice(0, 5).map((r) => (
            <li key={r.id} className="flex items-start justify-between gap-2">
              <span>
                Flagged {r.risk_level_at_flag} ·{" "}
                {r.intervention_at
                  ? `${r.intervention_type === "email" ? "email sent" : r.intervention_type === "manual" ? "outreach logged" : "playbook contacted"}`
                  : "not contacted"}
                {r.notes ? ` — ${r.notes}` : ""}
                {r.intervention_by_name ? ` · by ${r.intervention_by_name}` : ""}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {r.outcome === "pending" ? "pending" : r.outcome.replace("_", " ")} ·{" "}
                {format(new Date(r.intervention_at ?? r.flagged_at), "d MMM")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PlaybookActions({ dojoId, memberId }: { dojoId: string; memberId: string }) {
  const actionsFn = useServerFn(getMemberPlaybookActions);
  const { data } = useQuery({
    queryKey: ["member-playbook-actions", dojoId, memberId],
    queryFn: () => actionsFn({ data: { dojoId, memberId } }),
  });
  const actions = data?.actions ?? [];
  if (!actions.length) return null;
  return (
    <div className="rounded-md bg-zinc-50 px-3 py-2 ring-1 ring-black/5">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Playbooks actioned
      </div>
      <ul className="mt-1 space-y-1 text-xs text-zinc-700">
        {actions.slice(0, 5).map((a: { workflow_name: string; actioned_at: string }, i: number) => (
          <li key={i} className="flex items-center justify-between gap-2">
            <span>{a.workflow_name}</span>
            <span className="text-muted-foreground">
              {formatDistanceToNow(new Date(a.actioned_at), { addSuffix: true })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- Communications ---------- */

function CommunicationsCard({ memberId, dojoId }: { memberId: string; dojoId: string }) {
  return (
    <section className="rounded-xl border bg-card p-4 space-y-3">
      <SectionHeader icon={<MessageSquare className="size-4" />} title="Communications" />
      <div className="h-[420px]">
        <ConversationView
          dojoId={dojoId}
          memberId={memberId}
          viewerRole="staff"
          className="h-full"
        />
      </div>
    </section>
  );
}

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {icon}
      <span>{title}</span>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: "bg-emerald-50 text-emerald-700 ring-emerald-500/20",
    lapsed: "bg-orange-50 text-orange-700 ring-orange-500/20",
    trial: "bg-blue-50 text-blue-700 ring-blue-500/20",
    paused: "bg-amber-100 text-amber-700 ring-amber-500/20",
    pending: "bg-zinc-100 text-zinc-600 ring-zinc-400/20",
  };
  return (
    <span
      className={cn(
        "rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset",
        map[status] ?? map.pending,
      )}
    >
      {status}
    </span>
  );
}

function PaymentBadge({ status }: { status: "current" | "due" | "overdue" | "none" | "disputed" }) {
  const map: Record<string, string> = {
    disputed: "bg-destructive text-destructive-foreground ring-destructive/30",
    current: "bg-emerald-50 text-emerald-700 ring-emerald-500/20",
    due: "bg-amber-100 text-amber-700 ring-amber-500/20",
    overdue: "bg-red-50 text-red-700 ring-red-500/20",
    none: "bg-zinc-100 text-zinc-600 ring-zinc-500/20",
  };
  return (
    <span
      className={cn(
        "rounded px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider ring-1 ring-inset",
        map[status] ?? map.none,
      )}
    >
      {status === "disputed" ? "Chargeback" : status}
    </span>
  );
}

function ReadinessPill({ level }: { level: ReadinessLevel }) {
  const map: Record<ReadinessLevel, { cls: string; label: string }> = {
    ready: { cls: "bg-emerald-50 text-emerald-700 ring-emerald-500/20", label: "Ready" },
    almost: { cls: "bg-amber-100 text-amber-700 ring-amber-500/20", label: "Almost" },
    "not-yet": { cls: "bg-zinc-100 text-zinc-600 ring-zinc-500/20", label: "Not yet" },
  };
  const { cls, label } = map[level];
  return (
    <span
      className={cn(
        "rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset",
        cls,
      )}
    >
      {label}
    </span>
  );
}

function RiskPill({ level }: { level: RiskLevel }) {
  const map: Record<RiskLevel, { cls: string; label: string }> = {
    healthy: { cls: "bg-emerald-50 text-emerald-700 ring-emerald-500/20", label: "Healthy" },
    watch: { cls: "bg-amber-100 text-amber-700 ring-amber-500/20", label: "Watch" },
    high: { cls: "bg-red-50 text-red-700 ring-red-500/20", label: "High risk" },
  };
  const { cls, label } = map[level];
  return (
    <span
      className={cn(
        "rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset",
        cls,
      )}
    >
      {label}
    </span>
  );
}

function formatCurrency(cents: number, currency?: string | null, fallback: string = "usd") {
  const cur = (currency || fallback || "usd").toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: cur,
    }).format(cents / 100);
  } catch {
    return `${cur} ${(cents / 100).toLocaleString()}`;
  }
}

function intervalLabel(interval: string | null): string {
  if (interval === "year") return "yr";
  if (interval === "one_time") return "one-time";
  return "mo";
}

// ---------------- Family Section ----------------

function FamilySection({ member }: { member: MemberRow }) {
  const qc = useQueryClient();
  const { activeDojo } = useCurrentDojo();
  const dojoDefaultCurrency = activeDojo?.defaultCurrency ?? null;
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const listGroupsFn = useServerFn(listFamilyGroups);
  const createFn = useServerFn(createFamilyGroup);
  const assignFn = useServerFn(setMemberFamilyGroup);
  const setFamilyPlanFn = useServerFn(setMemberFamilyPlan);

  const groupsQ = useQuery({
    queryKey: ["family-groups", member.dojo_id],
    queryFn: () => listGroupsFn({ data: { dojoId: member.dojo_id } }),
  });

  const familyPlansQ = useQuery({
    queryKey: ["family-plans", member.dojo_id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("dojo_plans")
        .select("id,name,price_cents,currency,interval,max_family_members")
        .eq("dojo_id", member.dojo_id)
        .eq("is_active", true)
        .eq("plan_type", "family")
        .order("sort_order");
      if (error) throw error;
      return data ?? [];
    },
  });

  const overviewFn = useServerFn(getFamilyOverview);
  const overviewQ = useQuery({
    queryKey: ["family-overview", member.id, member.family_group_id],
    enabled: !!member.family_group_id,
    queryFn: () => overviewFn({ data: { dojoId: member.dojo_id, memberId: member.id } }),
  });

  const quoteFn = useServerFn(getFamilyQuote);
  const quoteQ = useQuery({
    queryKey: ["family-quote", member.dojo_id, member.family_group_id],
    enabled: !!member.family_group_id,
    queryFn: () =>
      quoteFn({
        data: { dojoId: member.dojo_id, groupId: member.family_group_id! },
      }),
  });
  const applyFn = useServerFn(applyFamilyPricing);
  const applyMut = useMutation({
    mutationFn: () =>
      applyFn({
        data: {
          dojoId: member.dojo_id,
          groupId: member.family_group_id!,
          expectedTotalCents: quoteQ.data!.current.totalCents,
        },
      }),
    onSuccess: (res: any) => {
      toast.success(
        res.stripeUpdated
          ? "Family total applied to the payer's subscription (prorated)"
          : "Family total recalculated — no live subscription to update yet",
      );
      qc.invalidateQueries({ queryKey: ["family-quote"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not apply the family total"),
  });

  // Changing the designated payer: cancels the old payer's subscription and
  // bills the new payer the same discounted family total.
  const [pendingPayer, setPendingPayer] = useState<{ id: string; name: string } | null>(null);
  const [payerDialogOpen, setPayerDialogOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);

  const transferFn = useServerFn(transferFamilyPayer);
  const transferMut = useMutation({
    mutationFn: (newPayerId: string) =>
      transferFn({
        data: {
          dojoId: member.dojo_id,
          groupId: member.family_group_id!,
          newPayerId,
          expectedTotalCents: quoteQ.data?.current.totalCents,
        },
      }),
    onSuccess: (res: any) => {
      toast.success(
        res.needsCheckout
          ? `${res.newPayer.name} is now the designated payer. They have no saved card — send them the payment link to start billing.`
          : `${res.newPayer.name} is now the designated payer and is being charged the family total.`,
      );
      setPendingPayer(null);
      qc.invalidateQueries({ queryKey: ["family-quote"] });
      qc.invalidateQueries({ queryKey: ["family-overview"] });
      qc.invalidateQueries({ queryKey: ["member-detail"] });
      qc.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not change the payer"),
  });

  const duplicateFn = useServerFn(cancelCoveredMemberSubscription);
  const duplicateMut = useMutation({
    mutationFn: (memberId: string) => duplicateFn({ data: { dojoId: member.dojo_id, memberId } }),
    onSuccess: () => {
      toast.success("That member's own subscription was cancelled.");
      qc.invalidateQueries({ queryKey: ["family-quote"] });
      qc.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not cancel that subscription"),
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["member-detail", member.id] });
    qc.invalidateQueries({ queryKey: ["family-groups", member.dojo_id] });
    qc.invalidateQueries({ queryKey: ["family-overview"] });
    qc.invalidateQueries({ queryKey: ["members"] });
  };

  const createMut = useMutation({
    mutationFn: async () => {
      const res = await createFn({ data: { dojoId: member.dojo_id, name: newName } });
      await assignFn({
        data: {
          memberId: member.id,
          dojoId: member.dojo_id,
          groupId: res.group.id,
        },
      });
    },
    onSuccess: () => {
      setNewName("");
      setCreating(false);
      toast.success("Family group created");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not create group"),
  });

  const assignMut = useMutation({
    mutationFn: async (groupId: string | null) => {
      await assignFn({
        data: { memberId: member.id, dojoId: member.dojo_id, groupId },
      });
    },
    onSuccess: () => {
      toast.success("Family updated");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not update"),
  });

  const setFamilyPlanMut = useMutation({
    mutationFn: async (v: { planId: string; payerId?: string }) => {
      await setFamilyPlanFn({
        data: { memberId: v.payerId ?? member.id, dojoId: member.dojo_id, planId: v.planId },
      });
    },
    onSuccess: () => {
      toast.success("Family plan assigned");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not assign plan"),
  });

  const groups = groupsQ.data?.groups ?? [];
  const familyPlans = familyPlansQ.data ?? [];
  const overview = overviewQ.data;
  const groupMembers = overview?.members ?? [];
  const payer = overview?.payer ?? null;
  const groupHasPayer = !!payer;
  const isThisMemberPayer = payer?.id === member.id;

  return (
    <section className="rounded-xl bg-card p-5 ring-1 ring-black/5">
      <SectionHeader icon={<Users className="size-4" />} title="Family" />

      {!member.family_group_id ? (
        <div className="mt-3 space-y-3">
          <div className="rounded-lg bg-zinc-50 p-3 ring-1 ring-inset ring-zinc-950/5">
            <div className="text-sm font-medium">Not in a family</div>
            <p className="mt-1 text-xs text-muted-foreground">
              On a family plan one member pays and the rest train on the same plan. Everyone keeps
              their own profile, attendance and belt tracking. Create a new family group (e.g.
              "Silva family") or join an existing one, then choose who pays.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value=""
              onValueChange={(v) => assignMut.mutate(v)}
              disabled={assignMut.isPending || groups.length === 0}
            >
              <SelectTrigger className="w-64">
                <SelectValue
                  placeholder={
                    groups.length === 0 ? "No family groups yet" : "Add to existing group…"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {groups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name} ({g.member_count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">or</span>
            {creating ? (
              <div className="flex items-center gap-2">
                <Input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. The Silva family"
                  className="w-56"
                />
                <Button
                  size="sm"
                  onClick={() => createMut.mutate()}
                  disabled={createMut.isPending || newName.trim().length < 2}
                >
                  Create
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setCreating(false);
                    setNewName("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
                New family group
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Family group
              </div>
              <div className="mt-1 text-sm font-medium">{member.family_groups?.name ?? "—"}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {payer
                  ? `Payer: ${payer.name}${isThisMemberPayer ? " (this member)" : ""}${
                      overview?.plan ? ` · ${overview.plan.name}` : ""
                    }`
                  : "No payer set — each member is billed separately at full price, so the family discount isn't being applied."}
                {overview?.seatsLeft != null
                  ? ` · ${overview.seatsLeft} place${overview.seatsLeft === 1 ? "" : "s"} left`
                  : ""}
              </div>
              {overview?.plan && (
                <p className="mt-1 max-w-md text-[11px] text-muted-foreground">
                  {familyPlanExplainer(overview.plan.max_family_members)}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setPayerDialogOpen(true)}>
                Change payer
              </Button>
              <Button size="sm" variant="outline" onClick={() => setMergeOpen(true)}>
                Merge families
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRemoveTarget({ id: member.id, name: member.name })}
              >
                Remove from family
              </Button>
            </div>
          </div>

          {overview?.singleMember && (
            <div className="space-y-2 rounded-lg bg-amber-100 p-3 ring-1 ring-inset ring-amber-500/30">
              <p className="text-xs font-semibold text-amber-900">
                One-person family — no discount applies
              </p>
              <p className="text-xs text-amber-900">
                Add the rest of the family below, merge this group with the family's other group if
                one was created by mistake, or remove this member so they are on their own
                individual plan.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px]"
                  onClick={() => setMergeOpen(true)}
                >
                  Merge with another family
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px]"
                  onClick={() => setRemoveTarget({ id: member.id, name: member.name })}
                >
                  Dissolve — put on own plan
                </Button>
              </div>
            </div>
          )}

          {(overview?.warnings ?? []).length > 0 && (
            <div className="space-y-1 rounded-lg bg-amber-100 p-3 ring-1 ring-inset ring-amber-500/30">
              {overview!.warnings.map((w) => (
                <p key={w} className="text-xs text-amber-900">
                  {w}
                </p>
              ))}
            </div>
          )}

          {(quoteQ.data?.duplicateSubscriptions ?? []).length > 0 && (
            <div className="space-y-2 rounded-lg bg-amber-100 p-3 ring-1 ring-inset ring-amber-500/30">
              <p className="text-xs font-semibold text-amber-900">Risk of double-charging</p>
              <p className="text-xs text-amber-900">
                {quoteQ.data!.duplicateSubscriptions.map((d) => d.name).join(", ")} still
                {quoteQ.data!.duplicateSubscriptions.length === 1 ? " has" : " have"} their own
                active subscription while being covered by this family. Cancel it so the family is
                only charged once, through the payer.
              </p>
              <div className="flex flex-wrap gap-2">
                {quoteQ.data!.duplicateSubscriptions.map((d) => (
                  <Button
                    key={d.id}
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    disabled={duplicateMut.isPending}
                    onClick={() => duplicateMut.mutate(d.id)}
                  >
                    Cancel {d.name}'s own subscription
                  </Button>
                ))}
              </div>
            </div>
          )}

          {quoteQ.data?.mode === "tiered" && quoteQ.data.current.size > 0 && (
            <div className="space-y-2">
              <FamilyPricingBreakdown
                quote={quoteQ.data.current}
                title={`Family total · tiered discount`}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={applyMut.isPending || !quoteQ.data.payer}
                  onClick={() => applyMut.mutate()}
                >
                  {applyMut.isPending ? "Applying…" : "Recalculate & apply to payer's subscription"}
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  {quoteQ.data.payer
                    ? quoteQ.data.hasLiveSubscription
                      ? `${quoteQ.data.payer.name} is charged this total as one subscription; changes are prorated.`
                      : `${quoteQ.data.payer.name} has no live subscription yet — this is the amount they'll be charged.`
                    : "Choose a payer to bill this family total."}
                </span>
              </div>
            </div>
          )}

          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Members in group ({groupMembers.length})
            </div>
            <ul className="mt-2 space-y-1 text-sm">
              {groupMembers.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center justify-between gap-2 rounded bg-zinc-50 px-3 py-1.5"
                >
                  <span className="min-w-0 truncate">
                    {m.name}
                    {m.id === member.id ? " (this member)" : ""}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {m.role === "payer" ? (
                      <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-violet-700">
                        Payer
                      </span>
                    ) : m.role === "covered" ? (
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Covered
                      </span>
                    ) : (
                      <span className="text-[10px] uppercase tracking-wider text-amber-700">
                        No plan
                      </span>
                    )}
                    {m.role !== "payer" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px]"
                        disabled={transferMut.isPending}
                        onClick={() => setPendingPayer({ id: m.id, name: m.name })}
                      >
                        {payer ? "Make payer" : "Set as payer"}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px] text-muted-foreground"
                      onClick={() => setRemoveTarget({ id: m.id, name: m.name })}
                    >
                      Remove
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {!member.plan_covered_by && familyPlans.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {groupHasPayer
                  ? "Change family plan — this member becomes the payer"
                  : "Choose a family plan — this member becomes the payer"}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Select
                  value=""
                  onValueChange={(v) => setFamilyPlanMut.mutate({ planId: v })}
                  disabled={setFamilyPlanMut.isPending || groupMembers.length < 2}
                >
                  <SelectTrigger className="w-72">
                    <SelectValue placeholder="Choose family plan…" />
                  </SelectTrigger>
                  <SelectContent>
                    {familyPlans.map((p: any) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} —{" "}
                        {formatCurrency(p.price_cents, p.currency ?? dojoDefaultCurrency)} /{" "}
                        {intervalLabel(p.interval)}
                        {p.max_family_members ? ` · up to ${p.max_family_members}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {groupMembers.length < 2 && (
                  <span className="text-xs text-muted-foreground">
                    Need at least 2 members in the group.
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <AlertDialog
        open={!!pendingPayer}
        onOpenChange={(v) => {
          if (!transferMut.isPending && !v) setPendingPayer(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Make {pendingPayer?.name} the designated payer?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  {payer
                    ? `${payer.name}'s subscription will be cancelled immediately, and ${pendingPayer?.name} becomes the only member billed for this family.`
                    : `${pendingPayer?.name} becomes the only member billed for this family.`}
                </p>
                {quoteQ.data?.mode === "tiered" && (
                  <p className="font-medium text-foreground">
                    New charge:{" "}
                    {formatCurrency(quoteQ.data.current.totalCents, quoteQ.data.current.currency)} /{" "}
                    {intervalLabel(quoteQ.data.current.interval)} — the same discounted family total
                    ({quoteQ.data.current.discountPercent}% off for {quoteQ.data.current.size}{" "}
                    member{quoteQ.data.current.size === 1 ? "" : "s"}).
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Everyone else in the family stays covered and is never charged. If{" "}
                  {pendingPayer?.name} has no saved card, you'll need to send them the payment link
                  to start billing.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={transferMut.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={transferMut.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (pendingPayer) transferMut.mutate(pendingPayer.id);
              }}
            >
              {transferMut.isPending ? "Changing payer…" : "Change payer"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {member.family_group_id && (
        <>
          <ChangeFamilyPayerDialog
            dojoId={member.dojo_id}
            groupId={member.family_group_id}
            open={payerDialogOpen}
            onOpenChange={setPayerDialogOpen}
            initialPayerId={payer?.id ?? null}
          />
          <MergeFamiliesDialog
            dojoId={member.dojo_id}
            groupId={member.family_group_id}
            groupName={overview?.group?.name ?? null}
            open={mergeOpen}
            onOpenChange={setMergeOpen}
          />

          <RemoveFromFamilyDialog
            dojoId={member.dojo_id}
            groupId={member.family_group_id}
            member={removeTarget}
            open={!!removeTarget}
            onOpenChange={(v) => {
              if (!v) setRemoveTarget(null);
            }}
          />
        </>
      )}
    </section>
  );
}

/* ---------- Delete member (GDPR) ---------- */

function DeleteMemberDialog({
  open,
  onOpenChange,
  memberId,
  memberName,
  dojoId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  memberId: string;
  memberName: string;
  dojoId: string;
}) {
  const navigate = useNavigate();
  const [confirmName, setConfirmName] = useState("");
  const [reason, setReason] = useState("");
  const deleteFn = useServerFn(deleteMember);
  const matches = confirmName.trim() === memberName.trim();

  const mutation = useMutation({
    mutationFn: async () =>
      deleteFn({ data: { dojoId, memberId, reason: reason.trim() || undefined } }),
    onSuccess: (res: any) => {
      if (res?.stripeWarning) toast.warning(res.stripeWarning);
      toast.success(`${memberName} was permanently deleted.`);
      onOpenChange(false);
      navigate({ to: "/members" });
    },
    onError: (err: any) => toast.error(err?.message ?? "Failed to delete member"),
  });

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        if (!mutation.isPending) onOpenChange(v);
        if (!v) {
          setConfirmName("");
          setReason("");
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-destructive">
            <Trash2 className="size-4" /> Delete {memberName}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This <strong>permanently removes</strong> this member's personal data — attendances,
            class bookings, promotions, waiver signatures, subscription records, and conversation
            history. Invoices are kept for financial records but anonymised. This cannot be undone.
            To simply stop billing while keeping their record and history, use{" "}
            <strong>Cancel membership</strong> instead. If a live subscription exists, the erasure
            is blocked until Stripe confirms it is cancelled.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label htmlFor="confirm-name" className="text-xs">
              Type <strong>{memberName}</strong> to confirm
            </Label>
            <Input
              id="confirm-name"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={memberName}
              autoComplete="off"
            />
          </div>
          <div>
            <Label htmlFor="delete-reason" className="text-xs">
              Reason (optional, for audit log)
            </Label>
            <Input
              id="delete-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. GDPR erasure request"
            />
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!matches || mutation.isPending}
            onClick={(e) => {
              e.preventDefault();
              mutation.mutate();
            }}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {mutation.isPending ? "Deleting…" : "Permanently delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}


/** Where this member is in the gym's free trial. */
function TrialUsageCard({
  dojoId,
  memberId,
  name,
}: {
  dojoId: string;
  memberId: string;
  name: string;
}) {
  const fn = useServerFn(getTrialUsage);
  const { data } = useQuery({
    queryKey: ["trial-usage", dojoId, memberId],
    queryFn: () => fn({ data: { dojoId, memberIds: [memberId] } }),
    enabled: !!dojoId,
  });
  const breachFn = useServerFn(getTrialWindowBreaches);
  const { data: breaches } = useQuery({
    queryKey: ["trial-window-breaches", dojoId, memberId],
    queryFn: () => breachFn({ data: { dojoId, memberIds: [memberId] } }),
    enabled: !!dojoId,
  });
  const breach = breaches?.[0];
  const u = data?.usage?.[0];
  if (!u) return null;
  const first = name.split(" ")[0];


  if (!trialOffered(u.policy)) {
    return (
      <div className="rounded-xl bg-amber-100 p-4 text-xs text-amber-900 ring-1 ring-inset ring-amber-500/30">
        This gym doesn't offer a free trial, so {first} needs a plan before training.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div
        className={
          u.ended
            ? "rounded-xl bg-amber-100 p-4 text-xs text-amber-900 ring-1 ring-inset ring-amber-500/30"
            : "rounded-xl bg-muted/50 p-4 text-xs text-muted-foreground ring-1 ring-black/5"
        }
      >
        <span className="font-medium">{trialProgressText(u)}</span>
        {u.startDate && (
          <> · started {new Date(u.startDate + "T00:00:00").toLocaleDateString()}</>
        )}
        {u.endsOn && !u.ended && (
          <> · ends {new Date(u.endsOn + "T00:00:00").toLocaleDateString()}</>
        )}
        {!u.clockStarted && u.bookableUntil && (
          <> · can book up to {new Date(u.bookableUntil + "T00:00:00").toLocaleDateString()}</>
        )}
        <div className="mt-1">
          {u.ended
            ? "The free trial has finished — this is the most urgent conversion in the gym. Set them up on a plan below; staff can still override a single check-in at the desk."
            : u.reason === "day_limit"
              ? `${first} has already had today's trial class. They can train again tomorrow, within the trial window.`
              : !u.clockStarted
                ? "The trial clock starts on their first attended class; bookings are limited to the trial length from their first class."
                : u.daysLeft != null
                  ? `${u.daysLeft} day${u.daysLeft === 1 ? "" : "s"} left — a warm lead worth a nudge.`
                  : "No time limit on this gym's trial."}
        </div>
      </div>

      {breach && (
        <div className="rounded-xl bg-amber-100 p-4 text-xs text-amber-900 ring-1 ring-inset ring-amber-500/30">
          <span className="font-medium">
            {breach.dates.length} booking{breach.dates.length === 1 ? "" : "s"} beyond the free
            trial
          </span>{" "}
          — {breach.dates
            .map((d) => new Date(d + "T00:00:00").toLocaleDateString())
            .join(", ")}
          , after the trial ends on{" "}
          {new Date(breach.bookableUntil + "T00:00:00").toLocaleDateString()}. Nothing has been
          cancelled — check-in will ask for a plan (or a staff override) on those days.
        </div>
      )}
    </div>
  );
}

