/**
 * Platform fee maths, shared by client and server.
 *
 * Kept in a client-safe module so UI surfaces can display the exact amount
 * Stripe will charge (base price + fee when pass-through is enabled) instead of
 * a base price that contradicts the real invoice.
 */
export const PLATFORM_FEE_PERCENT = 1;

/**
 * Stripe's own processing cost, which the GYM pays -- as it would with any
 * card provider, and as agreed with the gyms on the platform.
 *
 * These are destination charges, so Stripe debits its fee from the PLATFORM's
 * balance and transfers to the gym whatever the platform does not claim as an
 * application fee. Unless the application fee covers Stripe's cost as well as
 * the platform's margin, the platform is quietly paying the gym's card fees: a
 * €65.65 charge cost €1.23 in Stripe fees against a €0.65 application fee,
 * leaving the platform 58 cents down on every single payment.
 *
 * An estimate, necessarily -- the real rate depends on the card. These are
 * Stripe's standard European rates. A UK or non-European card costs more, so
 * the platform stays slightly short on those, which is the right way round:
 * better than over-charging every gym for the common case.
 */
export const STRIPE_FEE_PERCENT = 1.5;
export const STRIPE_FEE_FIXED_CENTS = 25;

/** What Stripe will take from a charge of this size. */
export function stripeFeeCents(grossCents: number): number {
  if (!grossCents) return 0;
  return Math.round((grossCents * STRIPE_FEE_PERCENT) / 100) + STRIPE_FEE_FIXED_CENTS;
}

/**
 * The application fee the platform must claim so it nets its margin and the
 * gym bears Stripe's cost. Never more than the charge itself.
 */
export function totalAppFeeCents(originalCents: number, grossCents: number): number {
  return Math.min(grossCents, platformFeeCents(originalCents) + stripeFeeCents(grossCents));
}

/** Fee amount, in cents, that the platform must net on a given base amount. */
export function platformFeeCents(baseCents: number): number {
  return Math.round((baseCents * PLATFORM_FEE_PERCENT) / 100);
}

/**
 * The amount Stripe will actually charge the member: base price, plus the
 * platform fee when the gym passes it through.
 */
export function grossChargeCents(baseCents: number, passFee: boolean): number {
  if (!baseCents) return baseCents ?? 0;
  return passFee ? baseCents + platformFeeCents(baseCents) : baseCents;
}

/**
 * `application_fee_percent` for a subscription.
 *
 * Stripe rejects more than TWO decimal places here ("Invalid decimal: 0.9901;
 * must contain at maximum two decimal places"), which previously made every
 * pass-through signup checkout fail outright. Two decimals is the hard API
 * limit, so we round to 2dp: at most a fraction of a cent per invoice, versus
 * a checkout that never opens.
 */
export function subscriptionAppFeePercent(
  originalCents: number,
  grossCents: number,
  passFee: boolean,
): number {
  // The gym pays Stripe's cost either way. Pass-through only decides whether
  // the MEMBER covers the platform's own 1% on top of the listed price.
  void passFee;
  if (!grossCents) return PLATFORM_FEE_PERCENT;
  const percent = (totalAppFeeCents(originalCents, grossCents) / grossCents) * 100;
  return Math.round(percent * 100) / 100;
}

