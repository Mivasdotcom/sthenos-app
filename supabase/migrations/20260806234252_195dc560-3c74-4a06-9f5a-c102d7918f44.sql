-- A table-wide SELECT grant overrides column-level revokes, so replace it
-- with explicit per-column grants that exclude the Stripe/billing fields.
REVOKE SELECT ON public.dojos FROM authenticated;
REVOKE SELECT ON public.dojos FROM anon;

GRANT SELECT (
  id, name, slug, owner_user_id, plan, created_at, updated_at,
  public_page_enabled, tagline, hero_image_url, hold_grace_days,
  contact_email, description, archived_at, default_currency,
  pass_platform_fee_to_members, country
) ON public.dojos TO authenticated;