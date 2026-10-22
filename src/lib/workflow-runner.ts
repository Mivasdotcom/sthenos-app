import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type AnyFilter = Record<string, any> | null | undefined;

/**
 * Apply a small subset of segment/audience filter criteria to a Supabase
 * `members` query. Supports common shapes: { status, plan, discipline,
 * marketing_opt_out } and a generic { conditions: [{field, op, value}] }
 * array with op in (eq, neq, in, gt, lt, gte, lte, is).
 */
function applyFilter(query: any, filter: AnyFilter) {
  if (!filter || typeof filter !== "object") return query;

  for (const key of ["status", "plan", "discipline", "belt_label"]) {
    if (filter[key] != null) query = query.eq(key, filter[key]);
  }
  if (typeof filter.marketing_opt_out === "boolean") {
    query = query.eq("marketing_opt_out", filter.marketing_opt_out);
  }

  const conds: any[] = Array.isArray(filter.conditions) ? filter.conditions : [];
  for (const c of conds) {
    if (!c || !c.field) continue;
    const op = c.op ?? "eq";
    switch (op) {
      case "eq": query = query.eq(c.field, c.value); break;
      case "neq": query = query.neq(c.field, c.value); break;
      case "in": if (Array.isArray(c.value)) query = query.in(c.field, c.value); break;
      case "gt": query = query.gt(c.field, c.value); break;
      case "gte": query = query.gte(c.field, c.value); break;
      case "lt": query = query.lt(c.field, c.value); break;
      case "lte": query = query.lte(c.field, c.value); break;
      case "is": query = query.is(c.field, c.value); break;
    }
  }
  return query;
}

export const runWorkflow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { workflowId: string; dojoId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase } = context as any;
    const { workflowId, dojoId } = data;

    const { data: workflow, error: wfErr } = await supabase
      .from("workflows")
      .select("*")
      .eq("id", workflowId)
      .eq("dojo_id", dojoId)
      .maybeSingle();
    if (wfErr) throw wfErr;
    if (!workflow) throw new Error("Workflow not found");

    // Prefer the workflow's segment filter; fall back to its inline filter.
    let filter: AnyFilter = workflow.filter ?? null;
    if (workflow.segment_id) {
      const { data: seg, error: segErr } = await supabase
        .from("segments")
        .select("filter")
        .eq("id", workflow.segment_id)
        .eq("dojo_id", dojoId)
        .maybeSingle();
      if (segErr) throw segErr;
      if (seg?.filter) filter = seg.filter;
    }

    let memberQuery = supabase.from("members").select("id").eq("dojo_id", dojoId);
    memberQuery = applyFilter(memberQuery, filter);
    const { data: members, error: memErr } = await memberQuery;
    if (memErr) throw memErr;

    const triggeredAt = new Date().toISOString();
    const rows = (members ?? []).map((m: { id: string }) => ({
      workflow_id: workflowId,
      dojo_id: dojoId,
      member_id: m.id,
      status: "pending" as const,
      trigger_source: "manual",
      triggered_at: triggeredAt,
    }));

    if (rows.length > 0) {
      const { error: insErr } = await supabase.from("workflow_runs").insert(rows);
      if (insErr) throw insErr;
    }

    await supabase
      .from("workflows")
      .update({ last_run_at: triggeredAt })
      .eq("id", workflowId);

    return { queued: rows.length };
  });
