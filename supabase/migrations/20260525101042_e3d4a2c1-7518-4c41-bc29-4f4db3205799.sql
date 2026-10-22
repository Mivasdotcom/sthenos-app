
-- Fix email_settings overly permissive policies (owner only)
DROP POLICY IF EXISTS "auth read email_settings" ON public.email_settings;
DROP POLICY IF EXISTS "auth update email_settings" ON public.email_settings;

CREATE POLICY "email_settings staff read"
ON public.email_settings FOR SELECT TO authenticated
USING (public.is_staff(auth.uid()));

CREATE POLICY "email_settings owner update"
ON public.email_settings FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'owner'))
WITH CHECK (public.has_role(auth.uid(), 'owner'));

-- Harden user_roles: add an explicit INSERT policy requiring owner role
-- (prevents reliance solely on the ALL policy)
CREATE POLICY "user_roles owner insert"
ON public.user_roles FOR INSERT TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'owner'));

-- Revoke EXECUTE on SECURITY DEFINER functions from anon/authenticated.
-- These are intended for internal use by RLS policies / triggers only;
-- Postgres still evaluates them inside policies regardless of grants.
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.is_staff(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated;
