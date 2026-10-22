ALTER TABLE public.dojos
  ADD COLUMN IF NOT EXISTS pass_platform_fee_to_members boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.dojos.pass_platform_fee_to_members IS
  'When true, member checkouts are increased by the platform fee percentage so the gym''s net payout equals the full plan price.';