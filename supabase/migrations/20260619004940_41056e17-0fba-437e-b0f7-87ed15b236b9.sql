-- Convert existing records created with the old role name to owner.
UPDATE public.dojo_memberships SET role = 'owner' WHERE role = 'manager';

-- Update access rules that previously checked for 'manager' to now check for 'owner'.
ALTER POLICY "dojos owner update" ON public.dojos
  USING (public.has_dojo_role(auth.uid(), id, 'owner'::public.dojo_role))
  WITH CHECK (public.has_dojo_role(auth.uid(), id, 'owner'::public.dojo_role));

ALTER POLICY "memberships owner manage" ON public.dojo_memberships
  USING (public.has_dojo_role(auth.uid(), dojo_id, 'owner'::public.dojo_role) OR public.has_dojo_role(auth.uid(), dojo_id, 'admin'::public.dojo_role))
  WITH CHECK (public.has_dojo_role(auth.uid(), dojo_id, 'owner'::public.dojo_role) OR public.has_dojo_role(auth.uid(), dojo_id, 'admin'::public.dojo_role));

ALTER POLICY "email_settings owner update in dojo" ON public.email_settings
  USING (public.has_dojo_role(auth.uid(), dojo_id, 'owner'::public.dojo_role));

ALTER POLICY "email_settings owner insert in dojo" ON public.email_settings
  WITH CHECK (public.has_dojo_role(auth.uid(), dojo_id, 'owner'::public.dojo_role));

ALTER POLICY "profiles read own or shared dojo staff" ON public.profiles
  USING ((auth.uid() = user_id) OR (EXISTS (
    SELECT 1 FROM public.dojo_memberships me
    JOIN public.dojo_memberships them ON them.dojo_id = me.dojo_id
    WHERE me.user_id = auth.uid()
      AND me.role = ANY (ARRAY['owner'::public.dojo_role, 'admin'::public.dojo_role, 'coach'::public.dojo_role])
      AND them.user_id = profiles.user_id
  )));

ALTER POLICY "classes manager manage in dojo" ON public.classes
  USING (public.has_dojo_role(auth.uid(), dojo_id, 'owner'::public.dojo_role))
  WITH CHECK (public.has_dojo_role(auth.uid(), dojo_id, 'owner'::public.dojo_role));