-- FINDING 1: dojo_logos_public_page_function_dependency
-- The helper behind the public logo rule is verified to check public_page_enabled,
-- and is tightened so archived gyms stop serving logos publicly (the public gym
-- page lookup already treats archived gyms as gone).
CREATE OR REPLACE FUNCTION private.dojo_page_is_public(_dojo_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.dojos d
    WHERE d.id = _dojo_id
      AND d.public_page_enabled = true
      AND d.archived_at IS NULL
  )
$function$;

COMMENT ON FUNCTION private.dojo_page_is_public(uuid) IS
  'Public-page gate for storage read policies. Returns true only for a live (non-archived) gym with public_page_enabled = true. Execute is granted to anon/authenticated only; do not widen.';

-- FINDING 2: dojo_memberships_admin_role_column_check
-- Admins could promote any non-owner row to admin, minting fellow admins. The app
-- only ever exposes role changes to owners, so admins are scoped to non-staff-
-- granting rows: they may manage coach/member/pending rows and may never write
-- role = 'admin' or 'owner'. Owners keep unrestricted control via their own policy.
DROP POLICY IF EXISTS "memberships admin manage non owner" ON public.dojo_memberships;

CREATE POLICY "memberships admin manage non staff"
ON public.dojo_memberships
FOR ALL
TO authenticated
USING (
  has_dojo_role(auth.uid(), dojo_id, 'admin'::dojo_role)
  AND role IN ('coach'::dojo_role, 'member'::dojo_role, 'pending'::dojo_role)
)
WITH CHECK (
  has_dojo_role(auth.uid(), dojo_id, 'admin'::dojo_role)
  AND role IN ('coach'::dojo_role, 'member'::dojo_role, 'pending'::dojo_role)
);

-- FINDING 3: dojos_stripe_account_id_no_deny_policy
-- Reads of the Stripe account identifier are already withheld from anon and
-- authenticated at column level, but every signed-in role could still WRITE the
-- Stripe columns, letting an owner repoint payouts at another Stripe account.
-- Stripe state is owned by the webhook/service role only.
REVOKE UPDATE (
  stripe_account_id,
  stripe_charges_enabled,
  stripe_details_submitted,
  stripe_account_country
) ON public.dojos FROM authenticated;

-- anon has no update policy on dojos and must never write gym rows at all.
REVOKE UPDATE ON public.dojos FROM anon;

-- Non-sensitive gym settings that staff-gated features read back through the
-- user's own session. These carry no Stripe secrets and stay row-gated by RLS.
GRANT SELECT (trial_class_allowance, payment_methods) ON public.dojos TO authenticated;

COMMENT ON COLUMN public.dojos.stripe_account_id IS
  'Stripe Connect account id. Service-role only: no SELECT or UPDATE grant to anon/authenticated. Read it through a staff-gated server function, never from the browser.';