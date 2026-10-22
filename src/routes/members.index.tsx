import { PUBLIC_SITE_URL } from "@/lib/site";
import { deleteEmptyFamilyGroup, getFamilyCoverageIssues } from "@/lib/family.functions";
import { familyRowLabel } from "@/lib/family";
import { createFileRoute, Link } from "@tanstack/react-router";
import { getTrialUsage } from "@/lib/trial.functions";
import { trialOffered, trialProgressText } from "@/lib/trial-policy";
import { useAuth } from "@/hooks/use-auth";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { RefreshControl } from "@/components/RefreshControl";
import { BeltChip, MemberAvatar } from "@/components/BeltChip";
import { PromoteDialog } from "@/components/PromoteDialog";
import { AddMemberDialog } from "@/components/AddMemberDialog";
import { EditMemberDialog } from "@/components/EditMemberDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import type { Belt, BeltColor } from "@/lib/belt-colors";
import {
  Award,
  Ban,
  Banknote,
  MoreVertical,
  PauseCircle,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  Mail,
  CreditCard,
  Users,
} from "lucide-react";
import { EndMembershipDialog } from "@/components/EndMembershipDialog";
import { PauseMembershipDialog } from "@/components/PauseMembershipDialog";
import { RouteErrorPanel } from "@/components/RouteErrorPanel";
import { deleteMember } from "@/lib/members.functions";

import { cn } from "@/lib/utils";
import { getBeltColors } from "@/lib/crm-presets";
import {
  MembersFilterPanel,
  EMPTY_FILTERS,
  countActiveFilters,
  type MembersFilters,
} from "@/components/MembersFilterPanel";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { sendPortalInvite } from "@/lib/invite.functions";
import { createCheckoutSession } from "@/lib/payments.functions";
import { isMinor } from "@/lib/consent";
import { currentPeriod, isCashOverdue, isCashPayer, shortPeriodLabel } from "@/lib/cash-payments";
import { paymentMethodShortLabel } from "@/lib/payment-methods";
import {
  PaymentFailedBadge,
  useFailedPaymentsByMember,
} from "@/components/PaymentFailureAlerts";


import { CashPaidToggle } from "@/components/CashPaidToggle";
import { AddToFamilyDialog, type FamilyTarget } from "@/components/AddToFamilyDialog";
import { useSetPaymentMethod } from "@/components/use-set-payment-method";
import {
  RecordCashPaymentDialog,
  type CashPaymentTarget,
} from "@/components/RecordCashPaymentDialog";
import { recordCashPaymentsForPeriod } from "@/lib/cash-payments.functions";
import { Checkbox } from "@/components/ui/checkbox";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

export const Route = createFileRoute("/members/")({
  head: () => ({
    meta: [
      { title: "Members \u2014 Sthenos" },
      {
        name: "description",
        content: "Browse, filter, and manage every athlete in your dojo roster.",
      },
      { property: "og:title", content: "Members \u2014 Sthenos" },
      {
        property: "og:description",
        content: "Browse, filter, and manage every athlete in your dojo roster.",
      },
      { property: "og:url", content: `${PUBLIC_SITE_URL}/members` },
      { name: "twitter:title", content: "Members \u2014 Sthenos" },
      {
        name: "twitter:description",
        content: "Browse, filter, and manage every athlete in your dojo roster.",
      },
    ],
    links: [{ rel: "canonical", href: `${PUBLIC_SITE_URL}/members` }],
  }),
  component: MembersPage,
  errorComponent: ({ error, reset }) => (
    <RouteErrorPanel error={error} reset={reset} title="The members list didn't load" />
  ),
});

type PaymentMethod = {
  stripe_payment_method_id: string | null;
  brand: string | null;
  last4: string | null;
};

type MemberRow = {
  id: string;
  dojo_id: string;
  user_id: string | null;

  name: string;
  email: string | null;
  phone: string | null;
  discipline: string;
  belt_color: BeltColor;
  belt_label: string;
  stripes: number;
  dan: number | null;
  status: "active" | "lapsed" | "trial";
  plan: "Monthly" | "Annual" | "Drop-in" | "Family";
  last_seen_at: string | null;
  last_invited_at: string | null;
  selected_plan_id: string | null;
  payment_status: "none" | "current" | "due" | "overdue" | "disputed" | null;
  payment_method: string | null;
};

type MemberView = Omit<MemberRow, "belt_color" | "belt_label" | "stripes" | "dan"> & {
  belt: Belt;
  lastSeen: string;
  attendance30d: number;
  attendanceThisMonth: number;
  joined_at: string | null;
  belt_color: BeltColor;
  stripes: number;
  hasPaymentSetup: boolean;
  isCash: boolean;
  cashOverdue: boolean;
  cashPaidThisPeriod: boolean;
  media_consent: boolean;
  media_consent_at: string | null;
  date_of_birth: string | null;
  family_group_id: string | null;
  family_group_name: string | null;
  plan_covered_by: string | null;
  familyLabel: string | null;
  familyMethodLabel: string | null;
};

async function fetchMembers(dojoId: string): Promise<MemberView[]> {
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const period = currentPeriod("month", now);
  const [membersRes, att30Res, attMonthRes, subsRes, paidRes, cashRes, dojoRes] = await Promise.all(
    [
      supabase
        .from("members")
        .select(
          "id,dojo_id,user_id,name,email,phone,discipline,belt_color,belt_label,stripes,dan,status,plan,payment_status,payment_method,last_seen_at,last_invited_at,joined_at,selected_plan_id,media_consent,media_consent_at,date_of_birth,family_group_id,plan_covered_by,family_groups:family_group_id(id,name,payer_member_id),dojo_plans:selected_plan_id(name,plan_type)",
        )
        .eq("dojo_id", dojoId)
        .order("name"),

      supabase
        .from("attendances")
        .select("member_id")
        .eq("dojo_id", dojoId)
        .gte("checked_in_at", since30),
      supabase
        .from("attendances")
        .select("member_id")
        .eq("dojo_id", dojoId)
        .gte("checked_in_at", monthStart),
      supabase
        .from("member_subscriptions")
        .select("member_id")
        .eq("dojo_id", dojoId)
        .in("status", ["active", "trialing", "past_due"]),
      supabase.from("invoices").select("member_id").eq("dojo_id", dojoId).eq("status", "paid"),
      supabase
        .from("cash_payments")
        .select("member_id,period_end")
        .eq("dojo_id", dojoId)
        .lte("period_start", period.end)
        .gte("period_end", period.start),
      supabase.from("dojos").select("hold_grace_days").eq("id", dojoId).maybeSingle(),
    ],
  );

  if (membersRes.error) throw membersRes.error;
  if (att30Res.error) throw att30Res.error;
  if (attMonthRes.error) throw attMonthRes.error;
  if (subsRes.error) throw subsRes.error;
  if (paidRes.error) throw paidRes.error;
  if (cashRes.error) throw cashRes.error;

  const counts30 = new Map<string, number>();
  for (const a of att30Res.data ?? []) {
    counts30.set(a.member_id, (counts30.get(a.member_id) ?? 0) + 1);
  }
  const countsMonth = new Map<string, number>();
  for (const a of attMonthRes.data ?? []) {
    countsMonth.set(a.member_id, (countsMonth.get(a.member_id) ?? 0) + 1);
  }
  // Source of truth for "payment set up": an active Stripe subscription
  // and/or at least one paid invoice. Membership status is NOT payment.
  // Cash members are judged on cash_payments coverage instead.
  const paying = new Set<string>();
  for (const s of subsRes.data ?? []) paying.add(s.member_id);
  for (const i of paidRes.data ?? []) if (i.member_id) paying.add(i.member_id);

  const coveredThrough = new Map<string, string>();
  for (const c of cashRes.data ?? []) {
    const prev = coveredThrough.get(c.member_id);
    if (!prev || c.period_end > prev) coveredThrough.set(c.member_id, c.period_end);
  }
  const graceDays = dojoRes.data?.hold_grace_days ?? 0;

  // Names of family payers, so dependents can read "Covered by …".
  const payerNames = new Map<string, string>();
  const payerMethods = new Map<string, string | null>();
  for (const m of (membersRes.data ?? []) as any[]) {
    payerNames.set(m.id, m.name);
    payerMethods.set(m.id, m.payment_method ?? null);
  }

  return (
    membersRes.data as unknown as (MemberRow & {
      joined_at: string | null;
      media_consent: boolean | null;
      media_consent_at: string | null;
      date_of_birth: string | null;
    })[]
  ).map((m: any) => {
    // The payer's payment method governs the whole family, so a covered
    // member's effective method is always their payer's.
    const payerId: string | null = m.family_groups?.payer_member_id ?? m.plan_covered_by ?? null;
    const isFamilyPayerRow = !!m.family_group_id && payerId === m.id;
    const effectiveMethod =
      !isFamilyPayerRow && payerId
        ? (payerMethods.get(payerId) ?? m.payment_method)
        : m.payment_method;
    const isCash = isCashPayer(effectiveMethod);

    return {
      ...m,
      belt: {
        color: m.belt_color,
        label: m.belt_label,
        stripes: m.stripes ?? 0,
        dan: m.dan ?? undefined,
      },
      lastSeen: m.last_seen_at
        ? formatDistanceToNow(new Date(m.last_seen_at), { addSuffix: true })
        : "—",
      attendance30d: counts30.get(m.id) ?? 0,
      attendanceThisMonth: countsMonth.get(m.id) ?? 0,
      hasPaymentSetup: paying.has(m.id),
      isCash,
      cashPaidThisPeriod: coveredThrough.has(m.id),
      cashOverdue:
        isCash &&
        isCashOverdue({
          coveredThrough: coveredThrough.get(m.id) ?? null,
          graceDays,
          interval: "month",
          ref: now,
        }),
      media_consent: m.media_consent === true,
      media_consent_at: m.media_consent_at ?? null,
      date_of_birth: m.date_of_birth ?? null,
      family_group_id: m.family_group_id ?? null,
      family_group_name: m.family_groups?.name ?? null,
      plan_covered_by: m.plan_covered_by ?? null,
      familyLabel: m.family_group_id
        ? familyRowLabel({
            groupName: m.family_groups?.name ?? null,
            isPayer: isFamilyPayerRow,
            coveredByName:
              payerNames.get(m.family_groups?.payer_member_id ?? "") ??
              (m.plan_covered_by ? (payerNames.get(m.plan_covered_by) ?? null) : null),
          })
        : null,
      /** Effective family arrangement, so who pays and how is never ambiguous. */
      familyMethodLabel:
        m.family_group_id && payerId
          ? isFamilyPayerRow
            ? `Pays for family · ${paymentMethodShortLabel(effectiveMethod)}`
            : `Covered by ${payerNames.get(payerId) ?? "payer"} · ${paymentMethodShortLabel(effectiveMethod)}`
          : null,

    };
  });
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function MembersPage() {
  const qc = useQueryClient();
  const { activeDojoId, activeDojo } = useCurrentDojo();
  const deleteEmptyGroupFn = useServerFn(deleteEmptyFamilyGroup);
  const deleteEmptyGroup = useMutation({
    mutationFn: (groupId: string) =>
      deleteEmptyGroupFn({ data: { dojoId: activeDojoId!, groupId } }),
    onSuccess: () => {
      toast.success("Empty family group deleted");
      qc.invalidateQueries({ queryKey: ["family-coverage-issues"] });
      qc.invalidateQueries({ queryKey: ["family-groups"] });
    },
    onError: (error: Error) => toast.error(error.message || "Could not delete the group"),
  });
  const [query, setQuery] = useState("");
  const [disc, setDisc] = useState<string>("All");
  const [atRiskOnly, setAtRiskOnly] = useState(false);
  const [missingPaymentOnly, setMissingPaymentOnly] = useState(false);
  const [consentFilter, setConsentFilter] = useState<"any" | "granted" | "declined">("any");
  const [minorsOnly, setMinorsOnly] = useState(false);
  const [promoteTarget, setPromoteTarget] = useState<MemberView | null>(null);
  const [editTarget, setEditTarget] = useState<MemberView | null>(null);
  const [memberToDelete, setMemberToDelete] = useState<MemberView | null>(null);
  const [cancelTarget, setCancelTarget] = useState<MemberView | null>(null);
  const [pauseTarget, setPauseTarget] = useState<MemberView | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [cashTarget, setCashTarget] = useState<CashPaymentTarget | null>(null);
  const [familyTargets, setFamilyTargets] = useState<FamilyTarget[] | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filters, setFilters] = useState<MembersFilters>(EMPTY_FILTERS);
  const [quickChip, setQuickChip] = useState<"at_risk" | "trials" | "lapsed" | "no_shows" | null>(
    null,
  );

  const { viewAs } = useAuth();
  const canManage =
    viewAs === "staff" && (activeDojo?.role === "owner" || activeDojo?.role === "admin");

  const {
    data: members = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["members", activeDojoId],
    queryFn: () => fetchMembers(activeDojoId!),
    enabled: !!activeDojoId,
  });

  // Trial allowance usage: a trial who has used their free classes and not
  // converted is a lead worth chasing, so surface it in the roster.
  const trialUsageFn = useServerFn(getTrialUsage);
  const trialIds = members.filter((m) => m.status === "trial").map((m) => m.id);
  const trialUsageQ = useQuery({
    queryKey: ["trial-usage", activeDojoId, trialIds.join(",")],
    queryFn: () => trialUsageFn({ data: { dojoId: activeDojoId!, memberIds: trialIds } }),
    enabled: !!activeDojoId && trialIds.length > 0,
  });
  const trialUsage = new Map(
    (trialUsageQ.data?.usage ?? []).map((u) => [u.memberId, u] as const),
  );

  // Failed collections, so staff spot them in the roster rather than at the door.
  const failedPayments = useFailedPaymentsByMember(activeDojoId ?? null);



  const coverageFn = useServerFn(getFamilyCoverageIssues);
  const familyIssuesQ = useQuery({
    queryKey: ["family-coverage-issues", activeDojoId],
    queryFn: () => coverageFn({ data: { dojoId: activeDojoId! } }),
    enabled: !!activeDojoId && canManage,
  });
  const familyIssues = familyIssuesQ.data?.issues ?? [];
  const singleFamilies = familyIssuesQ.data?.singleMemberFamilies ?? [];
  const duplicateFamilyNames = familyIssuesQ.data?.duplicateNames ?? [];

  // GDPR erasure — always via the server function, which refuses to delete a
  // member whose Stripe subscription can't be verified as cancelled.
  const deleteFn = useServerFn(deleteMember);
  const deleteMutation = useMutation({
    mutationFn: async (memberId: string) => deleteFn({ data: { dojoId: activeDojoId!, memberId } }),
    onSuccess: (res: any) => {
      if (res?.stripeWarning) toast.warning(res.stripeWarning);
      toast.success("Member permanently erased");
      qc.invalidateQueries({ queryKey: ["members"] });
      setMemberToDelete(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const invite = useServerFn(sendPortalInvite);
  const checkout = useServerFn(createCheckoutSession);
  const bulkCash = useServerFn(recordCashPaymentsForPeriod);
  const { setPaymentMethod, dialog: paymentMethodDialog } = useSetPaymentMethod(
    activeDojoId ?? null,
  );

  const clearSelection = () => setSelectedIds(new Set());
  const toggleSelected = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const bulkCashMutation = useMutation({
    mutationFn: (memberIds: string[]) => bulkCash({ data: { dojoId: activeDojoId!, memberIds } }),
    onSuccess: (res) => {
      toast.success(
        `Recorded ${res.recorded} cash ${res.recorded === 1 ? "payment" : "payments"} for ${shortPeriodLabel("month")}`,
        res.skipped.length
          ? {
              description: `Skipped ${res.skipped.length}: ${res.skipped
                .slice(0, 3)
                .map((s) => `${s.name} (${s.reason})`)
                .join(", ")}${res.skipped.length > 3 ? "…" : ""}`,
            }
          : undefined,
      );
      qc.invalidateQueries({ queryKey: ["members"] });
      qc.invalidateQueries({ queryKey: ["cash-dues"] });
      clearSelection();
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not record payments"),
  });
  const [invitingId, setInvitingId] = useState<string | null>(null);
  const [payLinkingId, setPayLinkingId] = useState<string | null>(null);

  const payLinkMutation = useMutation({
    mutationFn: async (m: MemberView) => {
      if (!m.selected_plan_id) throw new Error("Member has no plan selected");
      setPayLinkingId(m.id);
      const res = await checkout({
        data: { memberId: m.id, dojoId: m.dojo_id, planId: m.selected_plan_id },
      });
      if (res.error || !res.url) throw new Error(res.error ?? "Could not create link");
      return res.url;
    },
    onSettled: () => setPayLinkingId(null),
    onSuccess: async (url) => {
      try {
        await navigator.clipboard.writeText(url);
        toast.success("Payment link copied", { description: "Send it to the member." });
      } catch {
        toast.success("Payment link ready", { description: url });
      }
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not create link"),
  });

  const inviteMutation = useMutation({
    mutationFn: (memberId: string) => {
      setInvitingId(memberId);
      return invite({ data: { memberId } });
    },
    onSettled: () => setInvitingId(null),
    onSuccess: (res: { status: string; inviteLink?: string | null }) => {
      const copyAction = res?.inviteLink
        ? {
            label: "Copy invite link",
            onClick: () => {
              navigator.clipboard.writeText(res.inviteLink!);
              toast.success("Invite link copied");
            },
          }
        : undefined;
      if (res?.status === "invite_sent") {
        toast.success("Portal invite sent", {
          description: "They'll receive an email with a link to set up their account.",
          action: copyAction,
        });
      } else if (res?.status === "email_unavailable") {
        toast.warning("Email isn't set up yet — copy the invite link instead", {
          description: res?.inviteLink
            ? "Share this link with the member so they can set up their account."
            : "Configure email in Settings, then try again.",
          action: copyAction,
        });
      } else if (res?.status === "linked_existing") {
        toast.success("Linked to existing account", {
          description:
            "This member already had a Sthenos account — we've connected them to your gym.",
        });
      } else {
        toast.info("Member already linked", {
          description: "This member already has portal access.",
        });
      }
      qc.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (e: Error) => {
      // Server throws InviteError with a user-safe message.
      const msg = e?.message?.trim() || "Could not send invite. Please try again.";
      const lower = msg.toLowerCase();
      if (lower.includes("wait") && lower.includes("minute")) {
        toast.warning("Invite already sent", { description: msg });
      } else if (lower.includes("permission") || lower.includes("forbidden")) {
        toast.error("Not allowed", { description: msg });
      } else if (lower.includes("email")) {
        toast.error("Email problem", { description: msg });
      } else {
        toast.error("Couldn't send invite", { description: msg });
      }
    },
  });

  const { data: dojoPlans = [] } = useQuery({
    queryKey: ["dojo-plans", activeDojoId],
    enabled: !!activeDojoId,
    queryFn: async () => {
      const { data } = await supabase
        .from("dojo_plans")
        .select("name")
        .eq("dojo_id", activeDojoId!);
      return data ?? [];
    },
  });

  // Discipline chips come ONLY from disciplines actually present on this dojo's
  // members. Class types (dojo_class_types) are for scheduling and must never
  // leak into discipline lists.
  const disciplineNames = useMemo(() => {
    const fromMembers = Array.from(new Set(members.map((m) => m.discipline).filter(Boolean)));
    return fromMembers.sort((a, b) => a.localeCompare(b));
  }, [members]);

  const disciplines = useMemo(() => ["All", ...disciplineNames], [disciplineNames]);

  const beltOptions = useMemo(() => {
    const set = new Set<string>();
    for (const d of disciplineNames) for (const b of getBeltColors(d)) set.add(b);
    if (set.size === 0) for (const b of getBeltColors()) set.add(b);
    for (const m of members) if (m.belt_color) set.add(m.belt_color);
    return Array.from(set);
  }, [disciplineNames, members]);

  const planOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of dojoPlans as { name: string }[]) if (p.name) set.add(p.name);
    for (const m of members) if (m.plan) set.add(m.plan);
    return Array.from(set);
  }, [dojoPlans, members]);

  const filtered = useMemo(() => {
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay());
    weekStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const yearStart = new Date(now.getFullYear(), 0, 1);
    const d14 = Date.now() - 14 * 86400000;
    const d30 = Date.now() - 30 * 86400000;
    const d60 = Date.now() - 60 * 86400000;
    const d21 = Date.now() - 21 * 86400000;
    const y1 = Date.now() - 365 * 86400000;

    return members.filter((m) => {
      if (disc !== "All" && m.discipline !== disc) return false;
      if (query && !m.name.toLowerCase().includes(query.toLowerCase())) return false;
      if (
        atRiskOnly &&
        !(m.status === "active" && (!m.last_seen_at || daysSince(m.last_seen_at) > 7))
      )
        return false;
      // "Missing payment" = card member without payment set up, OR a cash
      // member who is overdue for the current period.
      if (missingPaymentOnly && !(m.isCash ? m.cashOverdue : !m.hasPaymentSetup)) return false;
      if (minorsOnly && !isMinor(m.date_of_birth)) return false;
      if (consentFilter === "granted" && !m.media_consent) return false;
      if (consentFilter === "declined" && m.media_consent) return false;

      // Advanced filters
      if (filters.belts.length && !filters.belts.includes(m.belt_color)) return false;
      if (filters.statuses.length && !filters.statuses.includes(m.status)) return false;
      if (filters.plans.length && !filters.plans.includes(m.plan)) return false;
      if (filters.disciplines.length && !filters.disciplines.includes(m.discipline)) return false;

      const lsTime = m.last_seen_at ? new Date(m.last_seen_at).getTime() : null;
      switch (filters.lastSeen) {
        case "this_week":
          if (!lsTime || lsTime < weekStart.getTime()) return false;
          break;
        case "this_month":
          if (!lsTime || lsTime < monthStart.getTime()) return false;
          break;
        case "over_14d":
          if (lsTime && lsTime >= d14) return false;
          break;
        case "over_30d":
          if (lsTime && lsTime >= d30) return false;
          break;
        case "over_60d":
          if (lsTime && lsTime >= d60) return false;
          break;
      }

      const jTime = m.joined_at ? new Date(m.joined_at).getTime() : null;
      switch (filters.joined) {
        case "this_month":
          if (!jTime || jTime < monthStart.getTime()) return false;
          break;
        case "this_year":
          if (!jTime || jTime < yearStart.getTime()) return false;
          break;
        case "over_1y":
          if (!jTime || jTime >= y1) return false;
          break;
      }

      if (filters.stripes !== "any" && (m.stripes ?? 0) !== Number(filters.stripes)) return false;

      const sm = m.attendanceThisMonth;
      switch (filters.sessions) {
        case "0":
          if (sm !== 0) return false;
          break;
        case "1_3":
          if (sm < 1 || sm > 3) return false;
          break;
        case "4_plus":
          if (sm < 4) return false;
          break;
        case "8_plus":
          if (sm < 8) return false;
          break;
      }

      // Quick chips
      if (quickChip === "at_risk") {
        if (!(m.status === "active" && (!lsTime || lsTime < d21))) return false;
      } else if (quickChip === "trials") {
        if (m.status !== "trial") return false;
      } else if (quickChip === "lapsed") {
        if (m.status !== "lapsed") return false;
      } else if (quickChip === "no_shows") {
        if (sm !== 0) return false;
      }

      return true;
    });
  }, [
    members,
    query,
    disc,
    atRiskOnly,
    missingPaymentOnly,
    minorsOnly,
    consentFilter,
    filters,
    quickChip,
  ]);

  const activeFilterCount =
    countActiveFilters(filters) +
    (quickChip ? 1 : 0) +
    (consentFilter !== "any" ? 1 : 0) +
    (minorsOnly ? 1 : 0);

  const activeCount = members.filter((m) => m.status === "active").length;
  const atRiskCount = members.filter(
    (m) => m.status === "active" && (!m.last_seen_at || daysSince(m.last_seen_at) > 7),
  ).length;
  // Cash members never "add payment details" — they're excluded entirely.
  const activeCardMembers = members.filter((m) => m.status === "active" && !m.isCash);
  const membersMissingPayment = activeCardMembers.filter((m) => !m.hasPaymentSetup);
  const activeMissingPaymentCount = membersMissingPayment.length;
  const showPaymentBanner =
    activeCardMembers.length > 0 && activeMissingPaymentCount / activeCardMembers.length > 0.2;

  return (
    <main>
      <PageHeader
        title="Members"
        subtitle={`${members.length} total · ${activeCount} active · ${atRiskCount} at risk`}
        actions={
          <>
            <RefreshControl />
            {canManage && (
              <Button
                size="sm"
                onClick={() => setAddOpen(true)}
                className="bg-brand text-brand-foreground hover:bg-brand/90"
              >
                <Plus className="size-4" /> Add Member
              </Button>
            )}
          </>
        }
      />

      <div className="mx-auto max-w-7xl space-y-6 p-8">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="flex items-center gap-1 rounded-md bg-zinc-100 p-1">
            {disciplines.map((d) => (
              <button
                key={d}
                onClick={() => setDisc(d)}
                className={cn(
                  "rounded px-3 py-1 text-xs font-medium transition-colors",
                  disc === d
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {d}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 rounded-md bg-zinc-100 p-1">
            <button
              onClick={() => setAtRiskOnly((v) => !v)}
              className={cn(
                "rounded px-3 py-1 text-xs font-medium transition-colors",
                atRiskOnly
                  ? "bg-amber-500 text-white shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              At Risk
            </button>
            <button
              onClick={() => setMissingPaymentOnly((v) => !v)}
              className={cn(
                "rounded px-3 py-1 text-xs font-medium transition-colors",
                missingPaymentOnly
                  ? "bg-amber-500 text-white shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Missing payment
            </button>
            <button
              onClick={() => setMinorsOnly((v) => !v)}
              className={cn(
                "rounded px-3 py-1 text-xs font-medium transition-colors",
                minorsOnly
                  ? "bg-amber-500 text-white shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Minors
            </button>
          </div>
          <div className="flex items-center gap-1 rounded-md bg-zinc-100 p-1">
            {(["any", "granted", "declined"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setConsentFilter(v)}
                className={cn(
                  "rounded px-3 py-1 text-xs font-medium transition-colors",
                  consentFilter === v
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {v === "any" ? "All consent" : v === "granted" ? "Media OK" : "No media"}
              </button>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFiltersOpen((v) => !v)}
            className="gap-2"
          >
            <SlidersHorizontal className="size-4" />
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
          </Button>
        </div>

        {filtersOpen && (
          <MembersFilterPanel
            value={filters}
            onChange={setFilters}
            beltOptions={beltOptions}
            planOptions={planOptions}
            disciplineOptions={disciplineNames}
          />
        )}

        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              ["at_risk", "At risk"],
              ["trials", "Trials"],
              ["lapsed", "Lapsed"],
              ["no_shows", "No shows this month"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setQuickChip((c) => (c === key ? null : key))}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition",
                quickChip === key
                  ? "border-brand bg-brand text-brand-foreground"
                  : "border-zinc-200 bg-card text-muted-foreground hover:border-zinc-300 hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
          <div className="ml-auto text-xs text-muted-foreground">
            {activeFilterCount > 0 || query
              ? `Showing ${filtered.length} of ${members.length} ${members.length === 1 ? "member" : "members"}`
              : `Showing all ${members.length} ${members.length === 1 ? "member" : "members"}`}
          </div>
        </div>

        {showPaymentBanner && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-amber-100 px-4 py-3 ring-1 ring-amber-500/30">
            <p className="text-sm text-amber-900">
              <span className="font-semibold">{activeMissingPaymentCount}</span> card members
              haven't added payment details yet.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="border-amber-300 bg-white text-amber-900 hover:bg-amber-100"
              onClick={() =>
                toast(
                  `Reminder queued for ${membersMissingPayment.length} card ${membersMissingPayment.length === 1 ? "member" : "members"} — cash members excluded`,
                )
              }
            >
              Send reminder
            </Button>
          </div>
        )}

        {canManage && familyIssues.length > 0 && (
          <div className="mb-6 rounded-xl bg-violet-50 p-4 ring-1 ring-inset ring-violet-500/25">
            <div className="flex items-center gap-2 text-sm font-semibold text-violet-900">
              <Users className="size-4" /> Family plans need attention
            </div>
            <ul className="mt-2 space-y-1.5">
              {familyIssues.map((issue, i) => (
                <li key={issue.groupId ?? `orphan-${i}`} className="text-xs text-violet-900/90">
                  <span className="font-medium">{issue.groupName ?? "Family members"}</span> —{" "}
                  {issue.reason === "payer_inactive"
                    ? `${issue.payerName ?? "The payer"} is no longer paying`
                    : "no payer chosen"}
                  . Needs their own plan or a new payer:{" "}
                  {issue.members.map((mm, idx) => (
                    <span key={mm.id}>
                      {idx > 0 ? ", " : ""}
                      <Link
                        to="/members/$memberId"
                        params={{ memberId: mm.id }}
                        className="underline"
                      >
                        {mm.name}
                      </Link>
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        )}

        {canManage && (duplicateFamilyNames.length > 0 || singleFamilies.length > 0) && (
          <div className="mb-6 rounded-xl bg-amber-100 p-4 ring-1 ring-inset ring-amber-500/25">
            <div className="flex items-center gap-2 text-sm font-semibold text-amber-900">
              <Users className="size-4" /> Duplicate or one-person families
            </div>
            <ul className="mt-2 space-y-1.5">
              {duplicateFamilyNames.map((d) => (
                <li key={`dup-${d.name}`} className="text-xs text-amber-900/90">
                  <span className="font-medium">{d.name}</span> — {d.groups.length} separate groups
                  share this name. Merge them from any member's profile so one payer covers the
                  whole family.
                </li>
              ))}
              {singleFamilies.map((s) => (
                <li key={`single-${s.groupId}`} className="text-xs text-amber-900/90">
                  <span className="font-medium">{s.groupName}</span> —{" "}
                  {s.member ? (
                    <>
                      only one member (
                      <Link
                        to="/members/$memberId"
                        params={{ memberId: s.member.id }}
                        className="underline"
                      >
                        {s.member.name}
                      </Link>
                      ) in this family, so no discount applies.
                    </>
                  ) : (
                    <>
                      no members in this family.{" "}
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto p-0 text-xs font-semibold text-amber-950 underline"
                        disabled={deleteEmptyGroup.isPending}
                        onClick={() => deleteEmptyGroup.mutate(s.groupId)}
                      >
                        Delete this empty group
                      </Button>
                      .
                    </>
                  )}{" "}
                  {s.member
                    ? s.duplicateOf.length > 0
                      ? "Merge it with the other group of the same name."
                      : "Add the rest of the family or dissolve the group."
                    : null}
                </li>
              ))}
            </ul>
          </div>
        )}

        {canManage && selectedIds.size > 0 && (
          <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-xl bg-foreground px-4 py-3 text-background shadow-lg">
            <span className="text-sm font-medium">{selectedIds.size} selected</span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setPaymentMethod(Array.from(selectedIds), "cash")}
                className="gap-2"
              >
                <Banknote className="size-4" /> Mark as cash payers
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => bulkCashMutation.mutate(Array.from(selectedIds))}
                disabled={bulkCashMutation.isPending}
                className="gap-2"
              >
                <Banknote className="size-4" />
                {bulkCashMutation.isPending
                  ? "Recording…"
                  : `Record cash payment · ${shortPeriodLabel("month")}`}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  setFamilyTargets(
                    members
                      .filter((m) => selectedIds.has(m.id))
                      .map((m) => ({ id: m.id, name: m.name })),
                  )
                }
                className="gap-2"
              >
                <Users className="size-4" /> Add to family
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={clearSelection}
                className="text-background hover:text-background"
              >
                Clear
              </Button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto rounded-xl bg-card ring-1 ring-black/5">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-zinc-950/5 bg-zinc-50/50">
                {canManage && (
                  <th className="w-10 pl-6 py-3">
                    <Checkbox
                      aria-label="Select all members"
                      checked={filtered.length > 0 && filtered.every((m) => selectedIds.has(m.id))}
                      onCheckedChange={(v) =>
                        setSelectedIds(v ? new Set(filtered.map((m) => m.id)) : new Set())
                      }
                    />
                  </th>
                )}
                <th className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Student
                </th>
                <th className="hidden md:table-cell px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Discipline
                </th>
                <th className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Rank
                </th>
                <th className="hidden md:table-cell px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Plan
                </th>
                <th className="hidden md:table-cell px-6 py-3 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  30d Visits
                </th>
                <th className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Status
                </th>
                <th className="hidden md:table-cell px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Payment
                </th>
                <th className="hidden lg:table-cell px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Media consent
                </th>
                {canManage && <th className="px-6 py-3" />}
              </tr>
            </thead>

            <tbody className="divide-y divide-zinc-950/5">
              {isLoading && (
                <tr>
                  <td
                    colSpan={canManage ? 10 : 8}
                    className="px-6 py-10 text-center text-sm text-muted-foreground"
                  >
                    Loading members…
                  </td>
                </tr>
              )}
              {error && !isLoading && (
                <tr>
                  <td
                    colSpan={canManage ? 10 : 8}
                    className="px-6 py-10 text-center text-sm text-destructive"
                  >
                    Couldn't load members. {(error as Error).message}
                  </td>
                </tr>
              )}
              {!isLoading &&
                !error &&
                filtered.map((m) => (
                  <tr key={m.id} className="transition-colors hover:bg-zinc-50/40">
                    {canManage && (
                      <td className="w-10 pl-6 py-3">
                        <Checkbox
                          aria-label={`Select ${m.name}`}
                          checked={selectedIds.has(m.id)}
                          onCheckedChange={() => toggleSelected(m.id)}
                        />
                      </td>
                    )}
                    <td className="px-6 py-3">
                      <div className="flex items-center gap-3">
                        <MemberAvatar name={m.name} />
                        <div className="min-w-0">
                          <Link
                            to="/members/$memberId"
                            params={{ memberId: m.id }}
                            className="block truncate max-w-[200px] cursor-pointer text-sm font-medium hover:underline"
                          >
                            {m.status === "active" &&
                              (!m.last_seen_at || daysSince(m.last_seen_at) > 7) && (
                                <span className="inline-block size-2 rounded-full bg-amber-500" />
                              )}{" "}
                            {m.name}
                          </Link>
                          <div className="truncate max-w-[200px] text-[11px] text-muted-foreground">
                            {m.email ?? "—"}
                          </div>
                          {m.familyLabel && (
                            <div className="mt-0.5 inline-flex max-w-[200px] items-center gap-1 truncate rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-800 ring-1 ring-inset ring-violet-500/20">
                              <Users className="size-2.5 shrink-0" />
                              <span className="truncate">{m.familyLabel}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="hidden md:table-cell px-6 py-3 text-sm text-zinc-600">
                      {m.discipline}
                    </td>
                    <td className="px-6 py-3">
                      <BeltChip belt={m.belt} discipline={m.discipline} />
                    </td>
                    <td className="hidden md:table-cell px-6 py-3 text-sm text-zinc-600">
                      {m.plan}
                    </td>
                    <td className="hidden md:table-cell px-6 py-3 text-right text-sm font-medium tabular-nums">
                      {m.attendance30d}
                    </td>
                    <td className="px-6 py-3">
                      <StatusPill status={m.status} />
                      {(() => {
                        const u = trialUsage.get(m.id);
                        if (!u || !trialOffered(u.policy)) return null;
                        return (
                          <div
                            className={
                              u.ended
                                ? "mt-1 text-[11px] font-medium text-amber-700"
                                : "mt-1 text-[11px] text-muted-foreground"
                            }
                          >
                            {u.ended ? "Trial ended — needs a plan" : trialProgressText(u)}
                          </div>
                        );
                      })()}
                    </td>
                    <td className="hidden md:table-cell px-6 py-3">
                      {(() => {
                        const failed = failedPayments.get(m.id);
                        return failed ? (
                          <div className="mb-1">
                            <PaymentFailedBadge row={failed} />
                          </div>
                        ) : null;
                      })()}
                      {m.payment_status === "disputed" ? (

                        <PaymentPill hasCard={false} disputed />
                      ) : m.plan_covered_by ? (
                        // Covered members never pay separately — their family's
                        // arrangement is the whole story.
                        <span className="text-[11px] font-medium text-zinc-600">
                          {m.familyMethodLabel ?? "Covered by family"}
                        </span>
                      ) : m.isCash ? (
                        canManage ? (
                          <CashPaidToggle
                            dojoId={m.dojo_id}
                            memberId={m.id}
                            paid={m.cashPaidThisPeriod}
                            interval="month"
                          />
                        ) : (
                          <PaymentPill hasCard={false} isCash cashOverdue={m.cashOverdue} />
                        )
                      ) : (
                        <div className="flex items-center gap-2">
                          <PaymentPill hasCard={!!m.hasPaymentSetup} isCash={false} />
                          {canManage && !m.hasPaymentSetup && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  type="button"
                                  className="text-[11px] font-medium text-brand underline-offset-2 hover:underline"
                                >
                                  How to fix
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="start">
                                <DropdownMenuItem
                                  onClick={() => setPaymentMethod([m.id], "cash")}
                                  className="gap-2"
                                >
                                  <Banknote className="size-4" /> They pay cash
                                </DropdownMenuItem>
                                {m.selected_plan_id && (
                                  <DropdownMenuItem
                                    onClick={() => payLinkMutation.mutate(m)}
                                    className="gap-2"
                                  >
                                    <CreditCard className="size-4" /> Send payment link
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                  onClick={() => setEditTarget(m)}
                                  className="gap-2"
                                >
                                  <Pencil className="size-4" /> Edit payment method
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="hidden lg:table-cell px-6 py-3">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                          m.media_consent
                            ? "bg-emerald-500/10 text-emerald-700"
                            : "bg-zinc-500/10 text-zinc-600",
                        )}
                      >
                        {m.media_consent ? "Granted" : "Not granted"}
                      </span>
                      {isMinor(m.date_of_birth) && (
                        <span className="ml-1 text-[10px] text-muted-foreground">(minor)</span>
                      )}
                    </td>
                    {canManage && (
                      <td className="px-6 py-3 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                              <MoreVertical className="size-4" />
                              <span className="sr-only">Open menu</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setPromoteTarget(m)} className="gap-2">
                              <Award className="size-4" /> Promote
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setEditTarget(m)} className="gap-2">
                              <Pencil className="size-4" /> Edit
                            </DropdownMenuItem>
                            {!m.isCash && (
                              <DropdownMenuItem
                                onClick={() => setPaymentMethod([m.id], "cash")}
                                className="gap-2"
                              >
                                <Banknote className="size-4" /> Mark as cash payer
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              onClick={() =>
                                setCashTarget({ id: m.id, dojo_id: m.dojo_id, name: m.name })
                              }
                              className="gap-2"
                            >
                              <Banknote className="size-4" /> Record cash payment…
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => setFamilyTargets([{ id: m.id, name: m.name }])}
                              className="gap-2"
                            >
                              <Users className="size-4" /> Add to family
                            </DropdownMenuItem>
                            {!m.user_id &&
                              m.email &&
                              (() => {
                                const last = m.last_invited_at
                                  ? new Date(m.last_invited_at).getTime()
                                  : 0;
                                const cooling = last > 0 && Date.now() - last < 5 * 60 * 1000;
                                const isThisInviting =
                                  invitingId === m.id && inviteMutation.isPending;
                                const disabled =
                                  isThisInviting || cooling || inviteMutation.isPending;
                                return (
                                  <DropdownMenuItem
                                    onClick={(e) => {
                                      if (disabled) {
                                        e.preventDefault();
                                        return;
                                      }
                                      inviteMutation.mutate(m.id);
                                    }}
                                    disabled={disabled}
                                    className="gap-2"
                                  >
                                    <Mail className="size-4" />
                                    {isThisInviting
                                      ? "Sending invite…"
                                      : cooling
                                        ? "Invite just sent"
                                        : m.last_invited_at
                                          ? "Resend portal invite"
                                          : "Send portal invite"}
                                  </DropdownMenuItem>
                                );
                              })()}

                            {m.selected_plan_id && (
                              <DropdownMenuItem
                                onClick={(e) => {
                                  if (payLinkMutation.isPending) {
                                    e.preventDefault();
                                    return;
                                  }
                                  payLinkMutation.mutate(m);
                                }}
                                disabled={payLinkMutation.isPending}
                                className="gap-2"
                              >
                                <CreditCard className="size-4" />
                                {payLinkingId === m.id && payLinkMutation.isPending
                                  ? "Creating link…"
                                  : "Send payment link"}
                              </DropdownMenuItem>
                            )}

                            {(m.status === "active" || m.status === "trial") && (
                              <DropdownMenuItem onClick={() => setPauseTarget(m)} className="gap-2">
                                <PauseCircle className="size-4" /> Pause membership…
                              </DropdownMenuItem>
                            )}

                            <DropdownMenuItem onClick={() => setCancelTarget(m)} className="gap-2">
                              <Ban className="size-4" /> Cancel membership…
                            </DropdownMenuItem>

                            <DropdownMenuItem
                              onClick={() => setMemberToDelete(m)}
                              className="gap-2 text-destructive focus:text-destructive focus:bg-destructive/10"
                            >
                              <Trash2 className="size-4" /> Erase member data (GDPR)
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    )}
                  </tr>
                ))}
              {!isLoading && !error && filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={canManage ? 10 : 8}
                    className="px-6 py-10 text-center text-sm text-muted-foreground"
                  >
                    No members match your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <PromoteDialog
        member={
          promoteTarget
            ? {
                id: promoteTarget.id,
                dojo_id: promoteTarget.dojo_id,
                name: promoteTarget.name,
                discipline: promoteTarget.discipline,
                belt_color: promoteTarget.belt.color,
                belt_label: promoteTarget.belt.label,
                stripes: promoteTarget.belt.stripes ?? 0,
                dan: promoteTarget.belt.dan ?? null,
              }
            : null
        }
        open={!!promoteTarget}
        onOpenChange={(o) => !o && setPromoteTarget(null)}
      />
      <EndMembershipDialog
        open={!!cancelTarget}
        onOpenChange={(o) => !o && setCancelTarget(null)}
        dojoId={activeDojoId ?? null}
        member={cancelTarget ? { id: cancelTarget.id, name: cancelTarget.name } : null}
        source="members list"
        onDone={() => setCancelTarget(null)}
      />
      {pauseTarget && activeDojoId && (
        <PauseMembershipDialog
          open
          dojoId={activeDojoId}
          memberId={pauseTarget.id}
          memberName={pauseTarget.name}
          onClose={() => setPauseTarget(null)}
        />
      )}
      <AlertDialog open={!!memberToDelete} onOpenChange={(o) => !o && setMemberToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive">
              Permanently erase {memberToDelete?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This is a GDPR erasure. It permanently removes this member and their personal data —
              attendance, class bookings, promotions, waiver signatures, subscription records and
              messages. Invoices are kept for financial records but anonymised. This cannot be
              undone. To simply stop billing while keeping their record and history, use{" "}
              <strong>Cancel membership</strong> instead. If they still have a live subscription,
              the erasure is blocked until Stripe confirms it is cancelled.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setMemberToDelete(null)}
              disabled={deleteMutation.isPending}
            >
              Keep member
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (memberToDelete) deleteMutation.mutate(memberToDelete.id);
              }}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? "Erasing…" : "Permanently erase"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <EditMemberDialog
        member={editTarget}
        open={!!editTarget}
        onOpenChange={(o) => !o && setEditTarget(null)}
      />
      <AddMemberDialog open={addOpen} onOpenChange={setAddOpen} />
      <RecordCashPaymentDialog
        member={cashTarget}
        open={!!cashTarget}
        onOpenChange={(o) => !o && setCashTarget(null)}
      />
      <AddToFamilyDialog
        dojoId={activeDojoId ?? null}
        members={familyTargets ?? []}
        open={!!familyTargets}
        onOpenChange={(o) => !o && setFamilyTargets(null)}
      />
      {paymentMethodDialog}
    </main>
  );
}

function StatusPill({ status }: { status: "active" | "lapsed" | "trial" }) {
  const map = {
    active: "bg-emerald-50 text-emerald-700 ring-emerald-500/20",
    lapsed: "bg-orange-50 text-orange-700 ring-orange-500/20",
    trial: "bg-blue-50 text-blue-700 ring-blue-500/20",
  };
  return (
    <span
      className={cn(
        "rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset",
        map[status],
      )}
    >
      {status}
    </span>
  );
}

function PaymentPill({
  hasCard,
  isCash = false,
  cashOverdue = false,
  disputed = false,
}: {
  hasCard: boolean;
  isCash?: boolean;
  cashOverdue?: boolean;
  disputed?: boolean;
}) {
  const base =
    "rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset";
  // An open chargeback must never look like a normal paying member.
  if (disputed) {
    return (
      <span className={cn(base, "bg-destructive text-destructive-foreground ring-destructive/30")}>
        Chargeback
      </span>
    );
  }
  if (isCash) {
    return cashOverdue ? (
      <span className={cn(base, "bg-amber-100 text-amber-700 ring-amber-500/20")}>
        Cash — overdue
      </span>
    ) : (
      <span className={cn(base, "bg-slate-100 text-slate-700 ring-slate-500/20")}>Cash</span>
    );
  }
  return hasCard ? (
    <span className={cn(base, "bg-emerald-50 text-emerald-700 ring-emerald-500/20")}>Set up</span>
  ) : (
    <span className={cn(base, "bg-zinc-100 text-zinc-600 ring-zinc-500/20")}>Not set</span>
  );
}
