import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertDojoStaff } from "@/lib/dojo-access";

const QuoteInput = z.object({
  dojoId: z.string().uuid(),
  invoiceId: z.string().uuid(),
  amountCents: z.number().int().positive().nullable().optional(),
});

const IssueInput = z.object({
  dojoId: z.string().uuid(),
  invoiceId: z.string().uuid(),
  amountCents: z.number().int().positive().nullable().optional(),
  reason: z.string().max(500).optional(),
});

/** Exact preview of a refund: amount, gym's share, platform fee reversal. */
export const getRefundQuote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => QuoteInput.parse(input))
  .handler(async ({ data, context }) => {
    await assertDojoStaff(context.supabase, context.userId, data.dojoId, "getRefundQuote");
    const { getPlatformStripe, hasStripeSecret } = await import("@/lib/stripe-connect.server");
    if (!hasStripeSecret()) return { quote: null, error: "Stripe is not configured." };
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { quoteInvoiceRefund } = await import("@/lib/refunds.server");
    try {
      const quote = await quoteInvoiceRefund({
        supabaseAdmin,
        stripe: getPlatformStripe(),
        dojoId: data.dojoId,
        invoiceId: data.invoiceId,
        amountCents: data.amountCents ?? null,
      });
      return { quote, error: null as string | null };
    } catch (e) {
      const { getConnectErrorMessage } = await import("@/lib/stripe-connect.server");
      return { quote: null, error: getConnectErrorMessage(e) };
    }
  });

/** Issue a full or partial refund against a paid invoice. */
export const refundInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => IssueInput.parse(input))
  .handler(async ({ data, context }) => {
    await assertDojoStaff(context.supabase, context.userId, data.dojoId, "refundInvoice");
    const { getPlatformStripe, hasStripeSecret, getConnectErrorMessage } = await import(
      "@/lib/stripe-connect.server"
    );
    const fail = (error: string) => ({
      ok: false as boolean,
      error: error as string | null,
      refundId: null as string | null,
      amountCents: 0,
      currency: "usd",
      remainingAfterCents: 0,
    });
    if (!hasStripeSecret()) return fail("Stripe is not configured.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { issueInvoiceRefund } = await import("@/lib/refunds.server");
    try {
      const res = await issueInvoiceRefund({
        supabaseAdmin,
        stripe: getPlatformStripe(),
        dojoId: data.dojoId,
        invoiceId: data.invoiceId,
        amountCents: data.amountCents ?? null,
        reason: data.reason?.trim() || null,
        userId: context.userId,
      });
      return {
        ok: true as boolean,
        error: null as string | null,
        refundId: res.refundId as string | null,
        amountCents: res.quote.refundAmountCents,
        currency: res.quote.currency,
        remainingAfterCents: Math.max(
          0,
          res.quote.remainingRefundableCents - res.quote.refundAmountCents,
        ),
      };
    } catch (e) {
      return fail(getConnectErrorMessage(e));
    }
  });
