CREATE TABLE public.public_request_attempts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  dojo_id uuid REFERENCES public.dojos(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  ip_hash text,
  email_hash text,
  outcome text NOT NULL DEFAULT 'allowed',
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT ALL ON public.public_request_attempts TO service_role;

ALTER TABLE public.public_request_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "no direct access to public_request_attempts"
  ON public.public_request_attempts FOR SELECT USING (false);

CREATE INDEX public_request_attempts_ip_idx
  ON public.public_request_attempts (ip_hash, created_at DESC);
CREATE INDEX public_request_attempts_email_idx
  ON public.public_request_attempts (email_hash, created_at DESC);
CREATE INDEX public_request_attempts_dojo_idx
  ON public.public_request_attempts (dojo_id, endpoint, created_at DESC);