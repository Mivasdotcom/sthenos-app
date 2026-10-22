
CREATE TABLE public.email_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id = true),
  from_name text NOT NULL DEFAULT 'Your Dojo',
  from_address text NOT NULL DEFAULT 'onboarding@resend.dev',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
INSERT INTO public.email_settings (id) VALUES (true);
ALTER TABLE public.email_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read email_settings" ON public.email_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth update email_settings" ON public.email_settings FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
