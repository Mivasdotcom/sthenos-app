DROP POLICY IF EXISTS "dojos public read when enabled" ON public.dojos;
REVOKE SELECT ON public.dojos FROM anon;