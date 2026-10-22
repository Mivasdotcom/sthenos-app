ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS partner_matching_opt_in boolean NOT NULL DEFAULT false;

ALTER TABLE public.dojos
  ADD COLUMN IF NOT EXISTS partner_matching_enabled boolean NOT NULL DEFAULT true;

GRANT SELECT (partner_matching_enabled) ON public.dojos TO authenticated;
GRANT SELECT (partner_matching_opt_in) ON public.members TO authenticated;

CREATE OR REPLACE FUNCTION public.set_my_partner_matching(p_member_id uuid, p_opt_in boolean)
RETURNS public.members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.members;
BEGIN
  UPDATE public.members
     SET partner_matching_opt_in = p_opt_in,
         updated_at = now()
   WHERE id = p_member_id
     AND user_id = auth.uid()
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Not your member record';
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.set_my_partner_matching(uuid, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.set_my_partner_matching(uuid, boolean) TO authenticated;