ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS lead_source text,
  ADD COLUMN IF NOT EXISTS referred_by text;