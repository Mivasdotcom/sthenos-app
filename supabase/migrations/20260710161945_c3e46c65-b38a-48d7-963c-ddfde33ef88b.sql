-- Fix 1: dojos.stripe_account_id must never be visible to anonymous public-page visitors.
-- The "dojos public read when enabled" RLS policy grants row visibility to anon; combined
-- with the column-level SELECT grant, anon could read stripe_account_id. Revoke that
-- column privilege while keeping the safe public columns readable.
REVOKE SELECT ON public.dojos FROM anon;
GRANT SELECT (
  id, name, slug, tagline, hero_image_url, description,
  contact_email, public_page_enabled, archived_at, plan, hold_grace_days,
  default_currency, created_at, updated_at
) ON public.dojos TO anon;

-- Fix 2: waiver_templates is a global, read-only starter library. Make write intent
-- explicit by adding restrictive policies that block INSERT/UPDATE/DELETE for anon and
-- authenticated roles; the service_role bypasses RLS and can still seed/update it.
CREATE POLICY "waiver_templates no writes anon/authenticated - insert"
  ON public.waiver_templates AS RESTRICTIVE
  FOR INSERT TO anon, authenticated
  WITH CHECK (false);

CREATE POLICY "waiver_templates no writes anon/authenticated - update"
  ON public.waiver_templates AS RESTRICTIVE
  FOR UPDATE TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "waiver_templates no writes anon/authenticated - delete"
  ON public.waiver_templates AS RESTRICTIVE
  FOR DELETE TO anon, authenticated
  USING (false);