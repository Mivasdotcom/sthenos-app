ALTER TABLE public.dojos ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'GB';
UPDATE public.dojos SET country = 'GB' WHERE country IS NULL OR btrim(country) = '';