import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { DojoBrand } from "@/components/DojoBrand";
import { LogoMark } from "@/components/Logo";
import { useDojoLogoUrl } from "@/hooks/use-dojo-logo";
import {
  LayoutDashboard,
  Users,
  CalendarCheck,
  CalendarDays,
  Medal,
  CreditCard,
  UserRound,
  Settings,
  LogOut,
  BarChart3,
  Upload,
  Sparkles,
  MessageSquare,
  UserMinus,
  Eye,
  Building2,
} from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { unreadConversationsCount } from "@/lib/communications.functions";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { supabase } from "@/integrations/supabase/client";

const staffItems = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  { title: "Members", url: "/members", icon: Users },
  { title: "Attendance", url: "/attendance", icon: CalendarCheck },
  { title: "Classes", url: "/classes", icon: CalendarDays },
  { title: "Ranks", url: "/ranks", icon: Medal },
  { title: "Billing", url: "/billing", icon: CreditCard },
  { title: "Analytics", url: "/analytics", icon: BarChart3 },
  { title: "AI Insights", url: "/insights", icon: Sparkles },
  // "Marketing" now lives inside Communications as its Broadcasts tab.
];

const staffSecondary = [
  { title: "Migrate CRM", url: "/migrate", icon: Upload },
  // "Member Portal" was here too, duplicating the "View as member" button at
  // the foot of this sidebar, which opens the same page.
  { title: "Settings", url: "/settings", icon: Settings },
];

const memberItems = [
  { title: "My Portal", url: "/portal", icon: UserRound },
  { title: "My Membership", url: "/my-membership", icon: Building2 },
  { title: "Messages", url: "/messages", icon: MessageSquare },
  { title: "Attendance", url: "/attendance", icon: CalendarCheck },
  { title: "Classes", url: "/classes", icon: CalendarDays },
  { title: "My Billing", url: "/billing", icon: CreditCard },
  { title: "My Progress", url: "/insights", icon: BarChart3 },
];

const memberSecondary = [{ title: "My Profile", url: "/profile", icon: Settings }];

export function AppSidebar({ variant = "fixed" }: { variant?: "fixed" | "drawer" } = {}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { isStaff: authIsStaff, isManager: authIsManager, isDojoManager: authIsDojoManager, viewAs } = useAuth();
  const { activeDojoId, activeDojo } = useCurrentDojo();
  // Fallback to activeDojo.role in case useAuth's role query is stale (e.g. right
  // after onboarding inserts a new membership). Real role is authoritative.
  const dojoRole = activeDojo?.role;
  const realIsManager = authIsDojoManager || dojoRole === "owner" || dojoRole === "admin";
  const realIsStaff = authIsManager || dojoRole === "owner" || dojoRole === "admin" || dojoRole === "coach";
  const isManager = realIsManager;
  const isStaff = realIsStaff && !(realIsManager && viewAs === "member");
  const { data: cancellationCount = 0 } = useQuery({
    queryKey: ["cancellation-count", activeDojoId],
    enabled: isManager && !!activeDojoId,
    queryFn: async () => {
      const { count, error } = await supabase
        .from("members")
        .select("id", { count: "exact", head: true })
        .eq("dojo_id", activeDojoId!)
        .not("cancellation_requested_at", "is", null);
      if (error) throw error;
      return count ?? 0;
    },
  });

  const unreadFn = useServerFn(unreadConversationsCount);
  const { data: unreadCount = 0 } = useQuery({
    queryKey: ["comms-unread", activeDojoId],
    enabled: !!activeDojoId && (realIsStaff || !isStaff),
    queryFn: async () => {
      const res = await unreadFn({ data: { dojoId: activeDojoId! } });
      return res.unread;
    },
    refetchInterval: 30_000,
  });

  const staffCommsItem = {
    title: "Communications",
    url: "/communications",
    icon: MessageSquare,
    badge: unreadCount,
  };

  const items = isStaff
    ? isManager
      ? [
          ...staffItems,
          staffCommsItem,
          {
            title: "Cancellations",
            url: "/cancellations",
            icon: UserMinus,
            badge: cancellationCount,
          },
        ]
      : [...staffItems, staffCommsItem]
    : memberItems.map((item) =>
        item.url === "/messages" ? { ...item, badge: unreadCount } : item,
      );
  const secondary = isStaff ? staffSecondary : memberSecondary;
  const sectionLabel = isStaff ? "Operations" : "My Dojo";

  const isDrawer = variant === "drawer";
  return (
    <aside
      className={cn(
        "flex-col border-r border-sidebar-border bg-sidebar",
        isDrawer ? "flex h-full w-full" : "fixed inset-y-0 left-0 z-30 hidden w-64 md:flex",
      )}
    >
      <Link to="/" className="flex items-center gap-3 px-6 py-5">
        <DojoBrand
          name={activeDojo?.name}
          logoPath={activeDojo?.logoPath}
          markClassName="text-brand"
          wordmarkClassName="text-sidebar-foreground"
          taglineClassName="text-sidebar-foreground/60 opacity-100"
          showTagline={isStaff}
        />
      </Link>

      <nav className="flex-1 space-y-1 overflow-y-auto px-4">
        <div className="px-2 pt-4 pb-2 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
          {sectionLabel}
        </div>
        {items.map((item) => {
          const active = pathname === item.url;
          const Icon = item.icon;
          const badge = "badge" in item ? (item as { badge?: number }).badge : undefined;
          return (
            <Link
              key={item.url}
              to={item.url}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="flex-1">{item.title}</span>
              {badge !== undefined && badge > 0 && (
                <span className="grid min-w-5 place-items-center rounded-full bg-sidebar-primary px-1.5 py-0.5 text-[10px] font-semibold text-sidebar-primary-foreground">
                  {badge}
                </span>
              )}
              {active && <span className="ml-1 h-4 w-0.5 rounded bg-sidebar-primary" />}
            </Link>
          );
        })}

        <div className="px-2 pt-6 pb-2 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
          Other
        </div>
        {secondary.map((item) => {
          const active = pathname === item.url;
          const Icon = item.icon;
          return (
            <Link
              key={item.url}
              to={item.url}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              {item.title}
            </Link>
          );
        })}
      </nav>

      <UserFooter />
    </aside>
  );
}

function UserFooter() {
  const { user, loading, signOut, isDojoManager: authIsDojoManager, viewAs, setViewAs } = useAuth();
  const { memberships, activeDojo, setActiveDojoId } = useCurrentDojo();
  const router = useRouter();
  const role = loading ? "…" : (activeDojo?.role ?? "member");
  // Real manager status: trust either auth roles OR the freshly-fetched dojo role.
  const isDojoManager = authIsDojoManager || activeDojo?.role === "owner" || activeDojo?.role === "admin";
  const initial = (user?.email ?? "?").slice(0, 1).toUpperCase();
  return (
    <div className="space-y-2 p-4">
      {activeDojo && (
        <div className="rounded-md border border-sidebar-border bg-sidebar-accent/40 p-2">
          <div className="flex items-center gap-2 px-1 pb-1">
            <Building2 className="size-3 text-sidebar-foreground/60" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/60">
              Dojo
            </span>
          </div>
          {memberships.length > 1 ? (
            <div className="space-y-0.5">
              {memberships.map((m) => (
                <button
                  key={m.dojoId}
                  onClick={() => setActiveDojoId(m.dojoId)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs font-semibold transition-colors",
                    m.dojoId === activeDojo.dojoId
                      ? "bg-sidebar-accent text-sidebar-foreground"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60",
                  )}
                >
                  <DojoSwitcherLogo name={m.name} logoPath={m.logoPath} />
                  <span className="truncate">{m.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2 px-1">
              <DojoSwitcherLogo name={activeDojo.name} logoPath={activeDojo.logoPath} />
              <span className="truncate text-xs font-semibold text-sidebar-foreground">
                {activeDojo.name}
              </span>
            </div>
          )}
        </div>
      )}
      {isDojoManager && viewAs === "staff" && (
        <button
          onClick={() => {
            setViewAs("member");
            router.navigate({ to: "/portal" });
          }}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-sidebar-accent/70 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <Eye className="size-3.5" />
          View as member
        </button>
      )}
      {isDojoManager && viewAs === "member" && (
        <button
          onClick={() => {
            setViewAs("staff");
            router.navigate({ to: "/" });
          }}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-amber-400/60 bg-amber-500/20 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-amber-50 transition-colors hover:bg-amber-500/30"
        >
          <Eye className="size-3.5" />
          Back to admin view
        </button>
      )}
      <div className="flex items-center gap-3 rounded-lg bg-sidebar-accent/60 p-3 ring-1 ring-sidebar-border">
        <div className="grid size-8 place-items-center rounded-full bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground">
          {initial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-sidebar-foreground">
            {user?.email}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-sidebar-foreground/60">
            {role}
          </div>
        </div>
        <button
          onClick={signOut}
          className="rounded-md p-1.5 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          aria-label="Sign out"
        >
          <LogOut className="size-4" />
        </button>
      </div>
    </div>
  );
}

function DojoSwitcherLogo({ name, logoPath }: { name: string; logoPath: string | null }) {
  const url = useDojoLogoUrl(logoPath);
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    return <LogoMark className="size-5 shrink-0 text-brand" />;
  }
  return (
    <img
      src={url}
      alt={`${name} logo`}
      onError={() => setBroken(true)}
      className="size-5 shrink-0 rounded object-contain"
    />
  );
}
