CREATE OR REPLACE FUNCTION public.member_email_drift(_dojo_id uuid)
RETURNS TABLE(member_id uuid, member_name text, member_email text, login_email text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT m.id, m.name, m.email, u.email::text
    FROM public.members m
    JOIN auth.users u ON u.id = m.user_id
   WHERE m.dojo_id = _dojo_id
     AND public.is_dojo_staff(auth.uid(), _dojo_id)
     AND m.email IS NOT NULL
     AND u.email IS NOT NULL
     AND lower(m.email) <> lower(u.email)
   ORDER BY m.name
$$;

REVOKE ALL ON FUNCTION public.member_email_drift(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.member_email_drift(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.member_email_drift(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.member_login_email(_member_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT u.email::text
    FROM public.members m
    JOIN auth.users u ON u.id = m.user_id
   WHERE m.id = _member_id
     AND (public.is_dojo_staff(auth.uid(), m.dojo_id) OR m.user_id = auth.uid())
$$;

REVOKE ALL ON FUNCTION public.member_login_email(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.member_login_email(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.member_login_email(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.update_my_contact(p_member_id uuid, p_name text, p_email text, p_phone text, p_marketing_opt_out boolean)
 RETURNS members
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.members;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_row FROM public.members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Member not found';
  END IF;
  IF v_row.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF p_name IS NULL OR length(btrim(p_name)) = 0 THEN
    RAISE EXCEPTION 'Name is required';
  END IF;
  IF length(p_name) > 200 THEN
    RAISE EXCEPTION 'Name too long';
  END IF;
  IF p_phone IS NOT NULL AND length(p_phone) > 50 THEN
    RAISE EXCEPTION 'Phone too long';
  END IF;

  -- Email changes must keep the login address and Stripe customer in step, so
  -- they are only allowed through the dedicated synced change flow.
  IF lower(coalesce(btrim(p_email), '')) IS DISTINCT FROM lower(coalesce(v_row.email, '')) THEN
    RAISE EXCEPTION 'Email changes must go through the email change flow';
  END IF;

  UPDATE public.members
     SET name = btrim(p_name),
         phone = NULLIF(btrim(coalesce(p_phone,'')), ''),
         marketing_opt_out = coalesce(p_marketing_opt_out, false),
         updated_at = now()
   WHERE id = p_member_id
   RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;