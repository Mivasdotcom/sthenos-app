DROP POLICY IF EXISTS "memberships owner manage" ON public.dojo_memberships;

CREATE POLICY "memberships owner manage"
ON public.dojo_memberships
FOR ALL
TO authenticated
USING (public.has_dojo_role(auth.uid(), dojo_id, 'owner'::dojo_role))
WITH CHECK (public.has_dojo_role(auth.uid(), dojo_id, 'owner'::dojo_role));

CREATE POLICY "memberships admin manage non owner"
ON public.dojo_memberships
FOR ALL
TO authenticated
USING (
  public.has_dojo_role(auth.uid(), dojo_id, 'admin'::dojo_role)
  AND role <> 'owner'::dojo_role
)
WITH CHECK (
  public.has_dojo_role(auth.uid(), dojo_id, 'admin'::dojo_role)
  AND role <> 'owner'::dojo_role
);