REVOKE SELECT ON public.dojos FROM authenticated;
REVOKE SELECT ON public.dojos FROM anon;

GRANT SELECT (
  id, name, slug, owner_user_id, plan, created_at, updated_at,
  public_page_enabled, tagline, hero_image_url, hold_grace_days,
  contact_email, description, archived_at, default_currency,
  pass_platform_fee_to_members, country, collect_media_consent,
  family_pricing_mode
) ON public.dojos TO authenticated;

GRANT SELECT (
  id, name, slug, plan, created_at, updated_at,
  public_page_enabled, tagline, hero_image_url,
  contact_email, description, archived_at, default_currency,
  pass_platform_fee_to_members, country, collect_media_consent,
  family_pricing_mode
) ON public.dojos TO anon;

GRANT ALL ON public.dojos TO service_role;