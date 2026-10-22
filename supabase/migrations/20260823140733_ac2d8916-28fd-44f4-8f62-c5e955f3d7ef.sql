ALTER TABLE public.dojos ADD COLUMN IF NOT EXISTS logo_path text;

-- Anyone (including visitors on the public signup page) may read dojo logos.
CREATE POLICY "dojo_logos_read_all"
ON storage.objects FOR SELECT
TO anon, authenticated
USING (bucket_id = 'dojo-logos');

-- Only staff of the dojo (folder name = dojo id) may upload/replace/delete.
CREATE POLICY "dojo_logos_staff_insert"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'dojo-logos'
  AND public.is_dojo_staff(auth.uid(), NULLIF((storage.foldername(name))[1], '')::uuid)
);

CREATE POLICY "dojo_logos_staff_update"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'dojo-logos'
  AND public.is_dojo_staff(auth.uid(), NULLIF((storage.foldername(name))[1], '')::uuid)
)
WITH CHECK (
  bucket_id = 'dojo-logos'
  AND public.is_dojo_staff(auth.uid(), NULLIF((storage.foldername(name))[1], '')::uuid)
);

CREATE POLICY "dojo_logos_staff_delete"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'dojo-logos'
  AND public.is_dojo_staff(auth.uid(), NULLIF((storage.foldername(name))[1], '')::uuid)
);