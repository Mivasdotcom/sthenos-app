import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { evaluateAudienceInternal } from "./audience.functions";
import { assertDojoStaff } from "./dojo-access";
import type { AudienceFilter } from "./audience";
import type { Workflow, WorkflowAction, WorkflowTriggerType } from "./workflows-shared";

// ───────────── CRUD ─────────────

export const listWorkflows = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId);
    const { data: rows, error } = await supabase
      .from("workflows")
      .select("*")
      .eq("dojo_id", data.dojoId)
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return { workflows: (rows ?? []) as Workflow[] };
  });

export const getWorkflow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId);
    const [wf, runs] = await Promise.all([
      supabase.from("workflows").select("*").eq("id", data.id).eq("dojo_id", data.dojoId).maybeSingle(),
      supabase
        .from("workflow_runs")
        .select("*")
        .eq("workflow_id", data.id)
        .eq("dojo_id", data.dojoId)
        .order("started_at", { ascending: false })
        .limit(25),
    ]);
    if (wf.error) throw wf.error;
    if (runs.error) throw runs.error;
    return { workflow: wf.data as Workflow | null, runs: runs.data ?? [] };
  });

export const saveWorkflow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      id?: string;
      dojoId: string;
      name: string;
      description?: string;
      enabled: boolean;
      trigger_type: WorkflowTriggerType;
      trigger_config: Record<string, any>;
      filter: AudienceFilter;
      actions: WorkflowAction[];
      action_cooldown_days?: number;
    }) => d,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId);
    if (data.id) {
      const { error } = await supabase
        .from("workflows")
        .update({
          name: data.name,
          description: data.description ?? null,
          enabled: data.enabled,
          trigger_type: data.trigger_type,
          trigger_config: data.trigger_config,
          filter: data.filter,
          actions: data.actions,
          ...(data.action_cooldown_days != null
            ? { action_cooldown_days: data.action_cooldown_days }
            : {}),
        })
        .eq("id", data.id)
        .eq("dojo_id", data.dojoId);
      if (error) throw error;
      return { id: data.id };
    }
    const { data: row, error } = await supabase
      .from("workflows")
      .insert({
        dojo_id: data.dojoId,
        name: data.name,
        description: data.description ?? null,
        enabled: data.enabled,
        trigger_type: data.trigger_type,
        trigger_config: data.trigger_config,
        filter: data.filter,
        actions: data.actions,
        ...(data.action_cooldown_days != null
          ? { action_cooldown_days: data.action_cooldown_days }
          : {}),
        created_by: userId,
      })
      .select("id")
      .single();
    if (error) throw error;
    return { id: row.id };
  });

export const deleteWorkflow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId);
    const { error } = await supabase
      .from("workflows")
      .delete()
      .eq("id", data.id)
      .eq("dojo_id", data.dojoId);
    if (error) throw error;
    return { ok: true };
  });

export const setWorkflowEnabled = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; enabled: boolean; dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId);
    const { error } = await supabase
      .from("workflows")
      .update({ enabled: data.enabled })
      .eq("id", data.id)
      .eq("dojo_id", data.dojoId);
    if (error) throw error;
    return { ok: true };
  });

// ───────────── Execution ─────────────

function renderTemplate(tpl: string, m: any): string {
  return tpl
    .replace(/\{\{\s*name\s*\}\}/g, m.name ?? "there")
    .replace(/\{\{\s*discipline\s*\}\}/g, m.discipline ?? "")
    .replace(/\{\{\s*belt\s*\}\}/g, m.belt_label ?? "")
    .replace(/\{\{\s*readiness_score\s*\}\}/g, String(m.readinessScore ?? ""))
    .replace(/\{\{\s*risk_score\s*\}\}/g, String(m.riskScore ?? ""))
    .replace(/\{\{\s*retention_risk_score\s*\}\}/g, String(m.retentionRiskScore ?? ""))
    .replace(
      /\{\{\s*retention_risk_factors\s*\}\}/g,
      (m.retentionRiskFactors ?? []).join("; ") || "no specific factors",
    )
    .replace(/\{\{\s*retention_risk_level\s*\}\}/g, String(m.retentionRiskLevel ?? ""));
}

export type WorkflowRunDetail = {
  member_id: string;
  name: string;
  action: string;
  ok: boolean;
  note?: string;
  skipped?: boolean;
};

export type WorkflowRunSummary = {
  run_id: string;
  matched: number;
  actioned: number;
  skipped: number;
  succeeded: number;
  failed: number;
  status: string;
};

/**
 * Execute one workflow. Shared by manual runs (`runWorkflowNow`) and the
 * scheduled runner, so both honour the anti-spam cooldown identically.
 */
export async function runWorkflowInternal(args: {
  client: any;
  workflow: any;
  dojoId: string;
  triggerSource: string;
  actorUserId: string | null;
}): Promise<WorkflowRunSummary> {
  const { client, workflow: wf, dojoId, triggerSource, actorUserId } = args;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { sendAppEmail, resolveSenderIdentity } = await import("./email-send.server");
  const sender = await resolveSenderIdentity(client, dojoId);

  const { data: runRow, error: runErr } = await client
    .from("workflow_runs")
    .insert({
      workflow_id: wf.id,
      dojo_id: dojoId,
      status: "running",
      trigger_source: triggerSource,
    })
    .select("id")
    .single();
  if (runErr) throw runErr;

  const matched = await evaluateAudienceInternal(client, wf.filter as AudienceFilter, dojoId);

  // ── Anti-spam guard: skip members this workflow already actioned inside the
  // cooldown window (default 14 days, configurable per workflow).
  const cooldownDays = Number(wf.action_cooldown_days ?? 14);
  const skippedIds = new Set<string>();
  if (cooldownDays > 0 && matched.length) {
    const since = new Date(Date.now() - cooldownDays * 86400000).toISOString();
    const { data: recent } = await client
      .from("workflow_member_actions")
      .select("member_id")
      .eq("workflow_id", wf.id)
      .eq("dojo_id", dojoId)
      .gte("actioned_at", since);
    for (const r of recent ?? []) skippedIds.add(r.member_id);
  }

  const targets = matched.filter((m) => !skippedIds.has(m.id));
  let succeeded = 0;
  let failed = 0;
  const details: WorkflowRunDetail[] = [];

  for (const m of matched.filter((x) => skippedIds.has(x.id))) {
    details.push({
      member_id: m.id,
      name: m.name,
      action: "skipped",
      ok: true,
      skipped: true,
      note: `already actioned within ${cooldownDays}d cooldown`,
    });
  }

  for (const m of targets) {
    let actionedAny = false;
    for (const action of (wf.actions as WorkflowAction[]) ?? []) {
      try {
        if (action.type === "create_task") {
          const due = action.due_in_days
            ? new Date(Date.now() + action.due_in_days * 86400000).toISOString().slice(0, 10)
            : null;
          const { error } = await client.from("internal_tasks").insert({
            dojo_id: dojoId,
            member_id: m.id,
            title: renderTemplate(action.title, m),
            description: action.description ? renderTemplate(action.description, m) : null,
            due_date: due,
            source_workflow_id: wf.id,
            created_by: actorUserId ?? wf.created_by ?? null,
          });
          if (error) throw error;
          details.push({ member_id: m.id, name: m.name, action: "create_task", ok: true });
          succeeded++;
          actionedAny = true;
        } else if (action.type === "set_member_status") {
          const { error } = await client
            .from("members")
            .update({ status: action.status })
            .eq("id", m.id)
            .eq("dojo_id", dojoId);
          if (error) throw error;
          details.push({ member_id: m.id, name: m.name, action: "set_member_status", ok: true });
          succeeded++;
          actionedAny = true;
        } else if (action.type === "tag_marketing_opt_out") {
          const { error } = await client
            .from("members")
            .update({ marketing_opt_out: action.value })
            .eq("id", m.id)
            .eq("dojo_id", dojoId);
          if (error) throw error;
          details.push({ member_id: m.id, name: m.name, action: "tag_marketing_opt_out", ok: true });
          succeeded++;
          actionedAny = true;
        } else if (action.type === "send_marketing_email") {
          if (!m.email) {
            details.push({ member_id: m.id, name: m.name, action: "send_marketing_email", ok: false, note: "no email on file" });
            failed++;
            continue;
          }
          if (m.marketing_opt_out) {
            details.push({ member_id: m.id, name: m.name, action: "send_marketing_email", ok: false, note: "opted out" });
            failed++;
            continue;
          }
          const result = await sendAppEmail({
            dojoId,
            to: m.email,
            subject: renderTemplate(action.subject, m),
            html: renderTemplate(action.body_html, m),
            templateName: "playbook-marketing-email",
            idempotencyKey: `workflow:${wf.id}:${m.id}:${runRow.id}`,

            marketing: true,
            sender: action.from_name ? { ...sender, fromName: action.from_name } : sender,
            memberId: m.id,
            metadata: { workflow_id: wf.id, template_id: wf.template_id ?? null },
          });
          if (result.ok) {
            details.push({ member_id: m.id, name: m.name, action: "send_marketing_email", ok: true });
            succeeded++;
            actionedAny = true;
          } else {
            details.push({ member_id: m.id, name: m.name, action: "send_marketing_email", ok: false, note: result.error });
            failed++;
          }
        }
      } catch (e: any) {
        failed++;
        details.push({ member_id: m.id, name: m.name, action: action.type, ok: false, note: e?.message ?? "error" });
      }
    }
    if (actionedAny) {
      // Written with the admin client: workflow_member_actions is read-only to
      // authenticated users by design.
      await supabaseAdmin.from("workflow_member_actions").insert({
        workflow_id: wf.id,
        member_id: m.id,
        dojo_id: dojoId,
      });
      // Retention outcome tracking: mark the member's open intervention as
      // contacted by this playbook.
      const { data: openIv } = await supabaseAdmin
        .from("retention_interventions")
        .select("id")
        .eq("dojo_id", dojoId)
        .eq("member_id", m.id)
        .eq("outcome", "pending")
        .is("intervention_at", null)
        .order("flagged_at", { ascending: false })
        .limit(1);
      if (openIv?.length) {
        await supabaseAdmin
          .from("retention_interventions")
          .update({
            intervention_type: "playbook",
            workflow_id: wf.id,
            intervention_at: new Date().toISOString(),
          })
          .eq("id", openIv[0].id);
      }
    }
  }

  const status = failed === 0 ? "succeeded" : succeeded === 0 ? "failed" : "partial";
  await client
    .from("workflow_runs")
    .update({
      status,
      matched_count: matched.length,
      succeeded_count: succeeded,
      failed_count: failed,
      details: details.slice(0, 200),
      finished_at: new Date().toISOString(),
    })
    .eq("id", runRow.id);

  await client
    .from("workflows")
    .update({ last_run_at: new Date().toISOString() })
    .eq("id", wf.id);

  return {
    run_id: runRow.id,
    matched: matched.length,
    actioned: targets.length,
    skipped: skippedIds.size,
    succeeded,
    failed,
    status,
  };
}

export const runWorkflowNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId);

    const { data: wf, error: wfErr } = await supabase
      .from("workflows")
      .select("*")
      .eq("id", data.id)
      .eq("dojo_id", data.dojoId)
      .single();
    if (wfErr) throw wfErr;

    return await runWorkflowInternal({
      client: supabase,
      workflow: wf,
      dojoId: data.dojoId,
      triggerSource: "manual",
      actorUserId: userId,
    });
  });

// ───────────── Retention playbooks ─────────────

/** Enable (create or update) a retention playbook for this dojo in one click. */
export const enableRetentionPlaybook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; templateId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "enableRetentionPlaybook");
    const { RETENTION_PLAYBOOKS } = await import("./workflow-templates");
    const tpl = RETENTION_PLAYBOOKS.find((t) => t.id === data.templateId);
    if (!tpl) throw new Error("Unknown playbook");

    const { data: existing } = await supabase
      .from("workflows")
      .select("id")
      .eq("dojo_id", data.dojoId)
      .eq("template_id", tpl.id)
      .maybeSingle();

    const payload = {
      dojo_id: data.dojoId,
      template_id: tpl.id,
      name: tpl.name,
      description: tpl.description,
      enabled: true,
      trigger_type: tpl.trigger_type,
      trigger_config: tpl.trigger_config,
      filter: tpl.filter,
      actions: tpl.actions,
      action_cooldown_days: tpl.cooldown_days,
    };

    if (existing) {
      const { error } = await supabase
        .from("workflows")
        .update({ ...payload, enabled: true })
        .eq("id", existing.id)
        .eq("dojo_id", data.dojoId);
      if (error) throw error;
      return { id: existing.id, created: false };
    }
    const { data: row, error } = await supabase
      .from("workflows")
      .insert({ ...payload, created_by: userId })
      .select("id")
      .single();
    if (error) throw error;
    return { id: row.id, created: true };
  });

/** Playbook status for this dojo: audience size now, last run, members actioned. */
export const getRetentionPlaybookStats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "getRetentionPlaybookStats");
    const { RETENTION_PLAYBOOKS } = await import("./workflow-templates");

    const { data: rows, error } = await supabase
      .from("workflows")
      .select("id,template_id,enabled,last_run_at,action_cooldown_days")
      .eq("dojo_id", data.dojoId)
      .not("template_id", "is", null);
    if (error) throw error;

    const byTemplate = new Map<string, any>();
    for (const r of rows ?? []) byTemplate.set(r.template_id, r);

    const { data: actions } = await supabase
      .from("workflow_member_actions")
      .select("workflow_id,member_id")
      .eq("dojo_id", data.dojoId);
    const actionedByWorkflow = new Map<string, Set<string>>();
    for (const a of actions ?? []) {
      const set = actionedByWorkflow.get(a.workflow_id) ?? new Set<string>();
      set.add(a.member_id);
      actionedByWorkflow.set(a.workflow_id, set);
    }

    const out = [];
    for (const tpl of RETENTION_PLAYBOOKS) {
      const wf = byTemplate.get(tpl.id) ?? null;
      const audience = await evaluateAudienceInternal(supabase, tpl.filter, data.dojoId);
      out.push({
        template_id: tpl.id,
        workflow_id: wf?.id ?? null,
        enabled: !!wf?.enabled,
        last_run_at: wf?.last_run_at ?? null,
        cooldown_days: wf?.action_cooldown_days ?? tpl.cooldown_days,
        audience_size: audience.length,
        members_actioned: wf ? (actionedByWorkflow.get(wf.id)?.size ?? 0) : 0,
      });
    }
    return { playbooks: out };
  });

/** Which playbooks have actioned a given member (member profile / at-risk views). */
export const getMemberPlaybookActions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "getMemberPlaybookActions");
    const { data: rows, error } = await supabase
      .from("workflow_member_actions")
      .select("actioned_at, workflow:workflows(id,name,template_id)")
      .eq("dojo_id", data.dojoId)
      .eq("member_id", data.memberId)
      .order("actioned_at", { ascending: false })
      .limit(25);
    if (error) throw error;
    return {
      actions: (rows ?? []).map((r: any) => ({
        actioned_at: r.actioned_at,
        workflow_id: r.workflow?.id ?? null,
        workflow_name: r.workflow?.name ?? "Workflow",
        template_id: r.workflow?.template_id ?? null,
      })),
    };
  });


/** Dojo-wide playbook action history, grouped by member (at-risk dashboard). */
export const listPlaybookActionsByMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "listPlaybookActionsByMember");
    const { data: rows, error } = await supabase
      .from("workflow_member_actions")
      .select("member_id, actioned_at, workflow:workflows(name,template_id)")
      .eq("dojo_id", data.dojoId)
      .order("actioned_at", { ascending: false })
      .limit(2000);
    if (error) throw error;
    const byMember: Record<string, { workflow_name: string; actioned_at: string }[]> = {};
    for (const r of (rows ?? []) as any[]) {
      const list = byMember[r.member_id] ?? [];
      list.push({ workflow_name: r.workflow?.name ?? "Workflow", actioned_at: r.actioned_at });
      byMember[r.member_id] = list;
    }
    return { byMember };
  });
