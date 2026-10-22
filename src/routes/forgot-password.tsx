import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { PUBLIC_SITE_URL } from "@/lib/site";
import { requestPasswordReset } from "@/lib/password-reset.functions";
import { LogoMark } from "@/components/Logo";
import { ArrowLeft, MailCheck } from "lucide-react";

export const Route = createFileRoute("/forgot-password")({
  component: ForgotPasswordPage,
  head: () => ({
    meta: [
      { title: "Reset your password \u2014 Sthenos" },
      { name: "description", content: "Request a password reset link for your Sthenos account." },
      { property: "og:title", content: "Reset your password \u2014 Sthenos" },
      { property: "og:description", content: "Request a password reset link for your Sthenos account." },
      { name: "twitter:title", content: "Reset your password \u2014 Sthenos" },
      { name: "twitter:description", content: "Request a password reset link for your Sthenos account." },
    ],
    links: [{ rel: "canonical", href: `${PUBLIC_SITE_URL}/forgot-password` }],
  }),
});

function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    try {
      await requestPasswordReset({
        data: { email: email.trim(), origin: window.location.origin },
      });
    } catch {
      // Deliberately silent: the confirmation must never depend on the outcome.
    } finally {
      setBusy(false);
      setSent(true);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-6 sm:p-12">
      <div className="w-full max-w-sm">
        <LogoMark className="mb-6 size-8 text-brand-strong" />

        {sent ? (
          <>
            <div className="mb-4 inline-flex size-10 items-center justify-center rounded-full bg-brand/10">
              <MailCheck className="size-5 text-brand-strong" />
            </div>
            <h1 className="font-display text-2xl font-semibold tracking-tight">Check your email</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              If an account exists for <span className="font-medium text-foreground">{email.trim()}</span>,
              we've sent a link to reset your password. It expires shortly, so use it soon.
            </p>
            <p className="mt-4 text-sm text-muted-foreground">
              Nothing arrived? Check your spam folder, or{" "}
              <button
                onClick={() => setSent(false)}
                className="font-medium text-foreground underline-offset-4 hover:underline"
              >
                try another address
              </button>
              .
            </p>
            <Link
              to="/login"
              className="mt-8 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" /> Back to sign in
            </Link>
          </>
        ) : (
          <>
            <Link
              to="/login"
              className="mb-6 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" /> Back to sign in
            </Link>
            <h1 className="font-display text-2xl font-semibold tracking-tight">Forgot your password?</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Enter your email and we'll send you a link to set a new one. Works for members, coaches
              and gym owners.
            </p>

            <form onSubmit={onSubmit} className="mt-6 space-y-3">
              <div>
                <label
                  htmlFor="reset-email"
                  className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground"
                >
                  Email
                </label>
                <input
                  id="reset-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-md bg-brand px-4 py-2.5 text-sm font-medium text-brand-foreground hover:bg-brand/90 disabled:opacity-50"
              >
                {busy ? "Sending…" : "Send reset link"}
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
