
-- 1. Scope classes management policy to authenticated only
DROP POLICY IF EXISTS "classes manager manage in dojo" ON public.classes;
CREATE POLICY "classes manager manage in dojo"
ON public.classes
FOR ALL
TO authenticated
USING (has_dojo_role(auth.uid(), dojo_id, 'manager'::dojo_role))
WITH CHECK (has_dojo_role(auth.uid(), dojo_id, 'manager'::dojo_role));

-- 2. Hide internal stripe_price_id from anonymous users (column-level)
REVOKE SELECT ON public.dojo_plans FROM anon;
GRANT SELECT (id, dojo_id, name, description, price_cents, currency, interval,
              is_active, sort_order, created_at, updated_at) ON public.dojo_plans TO anon;

-- 3. Prevent privilege escalation: managers cannot grant 'manager' app_role via client.
--    Role grants of 'manager' must be performed server-side using service role.
DROP POLICY IF EXISTS "user_roles owner insert" ON public.user_roles;
DROP POLICY IF EXISTS "user_roles owner manage" ON public.user_roles;

CREATE POLICY "user_roles managers insert non-manager"
ON public.user_roles
FOR INSERT
TO authenticated
WITH CHECK (
  has_role(auth.uid(), 'manager'::app_role)
  AND role <> 'manager'::app_role
);

CREATE POLICY "user_roles managers update non-manager"
ON public.user_roles
FOR UPDATE
TO authenticated
USING (has_role(auth.uid(), 'manager'::app_role) AND role <> 'manager'::app_role)
WITH CHECK (has_role(auth.uid(), 'manager'::app_role) AND role <> 'manager'::app_role);

CREATE POLICY "user_roles managers delete non-manager"
ON public.user_roles
FOR DELETE
TO authenticated
USING (has_role(auth.uid(), 'manager'::app_role) AND role <> 'manager'::app_role);
