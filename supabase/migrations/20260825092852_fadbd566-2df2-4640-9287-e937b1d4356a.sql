CREATE OR REPLACE FUNCTION public.claim_my_member_records()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_email text;
  v_count integer := 0;
  m record;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  SELECT lower(email) INTO v_email FROM auth.users WHERE id = auth.uid();
  IF v_email IS NULL THEN
    RETURN 0;
  END IF;

  FOR m IN
    SELECT DISTINCT ON (dojo_id) id, dojo_id
      FROM public.members
     WHERE user_id IS NULL AND email IS NOT NULL AND lower(email) = v_email
     ORDER BY dojo_id, created_at
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.members
       WHERE user_id = auth.uid() AND dojo_id = m.dojo_id
    ) THEN
      CONTINUE;
    END IF;

    UPDATE public.members
       SET user_id = auth.uid(), updated_at = now()
     WHERE id = m.id AND user_id IS NULL;
    v_count := v_count + 1;

    INSERT INTO public.dojo_memberships (user_id, dojo_id, role)
    VALUES (auth.uid(), m.dojo_id, 'member'::public.dojo_role)
    ON CONFLICT DO NOTHING;
  END LOOP;

  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.link_member_on_profile_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  m record;
BEGIN
  IF NEW.email IS NULL THEN
    RETURN NEW;
  END IF;

  FOR m IN
    SELECT DISTINCT ON (dojo_id) id, dojo_id
      FROM public.members
     WHERE user_id IS NULL
       AND email IS NOT NULL
       AND lower(email) = lower(NEW.email)
     ORDER BY dojo_id, created_at
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.members
       WHERE user_id = NEW.user_id AND dojo_id = m.dojo_id
    ) THEN
      CONTINUE;
    END IF;

    UPDATE public.members
       SET user_id = NEW.user_id,
           updated_at = now()
     WHERE id = m.id AND user_id IS NULL;

    -- Ensure a dojo membership exists. Don't override an existing role
    -- (e.g. owner/admin/coach assigned out-of-band).
    INSERT INTO public.dojo_memberships (user_id, dojo_id, role)
    VALUES (NEW.user_id, m.dojo_id, 'member'::public.dojo_role)
    ON CONFLICT DO NOTHING;
  END LOOP;

  RETURN NEW;
END;
$function$;