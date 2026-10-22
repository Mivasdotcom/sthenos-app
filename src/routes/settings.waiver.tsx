import { createFileRoute, redirect } from "@tanstack/react-router";

// Consolidated into /settings/agreements — kept as a redirect so existing
// links and bookmarks keep working.
export const Route = createFileRoute("/settings/waiver")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/agreements", replace: true });
  },
});
