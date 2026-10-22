CREATE OR REPLACE FUNCTION public.guard_member_self_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_auth_email text;
BEGIN
  -- System / server-side (service role, no JWT): allow.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Staff in the dojo can change anything
  IF public.is_dojo_staff(auth.uid(), NEW.dojo_id) THEN
    RETURN NEW;
  END IF;

  -- Claim branch: an unlinked member row may be claimed by the auth user whose
  -- email matches, and ONLY user_id may change.
  IF OLD.user_id IS NULL AND NEW.user_id = auth.uid() THEN
    SELECT lower(u.email) INTO v_auth_email FROM auth.users u WHERE u.id = auth.uid();
    IF v_auth_email IS NOT NULL
       AND NEW.email IS NOT NULL
       AND lower(NEW.email) = v_auth_email
       AND lower(coalesce(OLD.email,'')) = lower(coalesce(NEW.email,''))
    THEN
      IF (to_jsonb(NEW) - 'user_id' - 'updated_at') = (to_jsonb(OLD) - 'user_id' - 'updated_at') THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'Not allowed to claim this member record';
  END IF;

  -- Self-update: must be the member themselves AND only allowlisted fields may change
  IF auth.uid() = OLD.user_id AND NEW.user_id = OLD.user_id THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.dojo_id IS DISTINCT FROM OLD.dojo_id
       OR NEW.discipline IS DISTINCT FROM OLD.discipline
       OR NEW.belt_color IS DISTINCT FROM OLD.belt_color
       OR NEW.belt_label IS DISTINCT FROM OLD.belt_label
       OR NEW.stripes IS DISTINCT FROM OLD.stripes
       OR NEW.dan IS DISTINCT FROM OLD.dan
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.plan IS DISTINCT FROM OLD.plan
       OR NEW.joined_at IS DISTINCT FROM OLD.joined_at
       OR NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at
       OR NEW.payment_status IS DISTINCT FROM OLD.payment_status
       OR NEW.payment_status_updated_at IS DISTINCT FROM OLD.payment_status_updated_at
       OR NEW.selected_plan_id IS DISTINCT FROM OLD.selected_plan_id
       OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
       OR NEW.waiver_signed_at IS DISTINCT FROM OLD.waiver_signed_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'Members can only update their own contact info and cancellation notice';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Not allowed to update this member';
END;
$function$;

-- Server-side claim helper (callable by the signed-in member).
CREATE OR REPLACE FUNCTION public.claim_my_member_records()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
    SELECT id, dojo_id FROM public.members
     WHERE user_id IS NULL AND email IS NOT NULL AND lower(email) = v_email
  LOOP
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
$$;

GRANT EXECUTE ON FUNCTION public.claim_my_member_records() TO authenticated;

-- Backfill existing orphaned members.
ALTER TABLE public.members DISABLE TRIGGER members_guard_self_update;

UPDATE public.members m
   SET user_id = u.id,
       updated_at = now()
  FROM auth.users u
 WHERE m.user_id IS NULL
   AND m.email IS NOT NULL
   AND lower(m.email) = lower(u.email);

ALTER TABLE public.members ENABLE TRIGGER members_guard_self_update;

INSERT INTO public.dojo_memberships (user_id, dojo_id, role)
SELECT m.user_id, m.dojo_id, 'member'::public.dojo_role
  FROM public.members m
 WHERE m.user_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.dojo_memberships dm
      WHERE dm.user_id = m.user_id AND dm.dojo_id = m.dojo_id
   )
ON CONFLICT DO NOTHING;