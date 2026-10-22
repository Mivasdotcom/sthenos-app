import { createFileRoute, redirect } from "@tanstack/react-router";

// The template library now lives inside the waiver editor on
// /settings/agreements as "Start from a template".
export const Route = createFileRoute("/settings/waiver-templates")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/agreements", replace: true });
  },
});
