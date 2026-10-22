DROP POLICY IF EXISTS "view_switch_audit owner read" ON public.view_switch_audit_log;

CREATE POLICY "view_switch_audit dojo staff read"
ON public.view_switch_audit_log
FOR SELECT
TO authenticated
USING (
  user_id = auth.uid()
  OR (
    dojo_id IS NOT NULL
    AND (
      public.has_dojo_role(auth.uid(), dojo_id, 'owner'::dojo_role)
      OR public.has_dojo_role(auth.uid(), dojo_id, 'admin'::dojo_role)
    )
  )
);