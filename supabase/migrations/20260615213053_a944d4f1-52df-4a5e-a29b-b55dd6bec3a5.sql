
-- Lock down SECURITY DEFINER functions: revoke broad EXECUTE and grant only to authenticated.
REVOKE EXECUTE ON FUNCTION public.is_staff(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_dojo_staff(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.user_in_dojo(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_dojo_role(uuid, uuid, public.dojo_role) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.user_is_in_dojo(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ensure_owner_member_row() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_member_status_change() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.is_staff(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_dojo_staff(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_in_dojo(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_dojo_role(uuid, uuid, public.dojo_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_is_in_dojo(uuid, uuid) TO authenticated;
