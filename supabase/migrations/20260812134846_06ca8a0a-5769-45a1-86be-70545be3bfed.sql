ALTER TABLE public.dojos
  ADD COLUMN IF NOT EXISTS billing_day_of_month integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';

ALTER TABLE public.dojos
  ADD CONSTRAINT dojos_billing_day_of_month_check
  CHECK (billing_day_of_month BETWEEN 1 AND 28);

ALTER TYPE public.plan_type ADD VALUE IF NOT EXISTS 'Unknown';