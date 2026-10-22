import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { LogoMark } from "@/components/Logo";

// The Supabase JS client's `oauth` namespace is beta; type it locally rather than
// depend on the shape leaking through @supabase/supabase-js types.
type OAuthDetails = {
  client?: { name?: string | null } | null;
  redirect_url?: string | null;
  redirect_to?: string | null;
};
type OAuthResp = { data: OAuthDetails | null; error: { message: string } | null };
const oauth = (supabase.auth as unknown as {
  oauth: {
    getAuthorizationDetails(id: string): Promise<OAuthResp>;
    approveAuthorization(id: string): Promise<OAuthResp>;
    denyAuthorization(id: string): Promise<OAuthResp>;
  };
}).oauth;

export const Route = createFileRoute("/.lovable/oauth/consent")({
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    authorization_id: typeof s.authorization_id === "string" ? s.authorization_id : "",
  }),
  beforeLoad: async ({ search, location }) => {
    if (!search.authorization_id) throw new Error("Missing authorization_id");
    const { data } = await supabase.auth.getSession();
    const next = location.pathname + location.searchStr;
    if (!data.session) throw redirect({ to: "/login", search: { next } });
  },
  loader: async ({ location }) => {
    const authorizationId = new URLSearchParams(location.search).get("authorization_id")!;
    const { data, error } = await oauth.getAuthorizationDetails(authorizationId);
    if (error) throw error;
    const immediate = data?.redirect_url ?? data?.redirect_to;
    if (immediate && !data?.client) throw redirect({ href: immediate });
    return data;
  },
  component: Consent,
  errorComponent: ({ error }) => (
    <main className="grid min-h-screen place-items-center bg-background p-6">
      <div className="max-w-md text-center text-sm text-muted-foreground">
        Could not load this authorization request: {String((error as Error)?.message ?? error)}
      </div>
    </main>
  ),
});

function Consent() {
  const details = Route.useLoaderData();
  const { authorization_id } = Route.useSearch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    const { data, error } = approve
      ? await oauth.approveAuthorization(authorization_id)
      : await oauth.denyAuthorization(authorization_id);
    if (error) {
      setBusy(false);
      setError(error.message);
      return;
    }
    const target = data?.redirect_url ?? data?.redirect_to;
    if (!target) {
      setBusy(false);
      setError("No redirect returned by the authorization server.");
      return;
    }
    window.location.href = target;
  }

  const clientName = details?.client?.name ?? "an app";

  return (
    <main className="grid min-h-screen place-items-center bg-background p-6">
      <div className="w-full max-w-md space-y-6 rounded-lg border border-border bg-card p-6 shadow-sm">
        <div>
          <LogoMark className="mb-3 size-8 text-brand-strong" />
          <h1 className="font-display text-xl font-semibold tracking-tight">
            Connect {clientName} to Sthenos
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {clientName} will be able to use Sthenos tools on your behalf and see the same
            data you can — your dojos, members, classes, and attendance.
          </p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            disabled={busy}
            onClick={() => decide(false)}
            className="rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            Deny
          </button>
          <button
            disabled={busy}
            onClick={() => decide(true)}
            className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:bg-brand/90 disabled:opacity-50"
          >
            {busy ? "…" : "Approve"}
          </button>
        </div>
      </div>
    </main>
  );
}
