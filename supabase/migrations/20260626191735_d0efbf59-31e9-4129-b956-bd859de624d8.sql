
-- Fix 1: email_settings UPDATE policy - align USING and WITH CHECK to 'owner'
DROP POLICY IF EXISTS "email_settings owner update" ON public.email_settings;
CREATE POLICY "email_settings owner update" ON public.email_settings
  FOR UPDATE
  USING (public.has_dojo_role(auth.uid(), dojo_id, 'owner'))
  WITH CHECK (public.has_dojo_role(auth.uid(), dojo_id, 'owner'));

-- Fix 2: is_dojo_staff should include 'owner'
CREATE OR REPLACE FUNCTION public.is_dojo_staff(_user_id uuid, _dojo_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.dojo_memberships
    WHERE user_id = _user_id
      AND dojo_id = _dojo_id
      AND role IN ('owner','manager','admin','coach')
  )
$function$;

-- Fix 3: waiver_templates - restrict read to authenticated only
DROP POLICY IF EXISTS "waiver_templates read" ON public.waiver_templates;
DROP POLICY IF EXISTS "waiver templates read" ON public.waiver_templates;
DROP POLICY IF EXISTS "Waiver templates are publicly readable" ON public.waiver_templates;
REVOKE SELECT ON public.waiver_templates FROM anon;
CREATE POLICY "waiver_templates authenticated read" ON public.waiver_templates
  FOR SELECT
  TO authenticated
  USING (true);
