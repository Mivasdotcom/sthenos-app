-- platform_subscriptions is written exclusively by trusted server code using the
-- service role (Stripe webhooks and billing server functions), which bypasses RLS.
-- Previously only a SELECT policy existed, so a client-side write silently
-- affected zero rows. These explicit deny policies make such a write fail loudly.
COMMENT ON TABLE public.platform_subscriptions IS
  'Platform (Sthenos) billing subscriptions per dojo. Writes are SERVICE-ROLE ONLY (Stripe webhooks / server functions). Client-side inserts, updates and deletes are explicitly denied by RLS.';

DROP POLICY IF EXISTS "No client inserts on platform subscriptions" ON public.platform_subscriptions;
CREATE POLICY "No client inserts on platform subscriptions"
  ON public.platform_subscriptions FOR INSERT TO authenticated, anon
  WITH CHECK (false);

DROP POLICY IF EXISTS "No client updates on platform subscriptions" ON public.platform_subscriptions;
CREATE POLICY "No client updates on platform subscriptions"
  ON public.platform_subscriptions FOR UPDATE TO authenticated, anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "No client deletes on platform subscriptions" ON public.platform_subscriptions;
CREATE POLICY "No client deletes on platform subscriptions"
  ON public.platform_subscriptions FOR DELETE TO authenticated, anon
  USING (false);