-- Fix email_settings.id: change from boolean singleton to uuid primary key
ALTER TABLE public.email_settings DROP CONSTRAINT IF EXISTS email_settings_id_check;
ALTER TABLE public.email_settings DROP CONSTRAINT IF EXISTS email_settings_pkey;
ALTER TABLE public.email_settings DROP COLUMN id;
ALTER TABLE public.email_settings ADD COLUMN id uuid;
UPDATE public.email_settings SET id = gen_random_uuid() WHERE id IS NULL;
ALTER TABLE public.email_settings ALTER COLUMN id SET NOT NULL;
ALTER TABLE public.email_settings ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.email_settings ADD PRIMARY KEY (id);