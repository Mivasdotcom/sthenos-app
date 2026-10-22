
CREATE TABLE public.view_switch_audit_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  user_email TEXT NOT NULL,
  from_view TEXT NOT NULL,
  to_view TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.view_switch_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view_switch_audit owner read"
ON public.view_switch_audit_log
FOR SELECT
TO authenticated
USING (has_role(auth.uid(), 'owner'::app_role));

CREATE POLICY "view_switch_audit self insert"
ON public.view_switch_audit_log
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_view_switch_audit_created_at ON public.view_switch_audit_log (created_at DESC);
