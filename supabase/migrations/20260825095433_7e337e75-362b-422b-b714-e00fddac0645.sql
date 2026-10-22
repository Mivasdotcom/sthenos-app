-- FINDING 3 (completion): a column-level REVOKE cannot subtract from the
-- table-wide UPDATE grant authenticated already holds, so the Stripe columns
-- stayed writable. Drop the table-wide grant and re-grant only the columns the
-- app legitimately edits. Stripe connection state remains service-role only,
-- written solely by the Stripe webhook.
REVOKE UPDATE ON public.dojos FROM authenticated;

GRANT UPDATE (
  id,
  name,
  slug,
  owner_user_id,
  plan,
  created_at,
  updated_at,
  public_page_enabled,
  tagline,
  hero_image_url,
  hold_grace_days,
  contact_email,
  description,
  archived_at,
  default_currency,
  pass_platform_fee_to_members,
  country,
  collect_media_consent,
  family_pricing_mode,
  billing_day_of_month,
  timezone,
  price_change_notice_days,
  paused_members_can_book,
  logo_path,
  payment_methods,
  trial_class_allowance
) ON public.dojos TO authenticated;