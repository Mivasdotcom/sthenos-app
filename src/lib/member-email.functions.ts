// Synced email changes. See member-email.server.ts for the decision on how the
// login (auth) email is updated.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const ChangeInput = z.object({
  memberId: z.string().uuid(),
  email: z.string().trim().toLowerCase().email().max(320),
});

const RepairInput = z.object({
  dojoId: z.string().uuid(),
  memberIds: z.array(z.string().uuid()).min(1).max(200),
  // "member" = the member record's address is correct, push it to the login.
  // "login"  = the login address is correct, pull it into the member record.
  direction: z.enum(["member", "login"]),
});

type MemberRow = {
  id: string;
  dojo_id: string;
  user_id: string | null;
  email: string | null;
  stripe_customer_id: string | null;
};

async function loadAuthorizedMember(
  supabase: any,
  userId: string,
  memberId: string,
): Promise<MemberRow> {
  const { data: member, error } = await supabase
    .from("members")
    .select("id, dojo_id, user_id, email, stripe_customer_id")
    .eq("id", memberId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!member) throw new Error("Member not found");

  if (member.user_id === userId) return member as MemberRow;

  const { data: staff } = await supabase.rpc("is_dojo_staff", {
    _user_id: userId,
    _dojo_id: member.dojo_id,
  });
  if (!staff) throw new Error("Not allowed");
  return member as MemberRow;
}

/**
 * Change a member's email everywhere at once: member record, login account and
 * Stripe customer. Callable by the member themselves or by staff of their gym.
 */
export const changeMemberEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ChangeInput.parse(input))
  .handler(async ({ data, context }) => {
    const member = await loadAuthorizedMember(context.supabase, context.userId, data.memberId);
    const { applyMemberEmailChange } = await import("@/lib/member-email.server");
    const result = await applyMemberEmailChange({
      memberId: member.id,
      userId: member.user_id,
      stripeCustomerId: member.stripe_customer_id,
      currentMemberEmail: member.email,
      newEmail: data.email,
    });
    return result;
  });

/**
 * Bring a batch of drifted members back into line. Staff only.
 */
export const repairEmailDrift = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => RepairInput.parse(input))
  .handler(async ({ data, context }) => {
    const { data: staff } = await context.supabase.rpc("is_dojo_staff", {
      _user_id: context.userId,
      _dojo_id: data.dojoId,
    });
    if (!staff) throw new Error("Not allowed");

    const { data: drift, error } = await context.supabase.rpc("member_email_drift", {
      _dojo_id: data.dojoId,
    });
    if (error) throw new Error(error.message);

    const rows = ((drift ?? []) as Array<{
      member_id: string;
      member_email: string;
      login_email: string;
    }>).filter((r) => data.memberIds.includes(r.member_id));

    const { applyMemberEmailChange } = await import("@/lib/member-email.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let fixed = 0;
    const failures: Array<{ memberId: string; error: string }> = [];

    for (const row of rows) {
      try {
        const { data: member } = await supabaseAdmin
          .from("members")
          .select("id, user_id, email, stripe_customer_id")
          .eq("id", row.member_id)
          .eq("dojo_id", data.dojoId)
          .maybeSingle();
        if (!member) continue;

        await applyMemberEmailChange({
          memberId: member.id,
          userId: member.user_id,
          stripeCustomerId: member.stripe_customer_id,
          currentMemberEmail: member.email,
          newEmail: data.direction === "member" ? row.member_email : row.login_email,
        });
        fixed += 1;
      } catch (err) {
        failures.push({
          memberId: row.member_id,
          error: err instanceof Error ? err.message : "unknown error",
        });
      }
    }

    return { fixed, failures };
  });
