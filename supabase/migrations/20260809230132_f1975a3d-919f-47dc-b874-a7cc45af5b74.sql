CREATE OR REPLACE FUNCTION public.set_my_media_consent(p_member_id uuid, p_consent boolean)
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
     SET media_consent = coalesce(p_consent, false),
         media_consent_at = now(),
         updated_at = now()
   WHERE id = p_member_id
   RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.set_my_media_consent(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_my_media_consent(uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_my_media_consent(uuid, boolean) TO authenticated;