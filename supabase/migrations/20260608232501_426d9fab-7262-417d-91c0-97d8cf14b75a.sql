
-- 1. Restrict membership self-join to dojos with public signup enabled
DROP POLICY IF EXISTS "memberships self join pending" ON public.dojo_memberships;
CREATE POLICY "memberships self join pending"
ON public.dojo_memberships
FOR INSERT
TO authenticated
WITH CHECK (
  user_id = auth.uid()
  AND role = 'pending'::dojo_role
  AND EXISTS (
    SELECT 1 FROM public.dojos d
    WHERE d.id = dojo_id AND d.public_page_enabled = true
  )
);

-- 2. Add ownership-checked INSERT policy on member_waivers
DROP POLICY IF EXISTS "member_waivers insert own" ON public.member_waivers;
CREATE POLICY "member_waivers insert own"
ON public.member_waivers
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.members m
    WHERE m.id = member_waivers.member_id
      AND m.user_id = auth.uid()
  )
);

-- 3. Lock down SECURITY DEFINER helpers — revoke from PUBLIC/anon, grant to authenticated only
REVOKE EXECUTE ON FUNCTION public.is_dojo_staff(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_dojo_role(uuid, uuid, dojo_role) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.user_in_dojo(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.user_is_in_dojo(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.ensure_owner_member_row() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_staff(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, app_role) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.is_dojo_staff(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_dojo_role(uuid, uuid, dojo_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_in_dojo(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_is_in_dojo(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_staff(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated;
