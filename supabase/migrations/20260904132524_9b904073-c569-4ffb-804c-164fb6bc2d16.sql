ALTER TABLE public.dojos
  ADD COLUMN IF NOT EXISTS billing_mode text NOT NULL DEFAULT 'fixed_day';

ALTER TABLE public.dojos
  DROP CONSTRAINT IF EXISTS dojos_billing_mode_check;

ALTER TABLE public.dojos
  ADD CONSTRAINT dojos_billing_mode_check
  CHECK (billing_mode IN ('fixed_day','anniversary'));

GRANT SELECT (billing_mode) ON public.dojos TO authenticated;