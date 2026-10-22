import type { AudienceFilter } from "./audience";
import type { WorkflowAction, WorkflowTriggerType } from "./workflows-shared";

export type WorkflowTemplate = {
  id: string;
  name: string;
  description: string;
  trigger_type: WorkflowTriggerType;
  trigger_config: Record<string, any>;
  filter: AudienceFilter;
  actions: WorkflowAction[];
};

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "high-risk-encouragement",
    name: "High-risk encouragement",
    description:
      "Every Monday morning, email at-risk members an encouraging note and a reminder of upcoming classes.",
    trigger_type: "scheduled",
    trigger_config: { cron: "weekly_monday_9am" },
    filter: { risk_tier: ["high"], status: ["active", "trial"], exclude_marketing_opt_out: true },
    actions: [
      {
        type: "send_marketing_email",
        subject: "We miss seeing you on the mat 🥋",
        body_html:
          "<p>Hey {{name}},</p><p>It's been a minute — we've got a few classes coming up this week that would be a great way to get back into rhythm. Your spot is always here.</p><p>— Coach</p>",
      },
    ],
  },
  {
    id: "ready-for-promotion",
    name: "Ready for promotion → task for instructor",
    description:
      "Daily check: members whose numbers say they're ready for the next belt → creates a follow-up task for the head instructor to evaluate on the mat.",
    trigger_type: "scheduled",
    trigger_config: { cron: "daily_8am" },
    filter: { readiness_status: ["ready"], status: ["active"] },
    actions: [
      {
        type: "create_task",
        title: "Evaluate {{name}} for next belt",
        description:
          "Numbers indicate {{name}} is ready ({{readiness_score}}/100). Verify on the mat at next class.",
        due_in_days: 7,
      },
    ],
  },
  {
    id: "welcome-new-member",
    name: "Welcome new member",
    description:
      "Within 24h of a new member being added, send them a warm welcome email with what to expect at their first class.",
    trigger_type: "event",
    trigger_config: { event: "member_created" },
    filter: { joined_within_days: 1, exclude_marketing_opt_out: true },
    actions: [
      {
        type: "send_marketing_email",
        subject: "Welcome to the dojo, {{name}} 🥋",
        body_html:
          "<p>Hey {{name}},</p><p>Welcome to the family. Wear loose, comfortable clothes for your first class, arrive 10 minutes early, and don't worry — every black belt was a white belt once.</p><p>See you on the mat.</p>",
      },
    ],
  },
  {
    id: "overdue-invoice-nudge",
    name: "Overdue invoice nudge",
    description:
      "Daily: members with overdue invoices get a friendly payment reminder. Stops escalating to coach when they pay.",
    trigger_type: "scheduled",
    trigger_config: { cron: "daily_9am" },
    filter: { has_overdue_invoice: true, exclude_marketing_opt_out: true },
    actions: [
      {
        type: "send_marketing_email",
        subject: "Quick reminder about your membership",
        body_html:
          "<p>Hey {{name}},</p><p>Just a heads up — your last invoice is past due. Tap below to settle up so you don't miss any classes.</p><p>Need help? Reply to this email anytime.</p>",
      },
    ],
  },
  {
    id: "lapsed-winback",
    name: "Lapsed-member winback",
    description:
      "Weekly: members who haven't checked in for 30+ days get a 'come back' note from the head coach.",
    trigger_type: "scheduled",
    trigger_config: { cron: "weekly_thursday_10am" },
    filter: { last_seen_min_days: 30, status: ["active"], exclude_marketing_opt_out: true },
    actions: [
      {
        type: "send_marketing_email",
        subject: "Your spot is still here",
        body_html:
          "<p>{{name}},</p><p>Life happens. Whenever you're ready to roll again, the mat is here. Reply with a class time that works for you and I'll meet you there.</p><p>— Coach</p>",
      },
    ],
  },
];

/**
 * RETENTION PLAYBOOKS — one-click automations that target the persisted
 * retention scores written by recomputeRetentionScores(). `cooldown_days`
 * controls the anti-spam guard: a member is skipped if this playbook already
 * actioned them within that window.
 */
export type RetentionPlaybook = WorkflowTemplate & { cooldown_days: number };

export const RETENTION_PLAYBOOKS: RetentionPlaybook[] = [
  {
    id: "at-risk-outreach",
    name: "At-risk outreach",
    description:
      "Daily: every member scored high retention risk gets a personal check-in task for a coach, with the exact risk factors attached.",
    trigger_type: "scheduled",
    trigger_config: { cron: "daily_8am" },
    cooldown_days: 14,
    filter: { retention_risk_level: ["high"], status: ["active", "trial"] },
    actions: [
      {
        type: "create_task",
        title: "Check in with {{name}} — {{retention_risk_factors}}",
        description:
          "Retention risk {{retention_risk_score}}/100. Factors: {{retention_risk_factors}}. Call or message them before their next class.",
        due_in_days: 2,
      },
    ],
  },
  {
    id: "we-missed-you",
    name: "We missed you",
    description:
      "Daily: active members who haven't trained in over two weeks get a warm win-back email from the coach.",
    trigger_type: "scheduled",
    trigger_config: { cron: "daily_9am" },
    cooldown_days: 21,
    filter: {
      days_since_last_seen_gt: 14,
      status: ["active"],
      exclude_marketing_opt_out: true,
    },
    actions: [
      {
        type: "send_marketing_email",
        subject: "We missed you on the mat, {{name}}",
        body_html:
          "<p>Hey {{name}},</p><p>It's been a couple of weeks since we saw you in {{discipline}} — everything alright? Progress isn't linear, and the fastest way back is simply showing up to the next session.</p><p>Reply with a class time that suits you and I'll make sure we're there to welcome you back.</p><p>— Coach</p>",
      },
    ],
  },
  {
    id: "no-show-follow-up",
    name: "No-show follow-up",
    description:
      "Daily: members who booked classes but missed two or more in the last 30 days get a follow-up task so nobody quietly drifts away.",
    trigger_type: "scheduled",
    trigger_config: { cron: "daily_9am" },
    cooldown_days: 14,
    filter: { no_shows_last_30d_gte: 2, status: ["active", "trial"] },
    actions: [
      {
        type: "create_task",
        title: "Reach out to {{name}} — booked but didn't attend",
        description:
          "{{name}} has missed 2+ booked classes in the last 30 days. Find out what's getting in the way and re-book them.",
        due_in_days: 3,
      },
    ],
  },
  {
    id: "belt-plateau",
    name: "Blue belt plateau",
    description:
      "Weekly: members flagged watch/high risk whose risk factors show a long stretch at the same belt — the classic plateau dropout. Prompts a grading conversation.",
    trigger_type: "scheduled",
    trigger_config: { cron: "weekly_monday_9am" },
    cooldown_days: 30,
    filter: {
      retention_risk_level: ["watch", "high"],
      has_belt_plateau_factor: true,
      status: ["active"],
    },
    actions: [
      {
        type: "create_task",
        title: "Grading conversation with {{name}}",
        description:
          "{{name}} has been at {{belt}} for a long stretch and risk is trending up ({{retention_risk_score}}/100). Talk through their path to the next grade.",
        due_in_days: 7,
      },
    ],
  },
  {
    id: "payment-failed-recovery",
    name: "Payment failed recovery",
    description:
      "Daily: members whose payment status is overdue get a friendly recovery email plus a task for staff to follow up if it stays unpaid.",
    trigger_type: "scheduled",
    trigger_config: { cron: "daily_9am" },
    cooldown_days: 7,
    filter: { payment_status: ["overdue"], exclude_marketing_opt_out: true },
    actions: [
      {
        type: "send_marketing_email",
        subject: "Quick fix needed for your membership",
        body_html:
          "<p>Hey {{name}},</p><p>Your last membership payment didn't go through — it's usually just an expired card. You can update your payment details from your member portal in under a minute, and nothing changes about your classes.</p><p>Any trouble at all, reply to this email.</p>",
      },
      {
        type: "create_task",
        title: "Payment recovery — {{name}}",
        description: "Payment overdue. Recovery email sent; follow up if it isn't resolved.",
        due_in_days: 4,
      },
    ],
  },
];
