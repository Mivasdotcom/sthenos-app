-- 1. Per-dojo payment method selection
ALTER TABLE public.dojos
  ADD COLUMN IF NOT EXISTS payment_methods text[];

COMMENT ON COLUMN public.dojos.payment_methods IS
  'Checkout payment methods this gym offers (card, sepa_debit, bacs_debit). NULL = sensible default from currency/country.';

-- 2. Members may pay by direct debit
ALTER TABLE public.members DROP CONSTRAINT IF EXISTS members_payment_method_check;
ALTER TABLE public.members
  ADD CONSTRAINT members_payment_method_check
  CHECK (payment_method = ANY (ARRAY['card'::text, 'cash'::text, 'direct_debit'::text]));

-- 3. Subscriptions record their own currency + payment method
ALTER TABLE public.member_subscriptions
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS payment_method text;

-- Backfill currency from the plan the subscription points at.
UPDATE public.member_subscriptions s
SET currency = p.currency
FROM public.dojo_plans p
WHERE s.plan_id = p.id AND s.currency IS NULL;

-- Sthenos HQ's live subscriptions were created while plans were priced in USD;
-- Stripe cannot change a subscription's currency, so record that explicitly
-- before the plans are corrected below.
UPDATE public.member_subscriptions
SET currency = 'usd'
WHERE dojo_id = '3648987a-348c-42b7-8ead-b2c99bea01ea'
  AND currency IS NULL;

-- 4. Correct Sthenos HQ plans to GBP (matches default_currency + GB account).
--    stripe_price_id is cleared so a new Price is minted in the new currency.
UPDATE public.dojo_plans
SET currency = 'gbp', stripe_price_id = NULL
WHERE dojo_id = '3648987a-348c-42b7-8ead-b2c99bea01ea'
  AND currency <> 'gbp';
