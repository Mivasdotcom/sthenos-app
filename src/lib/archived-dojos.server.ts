// Archived gyms are dormant: no automatic sweep may email their members, move
// their money, or change their membership state. Server-only.
//
// One shared source of truth so every nightly sweep applies the same rule.

/** IDs of every archived gym, for filtering sweep work. */
export async function archivedDojoIds(): Promise<Set<string>> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("dojos")
    .select("id")
    .not("archived_at", "is", null);
  if (error) {
    // Fail loud rather than silently treating archived gyms as active.
    throw new Error(`Could not list archived gyms — ${error.message}`);
  }
  return new Set(((data ?? []) as any[]).map((d) => d.id as string));
}
