import * as React from "react";
import { render } from "@react-email/render";
import { createClient } from "@supabase/supabase-js";
import { createFileRoute } from "@tanstack/react-router";
import { SignupEmail } from "@/lib/email-templates/signup";
import { InviteEmail } from "@/lib/email-templates/invite";
import { MagicLinkEmail } from "@/lib/email-templates/magic-link";
import { RecoveryEmail } from "@/lib/email-templates/recovery";
import { EmailChangeEmail } from "@/lib/email-templates/email-change";
import { ReauthenticationEmail } from "@/lib/email-templates/reauthentication";
import { resolveAuthEmailBrand, senderDisplayName } from "@/lib/auth-email-brand.server";
import type { AuthEmailType } from "@/lib/auth-email-hook";
import {
  handleAuthEmailHook,
  type AuthEmailTemplateProps,
  type RenderedEmail,
} from "@/lib/auth-email-handler.server";
import { FROM_ADDRESS, SENDING_DOMAIN } from "@/lib/email-send.server";
import { PUBLIC_SITE_URL } from "@/lib/site";

// One builder per auth email type. Each passes only the props its template declares.
type TemplateBuilder = (props: AuthEmailTemplateProps) => React.ReactElement;

const EMAIL_TEMPLATES: Partial<Record<AuthEmailType, TemplateBuilder>> = {
  signup: (p) =>
    React.createElement(SignupEmail, {
      siteName: p.siteName,
      siteUrl: p.siteUrl,
      recipient: p.recipient,
      confirmationUrl: p.confirmationUrl,
    }),
  invite: (p) =>
    React.createElement(InviteEmail, {
      siteName: p.siteName,
      siteUrl: p.siteUrl,
      confirmationUrl: p.confirmationUrl,
    }),
  magiclink: (p) =>
    React.createElement(MagicLinkEmail, {
      siteName: p.siteName,
      confirmationUrl: p.confirmationUrl,
    }),
  recovery: (p) =>
    React.createElement(RecoveryEmail, {
      siteName: p.siteName,
      confirmationUrl: p.confirmationUrl,
    }),
  email_change: (p) =>
    React.createElement(EmailChangeEmail, {
      siteName: p.siteName,
      oldEmail: p.oldEmail ?? "",
      email: p.email,
      newEmail: p.newEmail ?? "",
      confirmationUrl: p.confirmationUrl,
    }),
  reauthentication: (p) =>
    React.createElement(ReauthenticationEmail, {
      siteName: p.siteName,
      token: p.token,
    }),
};

async function renderEmail(
  emailType: AuthEmailType,
  props: AuthEmailTemplateProps,
): Promise<RenderedEmail | null> {
  const build = EMAIL_TEMPLATES[emailType];
  if (!build) return null;
  const element = build(props);
  const html = await render(element);
  const text = await render(element, { plainText: true });
  return { html, text };
}

export const Route = createFileRoute("/api/public/hooks/auth-email")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        handleAuthEmailHook(request, {
          env: process.env,
          createSupabase: (url, serviceKey) => createClient(url, serviceKey),
          renderEmail,
          resolveBrand: resolveAuthEmailBrand,
          senderDisplayName,
          fromAddress: FROM_ADDRESS,
          sendingDomain: SENDING_DOMAIN,
          siteUrl: PUBLIC_SITE_URL,
          randomUUID: () => crypto.randomUUID(),
          now: () => Date.now(),
        }),
    },
  },
});
