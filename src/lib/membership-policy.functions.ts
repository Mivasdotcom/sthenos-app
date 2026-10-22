import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertDojoStaff } from "./dojo-access";
import { trialPolicyFromDojo, type TrialPolicy } from "@/lib/trial-policy";

/** Gym-level policy for trials, price changes and pauses. */
export type MembershipPolicy = {
  priceChangeNoticeDays: number;
  pausedMembersCanBook: boolean;
  /** Trial settings: length in days, classes per day, optional total cap. */
  trial: TrialPolicy;
  /**
   * Free days from signup before the first payment (0 = off). A separate model
   * from the class trial: everyone picks a plan and enters a card, trains with
   * FULL access for these days, then is charged automatically.
   */
  signupFreeDays: number;
  /** Whether the "your free period ends soon" email is sent (default on). */
  trialReminderEnabled: boolean;
};

const POLICY_COLS =
  "price_change_notice_days, paused_members_can_book, trial_length_days, trial_classes_per_day, trial_max_total_classes, signup_free_days, trial_reminder_enabled";

export const getMembershipPolicy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dojoId: string }) => d)
  .handler(async ({ data, context }): Promise<MembershipPolicy> => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "getMembershipPolicy");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: dojo } = await supabaseAdmin
      .from("dojos")
      .select(POLICY_COLS)
      .eq("id", data.dojoId)
      .maybeSingle();
    return {
      priceChangeNoticeDays: Number((dojo as any)?.price_change_notice_days ?? 30),
      pausedMembersCanBook: !!(dojo as any)?.paused_members_can_book,
      trial: trialPolicyFromDojo(dojo),
      signupFreeDays: Number((dojo as any)?.signup_free_days ?? 0) || 0,
      trialReminderEnabled: (dojo as any)?.trial_reminder_enabled !== false,
    };
  });

export const updateMembershipPolicy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      dojoId: string;
      priceChangeNoticeDays: number;
      pausedMembersCanBook: boolean;
      trialLengthDays: number | null;
      trialClassesPerDay: number;
      trialMaxTotalClasses: number | null;
      signupFreeDays: number;
      trialReminderEnabled: boolean;
    }) => {
      const days = Math.round(Number(d.priceChangeNoticeDays));
      if (!Number.isFinite(days) || days < 0 || days > 180) {
        throw new Error("Notice period must be between 0 and 180 days");
      }
      let length: number | null = null;
      if (d.trialLengthDays != null) {
        length = Math.round(Number(d.trialLengthDays));
        if (!Number.isFinite(length) || length < 0 || length > 365) {
          throw new Error("Trial length must be between 0 and 365 days");
        }
      }
      const perDay = Math.round(Number(d.trialClassesPerDay));
      if (!Number.isFinite(perDay) || perDay < 1 || perDay > 10) {
        throw new Error("Classes per day must be between 1 and 10");
      }
      let maxTotal: number | null = null;
      if (d.trialMaxTotalClasses != null) {
        maxTotal = Math.round(Number(d.trialMaxTotalClasses));
        if (!Number.isFinite(maxTotal) || maxTotal < 0 || maxTotal > 200) {
          throw new Error("Total trial classes must be between 0 and 200");
        }
      }
      const freeDays = Math.round(Number(d.signupFreeDays ?? 0)) || 0;
      if (!Number.isFinite(freeDays) || freeDays < 0 || freeDays > 90) {
        throw new Error("Free days from signup must be between 0 and 90");
      }
      return {
        ...d,
        signupFreeDays: freeDays,
        priceChangeNoticeDays: days,
        trialLengthDays: length,
        trialClassesPerDay: perDay,
        trialMaxTotalClasses: maxTotal,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertDojoStaff(supabase, userId, data.dojoId, "updateMembershipPolicy");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("dojos")
      .update({
        price_change_notice_days: data.priceChangeNoticeDays,
        paused_members_can_book: data.pausedMembersCanBook,
        trial_length_days: data.trialLengthDays,
        trial_classes_per_day: data.trialClassesPerDay,
        trial_max_total_classes: data.trialMaxTotalClasses,
        signup_free_days: data.signupFreeDays,
        trial_reminder_enabled: !!data.trialReminderEnabled,
      })
      .eq("id", data.dojoId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

