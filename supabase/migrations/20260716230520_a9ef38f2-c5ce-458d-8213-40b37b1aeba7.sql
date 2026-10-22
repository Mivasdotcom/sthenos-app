-- 1. Column-level restrictions for anon on dojos / dojo_plans
REVOKE SELECT ON public.dojos FROM anon;
GRANT SELECT (
  id, name, slug, tagline, description, hero_image_url,
  contact_email, default_currency, public_page_enabled
) ON public.dojos TO anon;

REVOKE SELECT ON public.dojo_plans FROM anon;
GRANT SELECT (
  id, dojo_id, name, description, price_cents, currency,
  interval, is_active, sort_order
) ON public.dojo_plans TO anon;

-- 2. Revoke public execute on internal email queue helpers
REVOKE EXECUTE ON FUNCTION public.delete_email(text, bigint) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enqueue_email(text, jsonb) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.move_to_dlq(text, text, bigint, jsonb) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.read_email_batch(text, integer, integer) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.email_queue_dispatch() FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.email_queue_wake() FROM anon, authenticated, PUBLIC;

-- 3. Lock down search_path on the four helpers still missing it.
ALTER FUNCTION public.delete_email(text, bigint) SET search_path = '';
ALTER FUNCTION public.enqueue_email(text, jsonb) SET search_path = '';
ALTER FUNCTION public.move_to_dlq(text, text, bigint, jsonb) SET search_path = '';
ALTER FUNCTION public.read_email_batch(text, integer, integer) SET search_path = '';