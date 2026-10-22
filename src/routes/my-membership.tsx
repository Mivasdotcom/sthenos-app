import { PUBLIC_SITE_URL } from "@/lib/site";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/use-auth";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { supabase } from "@/integrations/supabase/client";
import {
  Building2,
  CheckCircle2,
  AlertTriangle,
  CalendarDays,
  CreditCard,
  UserRound,
  Loader2,
  CircleDashed,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { StartMembershipCard } from "@/components/StartMembershipCard";


export const Route = createFileRoute("/my-membership")({
  head: () => ({
    meta: [
      { title: "My Membership — Sthenos" },
      { name: "description", content: "Track your membership status, dojo, and history." },
      { property: "og:title", content: "My Membership — Sthenos" },
      { property: "og:description", content: "Track your membership status, dojo, and history." },
      { property: "og:url", content: `${PUBLIC_SITE_URL}/my-membership` },
    ],
    links: [{ rel: "canonical", href: `${PUBLIC_SITE_URL}/my-membership` }],
  }),
  component: MyMembershipPage,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-6 text-sm text-destructive">
      {error.message}
    </div>
  ),
  notFoundComponent: () => <div className="p-6 text-sm">Not found.</div>,
});

type Member = {
  id: string;
  dojo_id: string;
  status: string;
  payment_status: string | null;
  plan: string | null;
  selected_plan_id: string | null;
  dojo_plans: { name: string } | null;
  joined_at: string | null;
  cancellation_requested_at: string | null;
  cancellation_reason: string | null;
  signup_source: string | null;
  waiver_signed_at: string | null;
  created_at: string;
};

type DojoLite = { id: string; name: string; slug: string };

type StatusEvent = {
  id: string;
  changed_at: string;
  from_status: string | null;
  to_status: string | null;
  from_payment_status: string | null;
  to_payment_status: string | null;
};

type CancelEvent = {
  id: string;
  created_at: string;
  action: string;
  reason: string | null;
};

function MyMembershipPage() {
  const { user } = useAuth();
  const {
    memberships,
    activeDojoId,
    activeDojo,
    setActiveDojoId,
    loading: dojoLoading,
  } = useCurrentDojo();

  const { data, isLoading } = useQuery({
    queryKey: ["my-membership", user?.id, activeDojoId],
    enabled: !!user?.id && !!activeDojoId,
    queryFn: async () => {
      const [memberRes, dojoRes] = await Promise.all([
        supabase
          .from("members")
          .select(
            "id, dojo_id, status, payment_status, plan, selected_plan_id, dojo_plans:selected_plan_id (name), joined_at, cancellation_requested_at, cancellation_reason, signup_source, waiver_signed_at, created_at",
          )
          .eq("user_id", user!.id)
          .eq("dojo_id", activeDojoId!)
          .maybeSingle(),
        supabase
          .from("dojos")
          .select("id, name, slug, tagline, contact_email")
          .eq("id", activeDojoId!)
          .maybeSingle(),
      ]);
      if (memberRes.error) throw memberRes.error;
      if (dojoRes.error) throw dojoRes.error;
      const member = memberRes.data as Member | null;
      const dojo = dojoRes.data as
        | (DojoLite & { tagline: string | null; contact_email: string | null })
        | null;

      let statusEvents: StatusEvent[] = [];
      let cancelEvents: CancelEvent[] = [];
      if (member?.id) {
        const [sRes, cRes] = await Promise.all([
          supabase
            .from("member_status_history")
            .select(
              "id, changed_at, from_status, to_status, from_payment_status, to_payment_status",
            )
            .eq("member_id", member.id)
            .order("changed_at", { ascending: false }),
          supabase
            .from("cancellation_audit_log")
            .select("id, created_at, action, reason")
            .eq("member_id", member.id)
            .order("created_at", { ascending: false }),
        ]);
        statusEvents = (sRes.data ?? []) as StatusEvent[];
        cancelEvents = (cRes.data ?? []) as CancelEvent[];
      }
      return { member, dojo, statusEvents, cancelEvents };
    },
  });

  if (dojoLoading || isLoading) {
    return (
      <div className="grid h-64 place-items-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="My Membership"
        subtitle="Your current status, dojo, and what happens next."
      />

      {memberships.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {memberships.length > 1 && (
            <DojoSwitcher
              memberships={memberships}
              activeDojoId={activeDojoId}
              onSelect={setActiveDojoId}
            />
          )}

          <StatusCard
            member={data?.member ?? null}
            dojo={data?.dojo ?? null}
            activeRole={activeDojo?.role ?? null}
          />

          {activeDojoId && (
            <StartMembershipCard
              dojoId={activeDojoId}
              returnPath="/portal"
              showCoverage
            />
          )}


          <NextActions
            member={data?.member ?? null}
            dojo={data?.dojo ?? null}
            activeRole={activeDojo?.role ?? null}
          />

          <Timeline
            member={data?.member ?? null}
            dojoName={data?.dojo?.name ?? ""}
            statusEvents={data?.statusEvents ?? []}
            cancelEvents={data?.cancelEvents ?? []}
          />
        </>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border bg-card p-8 text-center">
      <Building2 className="mx-auto mb-3 size-8 text-muted-foreground" />
      <h2 className="font-display text-lg font-semibold">You're not linked to a dojo yet</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Join an existing gym or wait for your manager to approve your request.
      </p>
      <Button asChild className="mt-4">
        <Link to="/onboarding">Find a dojo</Link>
      </Button>
    </div>
  );
}

function DojoSwitcher({
  memberships,
  activeDojoId,
  onSelect,
}: {
  memberships: { dojoId: string; name: string; role: string }[];
  activeDojoId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Your dojos
      </div>
      <div className="flex flex-wrap gap-2">
        {memberships.map((m) => {
          const active = m.dojoId === activeDojoId;
          return (
            <button
              key={m.dojoId}
              onClick={() => onSelect(m.dojoId)}
              className={cn(
                "flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                active
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-background hover:bg-muted/60",
              )}
            >
              <Building2 className="size-4" />
              <span className="font-medium">{m.name}</span>
              <Badge variant="outline" className="ml-1 capitalize">
                {m.role}
              </Badge>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StatusCard({
  member,
  dojo,
  activeRole,
}: {
  member: Member | null;
  dojo: (DojoLite & { tagline: string | null; contact_email: string | null }) | null;
  activeRole: string | null;
}) {
  const state = derivedState(member, activeRole);
  return (
    <div className="rounded-lg border bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Selected dojo
          </div>
          <div className="flex items-center gap-2">
            <Building2 className="size-5 text-muted-foreground" />
            <span className="font-display text-xl font-semibold">{dojo?.name ?? "—"}</span>
          </div>
          {dojo?.tagline && <p className="text-sm text-muted-foreground">{dojo.tagline}</p>}
        </div>
        <StatusBadge state={state} />
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Stat
          icon={<UserRound className="size-4" />}
          label="Role"
          value={activeRole ? cap(activeRole) : "—"}
        />
        <Stat
          icon={<CalendarDays className="size-4" />}
          label="Joined"
          value={
            member?.joined_at
              ? fmtDate(member.joined_at)
              : member?.created_at
                ? fmtDate(member.created_at)
                : "—"
          }
        />
        <Stat
          icon={<CreditCard className="size-4" />}
          label="Plan"
          value={member ? (member.dojo_plans?.name ?? "No plan assigned") : "—"}
        />
      </div>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-sm font-medium">{value}</div>
    </div>
  );
}

type State =
  | "active"
  | "trial"
  | "lapsed"
  | "cancellation-requested"
  | "no-member-row"
  | "unknown";

function derivedState(member: Member | null, role: string | null): State {
  if (!member) return "no-member-row";
  if (member.cancellation_requested_at) return "cancellation-requested";
  if (member.status === "active") return "active";
  if (member.status === "trial") return "trial";
  if (member.status === "lapsed") return "lapsed";
  return "unknown";
}

function StatusBadge({ state }: { state: State }) {
  const map: Record<State, { label: string; icon: React.ReactNode; cls: string }> = {
    active: {
      label: "Active",
      icon: <CheckCircle2 className="size-3.5" />,
      cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
    },
    trial: {
      label: "Trial",
      icon: <CircleDashed className="size-3.5" />,
      cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30",
    },
    lapsed: {
      label: "Lapsed",
      icon: <AlertTriangle className="size-3.5" />,
      cls: "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30",
    },
    "cancellation-requested": {
      label: "Cancellation requested",
      icon: <XCircle className="size-3.5" />,
      cls: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30",
    },
    "no-member-row": {
      label: "Not enrolled",
      icon: <CircleDashed className="size-3.5" />,
      cls: "bg-muted text-muted-foreground border-border",
    },
    unknown: {
      label: "Unknown",
      icon: <CircleDashed className="size-3.5" />,
      cls: "bg-muted text-muted-foreground border-border",
    },
  };
  const cfg = map[state];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
        cfg.cls,
      )}
    >
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

function NextActions({
  member,
  dojo,
  activeRole,
}: {
  member: Member | null;
  dojo: (DojoLite & { tagline: string | null; contact_email: string | null }) | null;
  activeRole: string | null;
}) {
  const state = derivedState(member, activeRole);
  const actions: { title: string; description: string; cta?: { label: string; to: string } }[] = [];

  if (state === "active" || state === "trial") {
    actions.push({
      title: "You're all set",
      description: "Check in to classes and track your progress from your portal.",
      cta: { label: "Open my portal", to: "/portal" },
    });
    if (!member?.waiver_signed_at && (activeRole === "member" || activeRole === "coach")) {
      actions.push({
        title: "Sign your waiver",
        description: "Your dojo requires a signed waiver on file before your next class.",
        cta: { label: "Review profile", to: "/profile" },
      });
    }
  } else if (state === "lapsed") {
    actions.push({
      title: "Reactivate your membership",
      description: "Your status is lapsed. Get in touch with the gym to renew your plan.",
      cta: { label: "Manage billing", to: "/billing" },
    });
  } else if (state === "cancellation-requested") {
    actions.push({
      title: "Cancellation under review",
      description:
        "Your request has been submitted. A manager will confirm or follow up by email. You can still attend classes until it's processed.",
      cta: { label: "View request", to: "/profile" },
    });
  } else if (state === "no-member-row") {
    actions.push({
      title: "Find a dojo to join",
      description:
        "You don't have an active membership yet. Browse public gyms or enter a join code.",
      cta: { label: "Join a dojo", to: "/onboarding" },
    });
  }

  if (actions.length === 0) return null;

  return (
    <div className="space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Next steps
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {actions.map((a, i) => (
          <div key={i} className="rounded-lg border bg-card p-4">
            <div className="font-medium">{a.title}</div>
            <p className="mt-1 text-sm text-muted-foreground">{a.description}</p>
            {a.cta && (
              <Button asChild size="sm" variant="outline" className="mt-3">
                <Link to={a.cta.to}>{a.cta.label}</Link>
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

type TimelineItem = {
  ts: string;
  title: string;
  description: string;
  tone: "neutral" | "good" | "warn" | "bad";
};

function buildTimeline(
  member: Member | null,
  dojoName: string,
  statusEvents: StatusEvent[],
  cancelEvents: CancelEvent[],
): TimelineItem[] {
  const items: TimelineItem[] = [];

  if (member?.created_at) {
    items.push({
      ts: member.created_at,
      title:
        member.signup_source === "public_signup"
          ? "Submitted public signup"
          : member.signup_source === "join_request"
            ? "Requested to join"
            : member.signup_source === "manager_added"
              ? "Added by manager"
              : "Record created",
      description: dojoName ? `At ${dojoName}` : "",
      tone: "neutral",
    });
  }
  if (member?.waiver_signed_at) {
    items.push({
      ts: member.waiver_signed_at,
      title: "Waiver signed",
      description: "Required paperwork completed.",
      tone: "good",
    });
  }
  for (const e of statusEvents) {
    if (e.to_status && e.to_status !== e.from_status) {
      items.push({
        ts: e.changed_at,
        title: `Status: ${cap(e.from_status ?? "—")} → ${cap(e.to_status)}`,
        description: "Membership status updated.",
        tone: toneForStatus(e.to_status),
      });
    }
    if (e.to_payment_status && e.to_payment_status !== e.from_payment_status) {
      items.push({
        ts: e.changed_at,
        title: `Payment: ${cap(e.from_payment_status ?? "—")} → ${cap(e.to_payment_status)}`,
        description: "Payment status updated.",
        tone:
          e.to_payment_status === "current"
            ? "good"
            : e.to_payment_status === "overdue"
              ? "bad"
              : "warn",
      });
    }
  }
  for (const c of cancelEvents) {
    items.push({
      ts: c.created_at,
      title: `Cancellation ${cap(c.action)}`,
      description: c.reason || "—",
      tone: c.action === "confirmed" ? "bad" : c.action === "dismissed" ? "good" : "warn",
    });
  }
  if (member?.cancellation_requested_at && !cancelEvents.some((c) => c.action === "requested")) {
    items.push({
      ts: member.cancellation_requested_at,
      title: "Cancellation requested",
      description: member.cancellation_reason || "Awaiting manager review.",
      tone: "warn",
    });
  }

  return items.sort((a, b) => +new Date(b.ts) - +new Date(a.ts));
}

function toneForStatus(s: string): TimelineItem["tone"] {
  if (s === "active") return "good";
  if (s === "trial") return "warn";
  if (s === "lapsed") return "bad";
  return "neutral";
}

function Timeline({
  member,
  dojoName,
  statusEvents,
  cancelEvents,
}: {
  member: Member | null;
  dojoName: string;
  statusEvents: StatusEvent[];
  cancelEvents: CancelEvent[];
}) {
  const items = buildTimeline(member, dojoName, statusEvents, cancelEvents);
  return (
    <div className="rounded-lg border bg-card p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold">Membership timeline</h2>
        <span className="text-xs text-muted-foreground">
          {items.length} event{items.length === 1 ? "" : "s"}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity yet.</p>
      ) : (
        <ol className="relative ml-2 space-y-4 border-l border-border pl-6">
          {items.map((it, i) => (
            <li key={i} className="relative">
              <span
                className={cn(
                  "absolute -left-[29px] mt-1 grid size-4 place-items-center rounded-full border-2 border-background",
                  it.tone === "good" && "bg-emerald-500",
                  it.tone === "warn" && "bg-amber-500",
                  it.tone === "bad" && "bg-rose-500",
                  it.tone === "neutral" && "bg-muted-foreground",
                )}
              />
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="font-medium">{it.title}</div>
                <time className="text-xs text-muted-foreground">{fmtDateTime(it.ts)}</time>
              </div>
              {it.description && (
                <div className="text-sm text-muted-foreground">{it.description}</div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function fmtDate(s: string) {
  return new Date(s).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
function fmtDateTime(s: string) {
  return new Date(s).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
