// Tenant-scoping helpers for server functions.
// These verify the caller is a member of the passed dojoId before any
// tenant-scoped query runs, and can additionally require a staff role.
// Every denial is recorded in public.dojo_access_denials for audit.

const STAFF_ROLES = new Set(["owner", "admin", "coach"]);

async function logDenial(params: {
  userId: string | null;
  dojoId: string | null;
  role: string | null;
  reason: string;
  functionName?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("dojo_access_denials").insert({
      user_id: params.userId,
      dojo_id: params.dojoId,
      role: params.role,
      reason: params.reason,
      function_name: params.functionName ?? null,
      metadata: (params.metadata ?? null) as never,
    });
  } catch {
    // Never let audit-log failures mask the original denial.
  }
}

export async function assertDojoMember(
  supabase: any,
  userId: string,
  dojoId: string,
  functionName?: string,
): Promise<string> {
  if (!dojoId) {
    await logDenial({
      userId: userId ?? null,
      dojoId: null,
      role: null,
      reason: "missing_dojo_id",
      functionName,
    });
    throw new Error("dojoId is required");
  }
  const { data, error } = await supabase
    .from("dojo_memberships")
    .select("role")
    .eq("user_id", userId)
    .eq("dojo_id", dojoId)
    .maybeSingle();
  if (error) {
    await logDenial({
      userId,
      dojoId,
      role: null,
      reason: "membership_lookup_failed",
      functionName,
      metadata: { error: error.message },
    });
    throw error;
  }
  if (!data) {
    await logDenial({
      userId,
      dojoId,
      role: null,
      reason: "not_a_member",
      functionName,
    });
    throw new Error("Not a member of this dojo");
  }
  return data.role as string;
}

export async function assertDojoStaff(
  supabase: any,
  userId: string,
  dojoId: string,
  functionName?: string,
): Promise<string> {
  const role = await assertDojoMember(supabase, userId, dojoId, functionName);
  if (!STAFF_ROLES.has(role)) {
    await logDenial({
      userId,
      dojoId,
      role,
      reason: "staff_role_required",
      functionName,
    });
    throw new Error("Staff access required");
  }
  return role;
}
