CREATE TABLE public.dojo_access_denials (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID,
  dojo_id UUID,
  role TEXT,
  function_name TEXT,
  reason TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT ON public.dojo_access_denials TO authenticated;
GRANT ALL ON public.dojo_access_denials TO service_role;

ALTER TABLE public.dojo_access_denials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Dojo staff can view denials for their dojo"
ON public.dojo_access_denials
FOR SELECT
TO authenticated
USING (dojo_id IS NOT NULL AND public.is_dojo_staff(auth.uid(), dojo_id));

CREATE INDEX idx_dojo_access_denials_dojo_created
  ON public.dojo_access_denials (dojo_id, created_at DESC);
CREATE INDEX idx_dojo_access_denials_user_created
  ON public.dojo_access_denials (user_id, created_at DESC);