import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertDojoStaff } from "./dojo-access";

/** Before/after the payer's family total when a trial member starts paying. */
export const previewTrialConversion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "previewTrialConversion");
    const { previewTrialConversionInternal } = await import("@/lib/trial-convert.server");
    return previewTrialConversionInternal({ dojoId: data.dojoId, memberId: data.memberId });
  });

/** Convert a trial member to active, scheduling the payer's new family total. */
export const convertTrialToActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string; memberId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "convertTrialToActive");
    const { convertTrialToActiveInternal } = await import("@/lib/trial-convert.server");
    return convertTrialToActiveInternal({
      dojoId: data.dojoId,
      memberId: data.memberId,
      actorUserId: userId ?? null,
    });
  });
