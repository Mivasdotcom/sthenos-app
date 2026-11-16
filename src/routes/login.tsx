import { PUBLIC_SITE_URL } from "@/lib/site";
import { createFileRoute, Link, Navigate, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { getDojoBySlug } from "@/lib/signup.functions";
import { toast } from "sonner";
import { ArrowLeft, Building2, LogIn, Loader2, Users as UsersIcon } from "lucide-react";
import { Logo, LogoMark } from "@/components/Logo";

type Intent = "choose" | "signin" | "register" | "join";

export const Route = createFileRoute("/login")({
  component: LoginPage,
  validateSearch: (s: Record<string, unknown>): { next?: string; intent?: Intent } => ({
    next: typeof s.next === "string" && s.next.startsWith("/") && !s.next.startsWith("//") ? s.next : "",
    intent:
      s.intent === "signin" || s.intent === "register" || s.intent === "join"
        ? (s.intent as Intent)
        : ("choose" as Intent),
  }),
  head: () => ({
    meta: [
      { title: "Sign in \u2014 Sthenos" },
      { name: "description", content: "Sign in, register your gym, or join a gym as a member on Sthenos." },
      { property: "og:title", content: "Sign in \u2014 Sthenos" },
      { property: "og:description", content: "Sign in, register your gym, or join a gym as a member on Sthenos." },
      { property: "og:url", content: `${PUBLIC_SITE_URL}/login` },
      { name: "twitter:title", content: "Sign in \u2014 Sthenos" },
      { name: "twitter:description", content: "Sign in, register your gym, or join a gym as a member on Sthenos." },
    ],
    links: [
      { rel: "canonical", href: `${PUBLIC_SITE_URL}/login` },
    ],
  }),
});

function LoginPage() {
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  const { next, intent: initialIntent } = Route.useSearch();
  const returnTo = next || "/";
  const [intent, setIntent] = useState<Intent>(initialIntent ?? "choose");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  // Join-a-gym by code
  const [gymCode, setGymCode] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [codeError, setCodeError] = useState("");

  const onJoinSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const code = gymCode.trim().toLowerCase();
    if (!code) return;
    setCodeError("");
    setLookingUp(true);
    try {
      const { dojo } = await getDojoBySlug({ data: { slug: code } });
      if (!dojo || !dojo.public_page_enabled) {
        setCodeError("Gym not found — check the code or link with your gym.");
        return;
      }
      navigate({ to: "/j/$slug/signup", params: { slug: dojo.slug } });
    } catch {
      setCodeError("Gym not found — check the code or link with your gym.");
    } finally {
      setLookingUp(false);
    }
  };

  if (!loading && session) {
    if (returnTo !== "/") {
      window.location.replace(returnTo);
      return null;
    }
    return <Navigate to="/" />;
  }

  const afterAuth = (destination: string) => {
    if (destination !== "/") window.location.replace(destination);
    else navigate({ to: "/" });
  };

  const onEmailSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (intent === "register") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/onboarding`,
            data: { full_name: name },
          },
        });
        if (error) throw error;
        const { data: sess } = await supabase.auth.getSession();
        if (sess.session) {
          navigate({ to: "/onboarding" });
        } else {
          toast.success("Check your email to confirm your account.");
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        afterAuth(returnTo);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  };

  const onGoogle = async () => {
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin },
      });
      if (error) {
        toast.error(error.message || "Google sign-in failed");
        setBusy(false);
        return;
      }
      // The browser is now navigating to Google; Supabase restores the session from the URL on return.
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Google sign-in failed");
      setBusy(false);
    }
  };

  const googleButton = (
    <button
      onClick={onGoogle}
      disabled={busy}
      className="flex w-full items-center justify-center gap-2 rounded-md border border-input bg-background px-4 py-2.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
    >
      <svg className="size-4" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.26 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.83z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.83C6.71 7.31 9.14 5.38 12 5.38z"/></svg>
      {intent === "register" ? "Sign up with Google" : "Continue with Google"}
    </button>
  );

  const backButton = (
    <button
      onClick={() => setIntent("choose")}
      className="mb-6 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" /> Back
    </button>
  );

  return (
    <div className="grid min-h-screen md:grid-cols-2">
      {/* Ceremonial panel */}
      <div className="relative hidden overflow-hidden bg-charcoal md:block">
        <div className="absolute inset-0 bg-linear-to-br from-charcoal via-charcoal-raised to-charcoal" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_25%_15%,color-mix(in_oklab,var(--brand-strong)_28%,transparent),transparent_60%)]" />
        <div className="relative flex h-full flex-col justify-between p-12 text-primary-foreground">
          <div>
            <Logo
              markClassName="size-11 text-brand"
              wordmarkClassName="font-display text-2xl font-semibold tracking-tight text-brand-strong"
              taglineClassName="text-[10px] uppercase tracking-[0.2em] text-primary-foreground/50 opacity-100"
            />
          </div>
          <div>
            <p className="font-display text-4xl leading-tight tracking-tight">
              Insight.<br />Stability.<br />Growth.
            </p>
            <p className="mt-4 max-w-sm text-sm text-primary-foreground/60">
              Giving gyms the insights they've been missing — and removing volatility from
              membership, retention, and revenue once and for all.
            </p>
          </div>
          <div className="h-1 w-16 rounded-full bg-brand-strong" />
        </div>
      </div>


      {/* Form panel */}
      <main className="flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-sm">
          <LogoMark className="mb-6 size-8 text-brand-strong md:hidden" />
          {intent === "choose" && (
            <>
              <div className="mb-8">
                <h1 className="font-display text-2xl font-semibold tracking-tight">Welcome to Sthenos</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Choose how you'd like to continue.
                </p>
              </div>

              <div className="space-y-3">
                <button
                  onClick={() => setIntent("signin")}
                  className="flex w-full items-start gap-3 rounded-md border border-input bg-background p-4 text-left transition-colors hover:bg-accent"
                >
                  <LogIn className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                  <span>
                    <span className="block text-sm font-semibold">Sign in</span>
                    <span className="block text-xs text-muted-foreground">
                      Already have an account — gym owners, coaches and members.
                    </span>
                  </span>
                </button>

                <button
                  onClick={() => setIntent("register")}
                  className="flex w-full items-start gap-3 rounded-md border border-input bg-background p-4 text-left transition-colors hover:bg-accent"
                >
                  <Building2 className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                  <span>
                    <span className="block text-sm font-semibold">Register your gym</span>
                    <span className="block text-xs text-muted-foreground">
                      Set up your gym and stop revenue slipping out the back door.
                    </span>
                  </span>
                </button>

                <button
                  onClick={() => setIntent("join")}
                  className="flex w-full items-start gap-3 rounded-md border border-input bg-background p-4 text-left transition-colors hover:bg-accent"
                >
                  <UsersIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                  <span>
                    <span className="block text-sm font-semibold">Join a gym as a member</span>
                    <span className="block text-xs text-muted-foreground">
                      For athletes — sign up to train at a gym that uses Sthenos.
                    </span>
                  </span>
                </button>
              </div>
            </>
          )}

          {(intent === "signin" || intent === "register") && (
            <>
              {backButton}
              <div className="mb-8">
                <h1 className="font-display text-2xl font-semibold tracking-tight">
                  {intent === "signin" ? "Sign in" : "Register your gym"}
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {intent === "signin"
                    ? "Enter the dojo — owners, coaches and members."
                    : "Create your owner account, then set up your gym."}
                </p>
              </div>

              {googleButton}

              <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
                <div className="h-px flex-1 bg-border" />
                or
                <div className="h-px flex-1 bg-border" />
              </div>

              <form onSubmit={onEmailSubmit} className="space-y-3">
                {intent === "register" && (
                  <div>
                    <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">Your name</label>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      required
                    />
                  </div>
                )}
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    required
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    required
                    minLength={6}
                  />
                </div>
                <button
                  type="submit"
                  disabled={busy}
                  className="w-full rounded-md bg-brand px-4 py-2.5 text-sm font-medium text-brand-foreground hover:bg-brand/90 disabled:opacity-50"
                >
                  {busy ? "…" : intent === "signin" ? "Sign in" : "Create owner account"}
                </button>
              </form>

              {intent === "signin" && (
                <div className="mt-3 text-center">
                  <Link
                    to="/forgot-password"
                    className="text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  >
                    Forgot your password?
                  </Link>
                </div>
              )}

              <p className="mt-6 text-center text-sm text-muted-foreground">
                {intent === "signin" ? (
                  <>
                    Are you a member?{" "}
                    <button
                      onClick={() => setIntent("join")}
                      className="font-medium text-foreground underline-offset-4 hover:underline"
                    >
                      Join a gym
                    </button>
                  </>
                ) : (
                  <>
                    Already have an account?{" "}
                    <button
                      onClick={() => setIntent("signin")}
                      className="font-medium text-foreground underline-offset-4 hover:underline"
                    >
                      Sign in
                    </button>
                  </>
                )}
              </p>
            </>
          )}

          {intent === "join" && (
            <>
              {backButton}
              <div className="mb-6">
                <h1 className="font-display text-2xl font-semibold tracking-tight">Join a gym as a member</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Enter your gym's code or use the signup link they gave you.
                </p>
              </div>

              <form onSubmit={onJoinSubmit} className="space-y-3">
                <label className="block text-sm font-medium" htmlFor="gym-code">
                  Gym code
                </label>
                <input
                  id="gym-code"
                  value={gymCode}
                  onChange={(e) => {
                    setGymCode(e.target.value);
                    setCodeError("");
                  }}
                  placeholder="e.g. iron-wolves-bjj-xyz1"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
                />
                {codeError && <p className="text-sm text-destructive">{codeError}</p>}
                <button
                  type="submit"
                  disabled={lookingUp || !gymCode.trim()}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {lookingUp && <Loader2 className="size-4 animate-spin" />}
                  Continue
                </button>
                <p className="text-xs text-muted-foreground">
                  Your gym should have sent you a signup link — you can also use that directly.
                </p>
              </form>

              <p className="mt-6 text-center text-sm text-muted-foreground">
                Already a member?{" "}
                <button
                  onClick={() => setIntent("signin")}
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  Sign in
                </button>
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

