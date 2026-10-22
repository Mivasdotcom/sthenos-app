// Server-only helpers for cash payments.

/** Recompute payment statuses + retention after a cash payment changes. */
export async function resyncAfterCashChange(dojoId: string, memberId: string) {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.rpc("recompute_member_payment_statuses", { _dojo_id: dojoId });
    const { recomputeRetentionForDojo } = await import("./retention.functions");
    await recomputeRetentionForDojo(supabaseAdmin, dojoId, [memberId]);
  } catch (e) {
    console.error("[cash-payments] resync failed", e);
  }
}
