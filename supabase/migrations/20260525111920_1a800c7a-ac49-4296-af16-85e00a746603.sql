
DROP POLICY IF EXISTS "view_switch_audit self insert" ON public.view_switch_audit_log;

CREATE POLICY "view_switch_audit self insert"
ON public.view_switch_audit_log
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND user_email = (auth.jwt() ->> 'email')
);
