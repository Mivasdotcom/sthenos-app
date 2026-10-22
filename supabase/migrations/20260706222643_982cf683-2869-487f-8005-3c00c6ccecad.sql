DROP POLICY IF EXISTS "waiver_templates staff read" ON public.waiver_templates;
DROP POLICY IF EXISTS "waiver_templates authenticated read" ON public.waiver_templates;
DROP POLICY IF EXISTS "waiver_templates public read" ON public.waiver_templates;

CREATE POLICY "waiver_templates owner admin read"
ON public.waiver_templates
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.dojo_memberships dm
    WHERE dm.user_id = auth.uid()
      AND dm.role IN ('owner','admin')
  )
);