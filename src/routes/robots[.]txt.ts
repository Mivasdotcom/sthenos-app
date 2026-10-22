import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

import { PUBLIC_SITE_URL } from "@/lib/site";

const BODY = `User-agent: *
Allow: /
Disallow: /portal
Disallow: /members
Disallow: /settings
Disallow: /workflows
Disallow: /migrate
Disallow: /analytics
Disallow: /marketing
Disallow: /attendance
Disallow: /ranks
Disallow: /insights
Disallow: /billing
Disallow: /classes
Disallow: /onboarding

Sitemap: ${PUBLIC_SITE_URL}/sitemap.xml
`;

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: async () =>
        new Response(BODY, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        }),
    },
  },
});
