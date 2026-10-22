import { createFileRoute, redirect } from "@tanstack/react-router";

// The Workflows page is retired: it was never in the menu, and no gym ever
// created a workflow. Kept as a redirect so an old link lands somewhere useful.
//
// Only the PAGE is gone. src/lib/workflows.functions.ts and scheduler.server.ts
// stay, because they are shared with things that are very much in use -- the
// retention playbooks on member profiles and AI Insights, the nightly
// retention recompute, and `authorizeCron`, which guards the nightly billing
// job. Removing them would take billing and retention down with them.
export const Route = createFileRoute("/workflows")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
