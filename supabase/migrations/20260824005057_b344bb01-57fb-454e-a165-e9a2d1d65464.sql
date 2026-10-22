DROP POLICY IF EXISTS "dojos read own" ON public.dojos;
CREATE POLICY "dojos read own"
ON public.dojos
FOR SELECT
TO authenticated
USING (public.user_is_in_dojo(auth.uid(), id));