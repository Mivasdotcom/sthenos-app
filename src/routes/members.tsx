import { createFileRoute, Outlet } from "@tanstack/react-router";
import { RouteErrorPanel } from "@/components/RouteErrorPanel";

/**
 * Layout for /members. The roster itself lives in members.index.tsx so that
 * /members/$memberId can mount as a child route.
 */
export const Route = createFileRoute("/members")({
  component: () => <Outlet />,
  errorComponent: ({ error, reset }) => (
    <RouteErrorPanel error={error} reset={reset} title="The members area didn't load" />
  ),
});
