-- 1. Revoke EXECUTE on SECURITY DEFINER helpers from unauthenticated callers.
REVOKE EXECUTE ON FUNCTION public.claim_my_member_records() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.recompute_member_payment_statuses(uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_my_member_records() TO authenticated;

-- 2. Stripe/billing columns on dojos become staff-only (served via server fn
--    using the service role). Ordinary members keep access to safe columns.
REVOKE SELECT (stripe_account_id, stripe_charges_enabled, stripe_details_submitted, stripe_account_country)
  ON public.dojos FROM authenticated, anon;

-- 3. member_waivers inserts must be consistent with the member's own dojo.
DROP POLICY IF EXISTS "member_waivers insert own" ON public.member_waivers;
CREATE POLICY "member_waivers insert own"
  ON public.member_waivers FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.members m
      WHERE m.id = member_waivers.member_id
        AND m.user_id = auth.uid()
        AND m.dojo_id = member_waivers.dojo_id
    )
    AND (
      member_waivers.waiver_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.dojo_waivers w
        WHERE w.id = member_waivers.waiver_id
          AND w.dojo_id = member_waivers.dojo_id
      )
    )
  );