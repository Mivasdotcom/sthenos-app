import { createServerFn } from "@tanstack/react-start";

/**
 * The gym's own published member privacy notice, read by slug.
 *
 * Served through the admin client behind an explicit lookup so the agreement
 * tables need no public grants. Returns `notice: null` when the gym has not
 * published one yet — callers must not present anything as a finished notice
 * in that case.
 */
export const getPublicPrivacyNotice = createServerFn({ method: "GET" })
  .inputValidator((d: { slug: string }) => d)
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: dojo } = await supabaseAdmin
      .from("dojos")
      .select("id, name, slug, privacy_contact_email, contact_email")
      .eq("slug", data.slug)
      .is("archived_at", null)
      .maybeSingle();
    if (!dojo) throw new Error("Not found");

    const { data: notice } = await supabaseAdmin
      .from("dojo_privacy_notices")
      .select("title, body_markdown, version, published_at")
      .eq("dojo_id", dojo.id)
      .eq("is_current", true)
      .maybeSingle();

    return {
      dojo: {
        name: dojo.name,
        slug: dojo.slug,
        contactEmail: dojo.privacy_contact_email ?? dojo.contact_email ?? null,
      },
      notice: notice ?? null,
    };
  });
