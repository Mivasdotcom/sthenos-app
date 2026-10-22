CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM anon, authenticated;
GRANT USAGE ON SCHEMA private TO anon, authenticated;

CREATE OR REPLACE FUNCTION private.dojo_page_is_public(_dojo_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.dojos d WHERE d.id = _dojo_id AND d.public_page_enabled = true)
$$;
REVOKE ALL ON FUNCTION private.dojo_page_is_public(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.dojo_page_is_public(uuid) TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "dojo_logos_public_page_read" ON storage.objects;
CREATE POLICY "dojo_logos_public_page_read" ON storage.objects
FOR SELECT TO anon, authenticated
USING (
  bucket_id = 'dojo-logos'
  AND private.dojo_page_is_public((NULLIF((storage.foldername(name))[1], ''))::uuid)
);

DROP FUNCTION IF EXISTS public.dojo_page_is_public(uuid);