import { PUBLIC_SITE_URL } from "@/lib/site";
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings \u2014 Sthenos" },
      { name: "description", content: "Configure your dojo profile, team, public signup page, plans, and overheads." },
      { property: "og:title", content: "Settings \u2014 Sthenos" },
      { property: "og:description", content: "Configure your dojo profile, team, public signup page, plans, and overheads." },
      { property: "og:url", content: `${PUBLIC_SITE_URL}/settings` },
      { name: "twitter:title", content: "Settings \u2014 Sthenos" },
      { name: "twitter:description", content: "Configure your dojo profile, team, public signup page, plans, and overheads." },
    ],
    links: [
      { rel: "canonical", href: `${PUBLIC_SITE_URL}/settings` },
    ],
  }),
  component: () => <Outlet />,
});
