import { createFileRoute, redirect } from "@tanstack/react-router";

// Overheads and other income moved to Billing, where the rest of the money
// lives. Settings is for configuring the app; recording rent or a seminar's
// takings is bookkeeping, and nobody went looking for it here -- across every
// gym on the platform, not one overhead and not one manual payment was ever
// entered.
//
// Kept as a redirect so old links and bookmarks land somewhere useful. The
// panels themselves are now src/components/CostsAndIncomePanel.tsx.
export const Route = createFileRoute("/settings/overheads")({
  beforeLoad: () => {
    throw redirect({ to: "/billing", replace: true });
  },
});
