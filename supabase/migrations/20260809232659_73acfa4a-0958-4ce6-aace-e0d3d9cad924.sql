-- 1) Fix mutable search_path on email queue helper functions (bodies are fully schema-qualified)
ALTER FUNCTION public.delete_email(text, bigint) SET search_path = '';
ALTER FUNCTION public.enqueue_email(text, jsonb) SET search_path = '';
ALTER FUNCTION public.move_to_dlq(text, text, bigint, jsonb) SET search_path = '';
ALTER FUNCTION public.read_email_batch(text, integer, integer) SET search_path = '';

-- 2) Remove anon direct SELECT on dojo_plans (public signup reads go through server functions)
DROP POLICY IF EXISTS "dojo_plans public read when dojo public" ON public.dojo_plans;
REVOKE SELECT ON public.dojo_plans FROM anon;