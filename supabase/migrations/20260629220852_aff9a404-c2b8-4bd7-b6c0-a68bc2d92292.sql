
-- Auto-link manager-invited members to their portal account on first sign-in.
-- When a new profile is created (via handle_new_user on auth signup), find any
-- members rows in any dojo with a matching email and no user_id yet, claim them,
-- and ensure a dojo_memberships row exists so the user can see the dojo on login.

CREATE OR REPLACE FUNCTION public.link_member_on_profile_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  m record;
BEGIN
  IF NEW.email IS NULL THEN
    RETURN NEW;
  END IF;

  FOR m IN
    SELECT id, dojo_id
    FROM public.members
    WHERE user_id IS NULL
      AND email IS NOT NULL
      AND lower(email) = lower(NEW.email)
  LOOP
    UPDATE public.members
       SET user_id = NEW.user_id,
           updated_at = now()
     WHERE id = m.id;

    -- Ensure a dojo membership exists. Don't override an existing role
    -- (e.g. owner/admin/coach assigned out-of-band).
    INSERT INTO public.dojo_memberships (user_id, dojo_id, role)
    VALUES (NEW.user_id, m.dojo_id, 'member'::public.dojo_role)
    ON CONFLICT DO NOTHING;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_link_member_on_profile_insert ON public.profiles;
CREATE TRIGGER trg_link_member_on_profile_insert
AFTER INSERT ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.link_member_on_profile_insert();

-- Backfill: link any existing members rows whose email matches an existing profile.
UPDATE public.members m
   SET user_id = p.user_id,
       updated_at = now()
  FROM public.profiles p
 WHERE m.user_id IS NULL
   AND m.email IS NOT NULL
   AND p.email IS NOT NULL
   AND lower(m.email) = lower(p.email);

-- Ensure dojo memberships for those backfilled rows (member role by default,
-- skip if a membership already exists in that dojo for the user).
INSERT INTO public.dojo_memberships (user_id, dojo_id, role)
SELECT DISTINCT m.user_id, m.dojo_id, 'member'::public.dojo_role
  FROM public.members m
 WHERE m.user_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.dojo_memberships dm
      WHERE dm.user_id = m.user_id AND dm.dojo_id = m.dojo_id
   )
ON CONFLICT DO NOTHING;
