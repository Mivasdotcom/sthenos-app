import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PUBLIC_SITE_URL } from "@/lib/site";
import { LogoMark } from "@/components/Logo";
import { CheckCircle2, Loader2 } from "lucide-react";

export const Route = createFileRoute("/reset-password")({
  ssr: false,
  component: ResetPasswordPage,
  head: () => ({
    meta: [
      { title: "Set a new password \u2014 Sthenos" },
      { name: "description", content: "Choose a new password for your Sthenos account." },
      { property: "og:title", content: "Set a new password \u2014 Sthenos" },
      { property: "og:description", content: "Choose a new password for your Sthenos account." },
      { name: "twitter:title", content: "Set a new password \u2014 Sthenos" },
      { name: "twitter:description", content: "Choose a new password for your Sthenos account." },
    ],
    links: [{ rel: "canonical", href: `${PUBLIC_SITE_URL}/reset-password` }],
  }),
});

type Stage = "verifying" | "ready" | "invalid" | "done";

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [stage, setStage] = useState<Stage>("verifying");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // The recovery link may arrive as a PKCE ?code=, a ?token_hash=, or as an
  // implicit #access_token= fragment the client picks up on its own. Handle all
  // three, then confirm we really do have a session before offering the form.
  useEffect(() => {
    (async () => {
      const url = new URL(window.location.href);
      const code = url.searchParams.get("code");
      const tokenHash = url.searchParams.get("token_hash");

      try {
        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) throw error;
        } else if (tokenHash) {
          const { error } = await supabase.auth.verifyOtp({
            type: "recovery",
            token_hash: tokenHash,
          });
          if (error) throw error;
        }
      } catch {
        setStage("invalid");
        return;
      }

      const { data } = await supabase.auth.getSession();
      setStage(data.session ? "ready" : "invalid");
    })();
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Those passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setStage("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update your password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-6 sm:p-12">
      <div className="w-full max-w-sm">
        <LogoMark className="mb-6 size-8 text-brand-strong" />

        {stage === "verifying" && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Checking your reset link…
          </div>
        )}

        {stage === "invalid" && (
          <>
            <h1 className="font-display text-2xl font-semibold tracking-tight">
              This link is no longer valid
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Reset links expire and can only be used once. Request a fresh one and we'll send it
              straight over.
            </p>
            <Link
              to="/forgot-password"
              className="mt-6 inline-flex w-full items-center justify-center rounded-md bg-brand px-4 py-2.5 text-sm font-medium text-brand-foreground hover:bg-brand/90"
            >
              Request a new link
            </Link>
          </>
        )}

        {stage === "ready" && (
          <>
            <h1 className="font-display text-2xl font-semibold tracking-tight">Set a new password</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose something you'll remember — at least 8 characters.
            </p>
            <form onSubmit={onSubmit} className="mt-6 space-y-3">
              <div>
                <label
                  htmlFor="new-password"
                  className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground"
                >
                  New password
                </label>
                <input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  required
                  minLength={8}
                />
              </div>
              <div>
                <label
                  htmlFor="confirm-password"
                  className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground"
                >
                  Confirm password
                </label>
                <input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  required
                  minLength={8}
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-md bg-brand px-4 py-2.5 text-sm font-medium text-brand-foreground hover:bg-brand/90 disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save new password"}
              </button>
            </form>
          </>
        )}

        {stage === "done" && (
          <>
            <div className="mb-4 inline-flex size-10 items-center justify-center rounded-full bg-brand/10">
              <CheckCircle2 className="size-5 text-brand-strong" />
            </div>
            <h1 className="font-display text-2xl font-semibold tracking-tight">Password updated</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              You're signed in with your new password. Members land in their portal, staff in the
              gym dashboard.
            </p>
            <button
              onClick={() => navigate({ to: "/" })}
              className="mt-6 w-full rounded-md bg-brand px-4 py-2.5 text-sm font-medium text-brand-foreground hover:bg-brand/90"
            >
              Continue
            </button>
            <button
              onClick={async () => {
                await supabase.auth.signOut();
                navigate({ to: "/login", search: { intent: "signin" } });
              }}
              className="mt-3 w-full rounded-md border border-input bg-background px-4 py-2.5 text-sm font-medium hover:bg-accent"
            >
              Sign in again instead
            </button>
          </>
        )}
      </div>
    </main>
  );
}
