import * as React from 'react'
import { render } from '@react-email/render'
import { createClient } from '@supabase/supabase-js'
import { createFileRoute } from '@tanstack/react-router'
import { SignupEmail } from '@/lib/email-templates/signup'
import { InviteEmail } from '@/lib/email-templates/invite'
import { MagicLinkEmail } from '@/lib/email-templates/magic-link'
import { RecoveryEmail } from '@/lib/email-templates/recovery'
import { EmailChangeEmail } from '@/lib/email-templates/email-change'
import { ReauthenticationEmail } from '@/lib/email-templates/reauthentication'
import {
  resolveAuthEmailBrand,
  senderDisplayName,
} from '@/lib/auth-email-brand.server'
import {
  HookError,
  verifyAndParseHook,
  type VerifiedAuthEmail,
} from '@/lib/auth-email-hook'
import { FROM_ADDRESS, SENDING_DOMAIN } from '@/lib/email-send.server'
import { PUBLIC_SITE_URL } from '@/lib/site'

function subjectFor(emailType: string, brand: string): string {
  switch (emailType) {
    case 'signup':
      return `Confirm your email for ${brand}`
    case 'invite':
      return `You've been invited to join ${brand}`
    case 'magiclink':
      return `Your ${brand} login link`
    case 'recovery':
      return `Reset your ${brand} password`
    case 'email_change':
      return `Confirm your new email for ${brand}`
    case 'reauthentication':
      return `Your ${brand} verification code`
    default:
      return `${brand} notification`
  }
}

// Template mapping
const EMAIL_TEMPLATES: Record<string, React.ComponentType<any>> = {
  signup: SignupEmail,
  invite: InviteEmail,
  magiclink: MagicLinkEmail,
  recovery: RecoveryEmail,
  email_change: EmailChangeEmail,
  reauthentication: ReauthenticationEmail,
}

function redactEmail(email: string | null | undefined): string {
  if (!email) return '***'
  const [localPart, domain] = email.split('@')
  if (!localPart || !domain) return '***'
  return `${localPart[0]}***@${domain}`
}

export const Route = createFileRoute("/api/public/hooks/auth-email")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text()
        const secret = process.env['SEND_EMAIL_HOOK_SECRET']
        const supabaseUrl = process.env['SUPABASE_URL']

        if (!secret || !supabaseUrl) {
          console.error('Auth email hook is missing SEND_EMAIL_HOOK_SECRET or SUPABASE_URL')
          return Response.json(
            { error: 'Server configuration error' },
            { status: 500 }
          )
        }

        // Verify the Standard Webhooks signature and timestamp, then map the payload.
        let verified: VerifiedAuthEmail
        try {
          verified = verifyAndParseHook(raw, request.headers, secret, supabaseUrl)
        } catch (error) {
          if (error instanceof HookError) {
            console.error('Auth email hook rejected request', {
              status: error.status,
              error: error.message,
            })
            return Response.json(
              { error: { http_code: error.status, message: error.message } },
              { status: error.status }
            )
          }
          throw error
        }

        const { webhookId: run_id, emailType, recipient } = verified
        console.log('Received auth event', {
          emailType,
          email_redacted: redactEmail(recipient),
          run_id,
        })

        const EmailTemplate = EMAIL_TEMPLATES[emailType]
        if (!EmailTemplate) {
          console.error('Unknown email type', { emailType, run_id })
          return Response.json(
            { error: `Unknown email type: ${emailType}` },
            { status: 400 }
          )
        }

        // Supabase (service role) — needed for branding lookup, logging and enqueue.
        const supabaseServiceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']

        if (!supabaseServiceKey) {
          console.error('Missing Supabase environment variables')
          return Response.json(
            { error: 'Server configuration error' },
            { status: 500 }
          )
        }

        const supabase = createClient(supabaseUrl, supabaseServiceKey)

        // The gym name when the member belongs to exactly one live gym,
        // otherwise the product name. Never the project slug. For an email
        // change, branding follows the member's current address.
        const brand = await resolveAuthEmailBrand(
          supabase,
          verified.templateProps.oldEmail ?? recipient
        )

        // Build template props from the verified hook payload
        const templateProps = {
          siteName: brand,
          siteUrl: PUBLIC_SITE_URL,
          recipient,
          confirmationUrl: verified.templateProps.confirmationUrl,
          token: verified.templateProps.token,
          email: recipient,
          oldEmail: verified.templateProps.oldEmail,
          newEmail: verified.templateProps.newEmail,
        }

        // Render React Email to HTML and plain text
        const element = React.createElement(EmailTemplate, templateProps)
        const html = await render(element)
        const text = await render(element, { plainText: true })

        const messageId = crypto.randomUUID()

        // Log pending BEFORE enqueue so we have a record even if enqueue crashes
        await supabase.from('email_send_log').insert({
          message_id: messageId,
          template_name: emailType,
          recipient_email: recipient,
          status: 'pending',
        })

        const { error: enqueueError } = await supabase.rpc('enqueue_email', {
          queue_name: 'auth_emails',
          payload: {
            run_id,
            message_id: messageId,
            to: recipient,
            from: `${senderDisplayName(brand)} <${FROM_ADDRESS}>`,
            sender_domain: SENDING_DOMAIN,
            subject: subjectFor(emailType, brand),
            html,
            text,
            purpose: 'transactional',
            label: emailType,
            queued_at: new Date().toISOString(),
          },
        })

        if (enqueueError) {
          console.error('Failed to enqueue auth email', { error: enqueueError, run_id, emailType })
          await supabase.from('email_send_log').insert({
            message_id: messageId,
            template_name: emailType,
            recipient_email: recipient,
            status: 'failed',
            error_message: 'Failed to enqueue email',
          })
          return Response.json(
            { error: 'Failed to enqueue email' },
            { status: 500 }
          )
        }

        console.log('Auth email enqueued', {
          emailType,
          email_redacted: redactEmail(recipient),
          run_id,
        })

        return Response.json({})
      },
    },
  },
})
