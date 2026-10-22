// Password reset request. Deliberately opaque: the response is identical
// whether or not the address is registered, so this endpoint can never be used
// to enumerate accounts. Rate limited by email and by IP through the same
// ledger that protects public signup.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const Input = z.object({
  email: z.string().trim().toLowerCase().email(),
  origin: z.string().trim().optional(),
});

export const requestPasswordReset = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data }) => {
    const { safeOrigin } = await import("@/lib/password-reset.server");
    const { enforceResetRateLimit } = await import("@/lib/rate-limit.server");

    const allowed = await enforceResetRateLimit(data.email);
    // Over the limit: say nothing different, just don't send another email.
    if (!allowed) return { ok: true as const };

    try {
      const { createClient } = await import("@supabase/supabase-js");
      const supabase = createClient(
        process.env["SUPABASE_URL"]!,
        process.env["SUPABASE_PUBLISHABLE_KEY"]!,
        { auth: { storage: undefined, persistSession: false, autoRefreshToken: false } },
      );
      await supabase.auth.resetPasswordForEmail(data.email, {
        redirectTo: `${safeOrigin(data.origin)}/reset-password`,
      });
    } catch (err) {
      // Never surface provider errors — they leak whether the address exists.
      console.error("resetPasswordForEmail failed:", err);
    }

    return { ok: true as const };
  });
