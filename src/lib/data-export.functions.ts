import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertDojoStaff } from "./dojo-access";

/**
 * Self-service export of ALL of a gym's data as a zip of CSV files.
 * Owners and admins only, strictly scoped to their own dojo.
 */
export const exportAllDojoData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ dojoId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const role = await assertDojoStaff(
      context.supabase,
      context.userId,
      data.dojoId,
      "exportAllDojoData",
    );
    if (!["owner", "admin"].includes(role)) {
      throw new Error("Only owners and admins can export the gym's data.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { buildDojoExport, zipBase64 } = await import("./data-export.server");
    const { files, counts } = await buildDojoExport(supabaseAdmin, data.dojoId);
    const stamp = new Date().toISOString().slice(0, 10);

    return {
      filename: `sthenos-export-${stamp}.zip`,
      base64: zipBase64(files),
      counts,
      generatedAt: new Date().toISOString(),
    };
  });
