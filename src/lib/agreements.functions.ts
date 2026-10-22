import { createServerFn } from "@tanstack/react-start";

/**
 * Public read of everything a prospective member must read or agree to.
 * Uses the admin client behind an explicit public-page check so we never
 * need anon grants on the agreement tables.
 */
export const getPublicAgreements = createServerFn({ method: "GET" })
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: dojo } = await supabaseAdmin
      .from("dojos")
      .select("id, public_page_enabled, collect_media_consent")
      .eq("id", data.dojoId)
      .maybeSingle();
    if (!dojo?.public_page_enabled) throw new Error("Not found");

    const [{ data: waivers }, { data: terms }] = await Promise.all([
      supabaseAdmin
        .from("dojo_waivers")
        .select("id, version, title, body_markdown, updated_at, audience")
        .eq("dojo_id", data.dojoId)
        .eq("is_current", true),
      supabaseAdmin
        .from("dojo_terms")
        .select("id, version, title, body_markdown, updated_at")
        .eq("dojo_id", data.dojoId)
        .eq("is_current", true)
        .maybeSingle(),
    ]);

    const list = waivers ?? [];
    const adultWaiver = list.find((w: any) => (w.audience ?? "adult") === "adult") ?? null;
    const minorWaiver = list.find((w: any) => w.audience === "minor") ?? null;

    return {
      // `waiver` stays the adult waiver for existing callers.
      waiver: adultWaiver,
      adultWaiver,
      minorWaiver,
      terms: terms && terms.body_markdown.trim().length > 0 ? terms : null,
      collectMediaConsent: dojo.collect_media_consent !== false,
    };
  });

