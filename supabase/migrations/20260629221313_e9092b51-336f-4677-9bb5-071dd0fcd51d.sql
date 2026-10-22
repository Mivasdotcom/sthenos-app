
-- 1) Remove the over-broad self-update policy on members.
DROP POLICY IF EXISTS "members update own contact" ON public.members;

-- 2) Narrow RPCs for member self-service. SECURITY DEFINER + strict ownership check.

CREATE OR REPLACE FUNCTION public.update_my_contact(
  p_member_id uuid,
  p_name text,
  p_email text,
  p_phone text,
  p_marketing_opt_out boolean
)
RETURNS public.members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  IF p_email IS NOT NULL AND length(p_email) > 320 THEN
    RAISE EXCEPTION 'Email too long';
  END IF;
  IF p_phone IS NOT NULL AND length(p_phone) > 50 THEN
    RAISE EXCEPTION 'Phone too long';
  END IF;

  UPDATE public.members
     SET name = btrim(p_name),
         email = NULLIF(btrim(coalesce(p_email,'')), ''),
         phone = NULLIF(btrim(coalesce(p_phone,'')), ''),
         marketing_opt_out = coalesce(p_marketing_opt_out, false),
         updated_at = now()
   WHERE id = p_member_id
   RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.update_my_contact(uuid, text, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_my_contact(uuid, text, text, text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.request_my_cancellation(
  p_member_id uuid,
  p_reason text
)
RETURNS public.members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.members;
  v_reason text;
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

  v_reason := NULLIF(btrim(coalesce(p_reason,'')), '');
  IF v_reason IS NOT NULL AND length(v_reason) > 2000 THEN
    RAISE EXCEPTION 'Reason too long';
  END IF;

  UPDATE public.members
     SET cancellation_requested_at = now(),
         cancellation_reason = v_reason,
         updated_at = now()
   WHERE id = p_member_id
   RETURNING * INTO v_row;

  INSERT INTO public.cancellation_audit_log
    (member_id, dojo_id, action, reason, actor_user_id)
  VALUES
    (v_row.id, v_row.dojo_id, 'requested', v_reason, auth.uid());

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.request_my_cancellation(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_my_cancellation(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.withdraw_my_cancellation(
  p_member_id uuid
)
RETURNS public.members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  UPDATE public.members
     SET cancellation_requested_at = NULL,
         cancellation_reason = NULL,
         updated_at = now()
   WHERE id = p_member_id
   RETURNING * INTO v_row;

  INSERT INTO public.cancellation_audit_log
    (member_id, dojo_id, action, reason, actor_user_id)
  VALUES
    (v_row.id, v_row.dojo_id, 'withdrawn', NULL, auth.uid());

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.withdraw_my_cancellation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.withdraw_my_cancellation(uuid) TO authenticated;

-- 3) Waiver templates: scope reads to staff only.
DROP POLICY IF EXISTS "waiver_templates authenticated read" ON public.waiver_templates;

CREATE POLICY "waiver_templates staff read"
ON public.waiver_templates
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.dojo_memberships dm
    WHERE dm.user_id = auth.uid()
      AND dm.role IN ('owner','manager','admin','coach')
  )
);
