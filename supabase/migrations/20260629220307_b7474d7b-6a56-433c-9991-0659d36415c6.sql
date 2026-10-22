
-- 1. Add 'pending' to member_status enum
ALTER TYPE public.member_status ADD VALUE IF NOT EXISTS 'pending';

-- 2. Track signup source on members
ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS signup_source text;

-- 3. Dedup index on (dojo_id, lower(email)) for non-null emails
CREATE UNIQUE INDEX IF NOT EXISTS members_dojo_email_unique
  ON public.members (dojo_id, lower(email))
  WHERE email IS NOT NULL;

-- 4. Update guard_member_self_update to also allow 'signup_source' to remain unchanged (already covered by allowlist enforcement -- no change needed since field isn't on whitelist of mutable fields, but staff path is unaffected).

-- 5. Rewrite ensure_owner_member_row: align with current 'owner' role naming and add 'admin'/'coach'/'member' membership types.
CREATE OR REPLACE FUNCTION public.ensure_owner_member_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_email text;
  v_name text;
BEGIN
  -- Only auto-create a members row for staff roles (owner/admin/coach). 'member' role is created via signup/approval flow.
  IF NEW.role NOT IN ('owner','admin','coach') THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.members
    WHERE dojo_id = NEW.dojo_id AND user_id = NEW.user_id
  ) THEN
    RETURN NEW;
  END IF;

  SELECT email, display_name INTO v_email, v_name
  FROM public.profiles WHERE user_id = NEW.user_id;

  INSERT INTO public.members
    (dojo_id, user_id, name, email, discipline, plan, status, payment_status, signup_source)
  VALUES
    (NEW.dojo_id,
     NEW.user_id,
     COALESCE(v_name, split_part(COALESCE(v_email,'staff'),'@',1)),
     v_email,
     'BJJ',
     'Monthly'::public.plan_type,
     'active'::public.member_status,
     'current'::public.member_payment_status,
     'staff_auto')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$function$;

-- 6. Ensure trigger exists on dojo_memberships for this function
DROP TRIGGER IF EXISTS ensure_owner_member_row_trg ON public.dojo_memberships;
CREATE TRIGGER ensure_owner_member_row_trg
  AFTER INSERT OR UPDATE OF role ON public.dojo_memberships
  FOR EACH ROW EXECUTE FUNCTION public.ensure_owner_member_row();
