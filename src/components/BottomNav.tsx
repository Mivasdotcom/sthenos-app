import { Link, useRouterState } from "@tanstack/react-router";
import { LayoutDashboard, Users, Calendar, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

const items = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  { title: "Members", url: "/members", icon: Users },
  { title: "Classes", url: "/classes", icon: Calendar },
  { title: "Settings", url: "/settings", icon: Settings },
];

export function BottomNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 flex border-t bg-background md:hidden">
      {items.map((item) => {
        const active = pathname === item.url;
        const Icon = item.icon;
        return (
          <Link
            key={item.url}
            to={item.url}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[10px] font-medium transition-colors",
              active ? "text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-5" />
            <span>{item.title}</span>
          </Link>
        );
      })}
    </nav>
  );
}
