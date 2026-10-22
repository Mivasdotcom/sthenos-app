import { createFileRoute, redirect } from "@tanstack/react-router";

// Merged into /communications as its Broadcasts tab -- kept as a redirect so
// existing links and bookmarks keep working. The page itself now lives in
// src/components/BroadcastsPanel.tsx.
export const Route = createFileRoute("/marketing")({
  beforeLoad: () => {
    throw redirect({ to: "/communications", search: { tab: "broadcasts" }, replace: true });
  },
});
