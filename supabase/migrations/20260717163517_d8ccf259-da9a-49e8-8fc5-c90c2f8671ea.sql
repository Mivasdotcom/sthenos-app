
ALTER TABLE public.dojos
  ADD COLUMN IF NOT EXISTS stripe_charges_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_details_submitted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_account_country text;

CREATE TABLE IF NOT EXISTS public.platform_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  stripe_customer_id text,
  stripe_subscription_id text UNIQUE,
  status text NOT NULL DEFAULT 'inactive',
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  price_id text,
  environment text NOT NULL DEFAULT 'sandbox',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dojo_id)
);

GRANT SELECT ON public.platform_subscriptions TO authenticated;
GRANT ALL ON public.platform_subscriptions TO service_role;

ALTER TABLE public.platform_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view own dojo platform subscription"
  ON public.platform_subscriptions
  FOR SELECT
  TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE TRIGGER trg_platform_subscriptions_updated_at
  BEFORE UPDATE ON public.platform_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_platform_subscriptions_dojo_id
  ON public.platform_subscriptions(dojo_id);
