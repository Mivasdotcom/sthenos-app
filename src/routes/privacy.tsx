import { createFileRoute, Link } from "@tanstack/react-router";
import { PUBLIC_SITE_URL } from "@/lib/site";
import { LogoMark } from "@/components/Logo";
import { Info } from "lucide-react";

const TITLE = "Privacy notice for gym owners and staff — Sthenos";
const DESCRIPTION =
  "How Sthenos handles the account data of gym owners and staff who use the platform, and where gym members find their own gym's privacy notice.";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "og:url", content: `${PUBLIC_SITE_URL}/privacy` },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: TITLE },
      { name: "twitter:description", content: DESCRIPTION },
    ],
    links: [{ rel: "canonical", href: `${PUBLIC_SITE_URL}/privacy` }],
  }),
  component: PrivacyPage,
});

function Section({ id, heading, children }: { id: string; heading: string; children: React.ReactNode }) {
  return (
    <section id={id} className="space-y-3">
      <h2 className="font-display text-xl font-semibold tracking-tight">{heading}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-6 py-5">
          <LogoMark className="size-7 text-brand-strong" />
          <span className="font-display text-lg font-semibold tracking-tight">Sthenos</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-10 px-6 py-10">
        <div className="space-y-3">
          <h1 className="font-display text-3xl font-semibold tracking-tight">
            Privacy notice for gym owners and staff
          </h1>
          <p className="text-sm text-muted-foreground">
            This notice covers the accounts of the people who run a gym on Sthenos. For this account
            data, Sthenos is the data controller.
          </p>
        </div>

        <div className="flex items-start gap-3 rounded-xl bg-brand/5 p-4 ring-1 ring-brand/30">
          <Info className="mt-0.5 size-5 flex-none text-brand" />
          <div className="space-y-1 text-sm">
            <div className="font-semibold text-foreground">Are you a gym member?</div>
            <p className="text-muted-foreground">
              Your gym — not Sthenos — is responsible for your member information. Your gym publishes
              its own privacy notice, linked from its signup page and from your member portal. Ask
              your gym for it if you cannot find it.
            </p>
          </div>
        </div>

        <Section id="who" heading="Who this notice is for">
          <p>
            It applies to gym owners, admins and coaches who hold a Sthenos login, and to people who
            contact us about the product. Sthenos decides how this account data is handled, so we are
            the controller of it.
          </p>
          <p>
            It does not apply to gym members' records. Sthenos processes those on each gym's
            instructions, as that gym's processor, under the gym's own privacy notice.
          </p>
        </Section>

        <Section id="what" heading="What we hold about you">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>Your name and the email address you sign in with.</li>
            <li>Your role at the gym or gyms you belong to, and which gym you are viewing.</li>
            <li>Your gym's details — name, contact email, country, timezone and branding.</li>
            <li>
              Subscription and billing information for your use of Sthenos, and the payout account
              details you connect through Stripe.
            </li>
            <li>
              Records of significant actions taken in the app, such as changing another user's
              access, switching gym view, or deleting a member record.
            </li>
            <li>Support messages you send us, and the emails we send you about your account.</li>
            <li>Technical logs and error reports generated while you use the app.</li>
          </ul>
        </Section>

        <Section id="why" heading="Why we hold it">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>To give you access to your gym's account and keep it secure.</li>
            <li>To provide, support and improve the service, and to fix faults.</li>
            <li>To bill you for your subscription and pay out gym takings through Stripe.</li>
            <li>To send you service and account emails, such as security and billing notices.</li>
            <li>
              To keep audit records of sensitive actions, so a gym can see who changed what and when.
            </li>
            <li>To meet our own legal, accounting and tax obligations.</li>
          </ul>
        </Section>

        <Section id="processors" heading="Who processes it for us">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              <strong className="text-foreground">Supabase</strong> — database and authentication.
            </li>
            <li>
              <strong className="text-foreground">Lovable</strong> — application hosting.
            </li>
            <li>
              <strong className="text-foreground">Stripe</strong> — subscription billing and gym
              payouts. Card details go directly to Stripe and are never stored by Sthenos.
            </li>
            <li>
              <strong className="text-foreground">Resend</strong> — delivery of account and service
              email.
            </li>
            <li>
              <strong className="text-foreground">AI analysis</strong> — an AI service analyses
              anonymous, aggregated statistics about a gym as a whole. No member's personal data is
              sent to it.
            </li>
          </ul>
        </Section>

        <Section id="retention" heading="How long we keep it">
          <p>
            Account data is kept while your account is active. When you close it, we delete or
            anonymise your account data, keeping only what we need for billing, tax and audit
            records, and security logs. Audit records of sensitive actions are kept for as long as
            the gym's own records are, so they remain meaningful.
          </p>
        </Section>

        <Section id="rights" heading="Your rights">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              <strong className="text-foreground">Access</strong> — ask for a copy of the account
              data we hold about you.
            </li>
            <li>
              <strong className="text-foreground">Correction</strong> — ask us to fix anything
              inaccurate, or update it yourself in your profile.
            </li>
            <li>
              <strong className="text-foreground">Erasure</strong> — ask us to delete your account
              data, subject to records we must keep.
            </li>
            <li>
              <strong className="text-foreground">Portability</strong> — ask for your data in a
              machine-readable form.
            </li>
            <li>
              <strong className="text-foreground">Object or complain</strong> — object to how we use
              your data, or complain to your local data protection authority.
            </li>
          </ul>
        </Section>

        <Section id="contact" heading="How to contact us">
          <p>
            Email us about anything in this notice and we will respond. If your question concerns a
            gym member's records rather than your own account, we will pass it to the gym responsible
            for them.
          </p>
        </Section>

        <div className="border-t border-border pt-6 text-sm">
          <Link to="/" className="text-brand-strong hover:underline">
            Back to Sthenos
          </Link>
        </div>
      </main>
    </div>
  );
}
