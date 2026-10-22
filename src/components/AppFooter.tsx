import { Link } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";
import { useCurrentDojo } from "@/hooks/use-current-dojo";

export function AppFooter() {
  const { viewAs } = useAuth();
  const { activeDojo } = useCurrentDojo();
  const role = activeDojo?.role;
  const isStaffView =
    (role === "owner" || role === "admin" || role === "coach") && viewAs !== "member";
  return (
    <footer className="mt-10 border-t border-border px-4 py-6 text-xs text-muted-foreground md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>© {new Date().getFullYear()} {activeDojo?.name ?? "Sthenos"}</span>
        <nav className="flex flex-wrap items-center gap-4">
          <Link to="/privacy" className="hover:text-foreground hover:underline">
            Privacy notice
          </Link>
          {!isStaffView && <span className="opacity-60">Powered by Sthenos</span>}
        </nav>
      </div>
    </footer>
  );
}
