import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { LogoMark } from "@/components/Logo";
import { PUBLIC_SITE_URL } from "@/lib/site";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import appCss from "../styles.css?url";
import { AppSidebar } from "@/components/AppSidebar";
import { MobileHeader } from "@/components/MobileHeader";
import { BottomNav } from "@/components/BottomNav";
import { SenseiWidget } from "@/components/SenseiWidget";
import { AppFooter } from "@/components/AppFooter";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { DojoProvider, useCurrentDojo } from "@/hooks/use-current-dojo";
import { supabase } from "@/integrations/supabase/client";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Sthenos — Martial Arts Gym Management" },
      { name: "description", content: "Revenue Engine for martial arts gyms: members, attendance, ranks, classes, and billing." },
      { property: "og:title", content: "Sthenos — Martial Arts Gym Management" },
      { property: "og:description", content: "Revenue Engine for martial arts gyms: members, attendance, ranks, classes, and billing." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: "Sthenos — Martial Arts Gym Management" },
      { name: "twitter:description", content: "Revenue Engine for martial arts gyms: members, attendance, ranks, classes, and billing." },
      { property: "og:image", content: `${PUBLIC_SITE_URL}/og-image.png` },
      { name: "twitter:image", content: `${PUBLIC_SITE_URL}/og-image.png` },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "icon", type: "image/x-icon", href: "/favicon.ico", sizes: "32x32" },
      { rel: "icon", type: "image/png", href: "/icon-192.png", sizes: "192x192" },
      { rel: "icon", type: "image/png", href: "/icon-512.png", sizes: "512x512" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png", sizes: "180x180" },
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Archivo+Black&family=Hind:wght@300;400;500;600;700&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <DojoProvider>
          <AppFrame />
          <Toaster position="bottom-right" />
        </DojoProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

function AppFrame() {
  const { session, loading, isStaff, isDojoManager: authIsDojoManager, viewAs, setViewAs } = useAuth();
  const {
    needsOnboarding,
    loading: dojoLoading,
    activeDojo,
    memberships,
    staffMemberships,
    isMemberOnly,
    error: dojoError,
    refresh: refreshDojos,
  } = useCurrentDojo();
  const isDojoManager = authIsDojoManager || activeDojo?.role === "owner" || activeDojo?.role === "admin";

  const router = useRouter();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isPublic =
    pathname === "/login" ||
    pathname === "/privacy" ||
    pathname === "/forgot-password" ||
    pathname === "/reset-password" ||
    // Opting out must never require an account. Recipients click this link
    // straight from an email while signed out, and bouncing them to /login
    // made every unsubscribe link a dead end (and a compliance problem).
    pathname === "/unsubscribe" ||
    pathname.startsWith("/j/");

  const isOnboardingRoute = pathname === "/onboarding";
  const staffOnlyPrefixes = ["/members", "/marketing", "/workflows", "/migrate", "/analytics", "/ranks", "/reports", "/cancellations", "/settings"];
  const isStaffOnlyRoute =
    pathname === "/" || staffOnlyPrefixes.some((p) => pathname === p || pathname.startsWith(p + "/"));

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => {
      router.invalidate();
      queryClient.invalidateQueries();
    });
    return () => subscription.unsubscribe();
  }, [router, queryClient]);

  useEffect(() => {
    if (!loading && !session && !isPublic) {
      router.navigate({ to: "/login", search: { next: pathname } });
    }
  }, [loading, session, isPublic, router, pathname]);

  useEffect(() => {
    // Wait for BOTH auth roles and dojo memberships before deciding to bounce
    // a user off a staff-only route. Otherwise a fresh owner (auth roles not
    // yet refetched) gets kicked to /portal right after onboarding.
    if (loading || dojoLoading || dojoError) return;
    // A user whose only membership role is 'member' is NEVER staff, whatever
    // stale auth-role state says.
    const effectiveIsStaff = isMemberOnly ? false : isStaff || isDojoManager;

    if (session && !isPublic && !effectiveIsStaff && isStaffOnlyRoute) {
      router.navigate({ to: "/portal" });
    }
  }, [loading, dojoLoading, session, isPublic, isStaff, isDojoManager, isMemberOnly, isStaffOnlyRoute, router]);

  // Redirect to /onboarding when the user is authenticated but has no dojo
  useEffect(() => {
    if (!loading && session && !dojoLoading && needsOnboarding && !isOnboardingRoute && !isPublic) {
      router.navigate({ to: "/onboarding" });
    }
  }, [loading, dojoLoading, session, needsOnboarding, isOnboardingRoute, isPublic, router]);

  // Gym-owner onboarding is for people creating a gym. Anyone who already
  // belongs to a gym as a member gets their portal instead.
  useEffect(() => {
    if (loading || dojoLoading || dojoError || !session) return;
    if (isOnboardingRoute && isMemberOnly) {
      router.navigate({ to: "/portal" });
    }
  }, [loading, dojoLoading, dojoError, session, isOnboardingRoute, isMemberOnly, router]);

  // Initial-login landing redirect, driven by the already-loaded memberships:
  // - owner/admin/coach in ANY dojo -> "/" (manager dashboard)
  // - member only                   -> "/portal"
  // - no membership at all          -> "/onboarding" (handled above)
  // Runs once per session, and only when the user lands on "/" or "/login" so
  // manual navigation elsewhere isn't overridden.
  const initialRedirectFor = useRef<string | null>(null);
  useEffect(() => {
    if (loading || dojoLoading || dojoError || !session) return;
    if (isPublic && pathname !== "/login") return;
    if (pathname !== "/" && pathname !== "/login") return;
    if (memberships.length === 0) return; // onboarding effect owns this case
    if (initialRedirectFor.current === session.user.id) return;
    initialRedirectFor.current = session.user.id;
    router.navigate({ to: staffMemberships.length > 0 ? "/" : "/portal" });
  }, [
    loading,
    dojoLoading,
    dojoError,
    session,
    pathname,
    isPublic,
    memberships.length,
    staffMemberships.length,
    router,
  ]);



  if (isPublic) {
    return (
      <div className="min-h-screen bg-background">
        <Outlet />
      </div>
    );
  }

  if (loading || !session) {
    return (
      <div className="grid min-h-screen place-items-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <LogoMark className="size-10 animate-pulse text-brand-strong" />
          <div className="text-sm text-muted-foreground">Loading…</div>
        </div>
      </div>
    );
  }

  if (dojoError) {
    return (
      <div className="grid min-h-screen place-items-center bg-background px-4">
        <div className="max-w-md rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
          <h1 className="text-lg font-semibold text-foreground">We couldn't load your gyms</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your account and gyms are safe — this is a temporary problem loading them. Please try
            again.
          </p>
          <pre className="mt-3 max-h-32 overflow-auto rounded-lg bg-background/80 p-3 text-left text-xs text-destructive">
            {dojoError}
          </pre>
          <button
            onClick={() => void refreshDojos()}
            className="mt-4 inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }


  const showViewAsBanner = isDojoManager && viewAs === "member";

  return (
    <div className="min-h-screen bg-background">
      <AppSidebar />
      <div className="md:pl-64">
        <MobileHeader />
        {showViewAsBanner && (
          <div className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/15 px-4 py-2 text-xs">
            <span className="font-medium text-amber-100">
              You're viewing as a member
            </span>
            <button
              onClick={() => {
                setViewAs("staff");
                router.navigate({ to: "/" });
              }}
              className="rounded-md border border-amber-400/60 bg-amber-500/20 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-amber-50 hover:bg-amber-500/30"
            >
              Back to manager view
            </button>
          </div>
        )}
        <div className="pb-16 md:pb-0">
          <Outlet />
          <AppFooter />
        </div>
      </div>
      <BottomNav />
      <SenseiWidget />
    </div>
  );
}
