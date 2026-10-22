CREATE POLICY "dojos owner read own"
  ON public.dojos FOR SELECT TO authenticated
  USING (owner_user_id = auth.uid());

DROP FUNCTION IF EXISTS public.whoami();