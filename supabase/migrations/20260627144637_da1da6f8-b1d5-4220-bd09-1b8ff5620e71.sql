
-- 1) Revoke anonymous access to dojo contact_email
REVOKE SELECT (contact_email) ON public.dojos FROM anon;

-- 2) Lock down SECURITY DEFINER functions from anonymous execution
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_staff(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_staff(uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.has_dojo_role(uuid, uuid, dojo_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_dojo_role(uuid, uuid, dojo_role) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_dojo_staff(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_dojo_staff(uuid, uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.user_in_dojo(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_in_dojo(uuid, uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.user_is_in_dojo(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_is_in_dojo(uuid, uuid) TO authenticated, service_role;

-- Trigger-only functions: not meant to be invoked directly
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.guard_member_self_update() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_member_status_change() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ensure_owner_member_row() FROM PUBLIC, anon, authenticated;
