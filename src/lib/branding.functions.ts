import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertDojoStaff } from "@/lib/dojo-access";
import {
  LOGO_BUCKET,
  LOGO_EXTENSION,
  LOGO_MIME,
  base64ToBytes,
  validateLogoBytes,
} from "@/lib/dojo-logo";

/**
 * Upload (or replace) a dojo logo. The file bytes are re-validated server-side
 * from their magic bytes, so a renamed SVG or an oversized file is rejected
 * even if the client checks are bypassed.
 */
export const uploadDojoLogo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z.object({ dojoId: z.string().uuid(), fileBase64: z.string().min(1) }).parse(data),
  )
  .handler(async ({ data, context }) => {
    await assertDojoStaff(context.supabase, context.userId, data.dojoId, "uploadDojoLogo");

    const bytes = base64ToBytes(data.fileBase64);
    const type = validateLogoBytes(bytes);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Remove any previous file so old objects don't accumulate.
    const { data: existing } = await supabaseAdmin.storage.from(LOGO_BUCKET).list(data.dojoId);
    if (existing?.length) {
      await supabaseAdmin.storage
        .from(LOGO_BUCKET)
        .remove(existing.map((f) => `${data.dojoId}/${f.name}`));
    }

    const path = `${data.dojoId}/logo-${Date.now()}.${LOGO_EXTENSION[type]}`;
    const { error: upErr } = await supabaseAdmin.storage
      .from(LOGO_BUCKET)
      .upload(path, bytes, { contentType: LOGO_MIME[type], upsert: true });
    if (upErr) throw new Error(upErr.message);

    const { error } = await supabaseAdmin
      .from("dojos")
      .update({ logo_path: path })
      .eq("id", data.dojoId);
    if (error) throw new Error(error.message);

    return { path };
  });

/** Remove a dojo logo and revert to the default Sthenos branding. */
export const removeDojoLogo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ dojoId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    await assertDojoStaff(context.supabase, context.userId, data.dojoId, "removeDojoLogo");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: existing } = await supabaseAdmin.storage.from(LOGO_BUCKET).list(data.dojoId);
    if (existing?.length) {
      await supabaseAdmin.storage
        .from(LOGO_BUCKET)
        .remove(existing.map((f) => `${data.dojoId}/${f.name}`));
    }
    const { error } = await supabaseAdmin
      .from("dojos")
      .update({ logo_path: null })
      .eq("id", data.dojoId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
