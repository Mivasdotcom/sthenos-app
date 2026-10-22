import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Link any pending public-signup member rows to this auth user.
 *
 * A member created via /j/:slug/signup has no user_id — the person hasn't
 * created an auth account yet. When they later sign up / log in with the
 * same email, we claim those rows for them and make sure a
 * dojo_memberships row exists so their portal sees the real record.
 */
export const linkMemberOnAuth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId, claims } = context as any;
    const email: string | undefined = claims?.email;
    if (!userId || !email) return { linked: 0 };

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const emailLower = String(email).toLowerCase();

    // Find unlinked members with matching email. The ilike narrows this in the
    // database rather than pulling every unlinked row in every dojo back into
    // this process. An address containing _ or % can only widen that match, so
    // the exact comparison below stays the authority on what actually matches.
    const { data: members, error: memErr } = await supabaseAdmin
      .from("members")
      .select("id, dojo_id, email")
      .is("user_id", null)
      .ilike("email", emailLower);
    if (memErr) throw memErr;

    const matches = (members ?? []).filter(
      (m: any) => typeof m.email === "string" && m.email.toLowerCase() === emailLower,
    );
    if (matches.length === 0) return { linked: 0 };

    // One auth user can legitimately be a member at several gyms, but only ONE
    // member row per gym may point at a given login. Rows for a gym where this
    // user already has a linked record are skipped instead of colliding.
    const { data: alreadyLinked } = await supabaseAdmin
      .from("members")
      .select("dojo_id")
      .eq("user_id", userId);
    const claimedDojos = new Set<string>((alreadyLinked ?? []).map((r: any) => r.dojo_id));

    let linked = 0;
    for (const m of matches) {
      if (claimedDojos.has(m.dojo_id)) continue;
      const { error: updErr } = await supabaseAdmin
        .from("members")
        .update({ user_id: userId, updated_at: new Date().toISOString() })
        .eq("id", m.id)
        .is("user_id", null);
      if (updErr) {
        console.error("linkMemberOnAuth: member update failed", updErr);
        continue;
      }
      claimedDojos.add(m.dojo_id);
      linked += 1;


      // Ensure a dojo membership exists (don't clobber existing role)
      const { data: existing } = await supabaseAdmin
        .from("dojo_memberships")
        .select("user_id")
        .eq("user_id", userId)
        .eq("dojo_id", m.dojo_id)
        .maybeSingle();
      if (!existing) {
        const { error: insErr } = await supabaseAdmin
          .from("dojo_memberships")
          .insert({ user_id: userId, dojo_id: m.dojo_id, role: "member" });
        if (insErr && (insErr as any).code !== "23505") {
          console.error("linkMemberOnAuth: membership insert failed", insErr);
        }
      }
    }

    return { linked };
  });
