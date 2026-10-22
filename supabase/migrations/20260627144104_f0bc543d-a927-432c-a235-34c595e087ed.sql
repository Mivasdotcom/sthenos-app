
DROP POLICY IF EXISTS "email_settings owner update in dojo" ON public.email_settings;
DROP POLICY IF EXISTS "email_settings owner update" ON public.email_settings;
CREATE POLICY "email_settings owner update in dojo"
ON public.email_settings
FOR UPDATE
TO authenticated
USING (has_dojo_role(auth.uid(), dojo_id, 'owner'::dojo_role))
WITH CHECK (has_dojo_role(auth.uid(), dojo_id, 'owner'::dojo_role));

DROP POLICY IF EXISTS "waiver_templates public read" ON public.waiver_templates;
REVOKE SELECT ON public.waiver_templates FROM anon;
