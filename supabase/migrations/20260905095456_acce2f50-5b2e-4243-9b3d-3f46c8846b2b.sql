ALTER TABLE public.dojos
  ADD COLUMN IF NOT EXISTS trial_reminder_enabled boolean NOT NULL DEFAULT true;

UPDATE public.dojos SET trial_reminder_enabled = false WHERE name ILIKE '%FTBJJ%Limassol%';