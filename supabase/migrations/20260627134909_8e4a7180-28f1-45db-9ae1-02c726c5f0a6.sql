
ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS cancellation_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancellation_reason text;

-- Trigger: when a non-staff user updates their own member row, only allow
-- changes to a small whitelist of fields. Staff bypass this check.
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

  -- For self-updates by the member themselves, lock all sensitive fields
  IF auth.uid() IS NOT NULL AND auth.uid() = OLD.user_id THEN
    IF NEW.dojo_id IS DISTINCT FROM OLD.dojo_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.discipline IS DISTINCT FROM OLD.discipline
       OR NEW.belt_color IS DISTINCT FROM OLD.belt_color
       OR NEW.belt_label IS DISTINCT FROM OLD.belt_label
       OR NEW.stripes IS DISTINCT FROM OLD.stripes
       OR NEW.dan IS DISTINCT FROM OLD.dan
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.plan IS DISTINCT FROM OLD.plan
       OR NEW.joined_at IS DISTINCT FROM OLD.joined_at
       OR NEW.payment_status IS DISTINCT FROM OLD.payment_status
       OR NEW.selected_plan_id IS DISTINCT FROM OLD.selected_plan_id
       OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
       OR NEW.waiver_signed_at IS DISTINCT FROM OLD.waiver_signed_at
       OR NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at
    THEN
      RAISE EXCEPTION 'Members can only update their own contact info and cancellation notice';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Not allowed to update this member';
END;
$$;

DROP TRIGGER IF EXISTS members_guard_self_update ON public.members;
CREATE TRIGGER members_guard_self_update
BEFORE UPDATE ON public.members
FOR EACH ROW EXECUTE FUNCTION public.guard_member_self_update();

DROP POLICY IF EXISTS "members update own contact" ON public.members;
CREATE POLICY "members update own contact"
ON public.members
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id AND public.user_is_in_dojo(auth.uid(), dojo_id))
WITH CHECK (auth.uid() = user_id AND public.user_is_in_dojo(auth.uid(), dojo_id));
