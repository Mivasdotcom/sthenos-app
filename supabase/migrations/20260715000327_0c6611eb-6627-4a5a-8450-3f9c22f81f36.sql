-- Fix 1: Tighten anon column grants on public.dojos to only the fields
-- actually needed by the public dojo page. Remove business/ops fields
-- (plan, hold_grace_days) from the anon-visible column set.
REVOKE SELECT ON public.dojos FROM anon;
GRANT SELECT (
  id, name, slug, tagline, hero_image_url, description,
  contact_email, public_page_enabled, archived_at,
  default_currency, created_at, updated_at
) ON public.dojos TO anon;

-- Fix 2: Scope waiver_templates by dojo. Add a nullable dojo_id column
-- (NULL = shared starter library) and rewrite the read policy so
-- owners/admins can only see shared templates or templates belonging
-- to a dojo they own/administer.
ALTER TABLE public.waiver_templates
  ADD COLUMN IF NOT EXISTS dojo_id uuid REFERENCES public.dojos(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS waiver_templates_dojo_id_idx
  ON public.waiver_templates(dojo_id);

DROP POLICY IF EXISTS "waiver_templates owner admin read" ON public.waiver_templates;

CREATE POLICY "waiver_templates scoped read"
ON public.waiver_templates
FOR SELECT
TO authenticated
USING (
  dojo_id IS NULL
  OR EXISTS (
    SELECT 1 FROM public.dojo_memberships dm
    WHERE dm.user_id = auth.uid()
      AND dm.dojo_id = waiver_templates.dojo_id
      AND dm.role IN ('owner','admin')
  )
);