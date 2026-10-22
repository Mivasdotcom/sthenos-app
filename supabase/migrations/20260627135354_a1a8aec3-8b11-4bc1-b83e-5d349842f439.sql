
CREATE OR REPLACE FUNCTION public.guard_member_self_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Staff in the dojo can change anything
  IF public.is_dojo_staff(auth.uid(), NEW.dojo_id) THEN
    RETURN NEW;
  END IF;

  -- Self-update: must be the member themselves AND only allowlisted fields may change
  IF auth.uid() IS NOT NULL AND auth.uid() = OLD.user_id AND NEW.user_id = OLD.user_id THEN
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
$$;

-- Re-assert the RLS policy so only the member's own row is writable by them
DROP POLICY IF EXISTS "members update own contact" ON public.members;
CREATE POLICY "members update own contact"
ON public.members
FOR UPDATE
TO authenticated
USING (auth.uid() IS NOT NULL AND auth.uid() = user_id)
WITH CHECK (auth.uid() IS NOT NULL AND auth.uid() = user_id);
