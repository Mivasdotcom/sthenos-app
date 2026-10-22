DROP POLICY "dojos read own" ON public.dojos;
CREATE POLICY "dojos read own" ON public.dojos FOR SELECT USING (public.user_is_in_dojo(auth.uid(), id));