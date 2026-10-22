// Workflow type definitions — shared between client UI and server functions.

import type { AudienceFilter } from "./audience";

export type WorkflowTriggerType = "manual" | "scheduled" | "event";

export type WorkflowAction =
  | {
      type: "send_marketing_email";
      subject: string;
      body_html: string;
      from_name?: string;
    }
  | {
      type: "create_task";
      title: string;
      description?: string;
      due_in_days?: number;
    }
  | {
      type: "set_member_status";
      status: "active" | "trial" | "lapsed";
    }
  | {
      type: "tag_marketing_opt_out";
      value: boolean;
    };

export type Workflow = {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger_type: WorkflowTriggerType;
  trigger_config: Record<string, any>;
  filter: AudienceFilter;
  actions: WorkflowAction[];
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
};

export const ACTION_LABELS: Record<WorkflowAction["type"], string> = {
  send_marketing_email: "Send marketing email",
  create_task: "Create internal task",
  set_member_status: "Change member status",
  tag_marketing_opt_out: "Toggle marketing opt-out",
};

export const TRIGGER_LABELS: Record<WorkflowTriggerType, string> = {
  manual: "Manual — Run on demand",
  scheduled: "Scheduled — Recurring",
  event: "Event — When something happens",
};
