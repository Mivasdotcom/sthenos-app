ALTER TABLE public.dojos
  ADD COLUMN IF NOT EXISTS trial_class_allowance integer DEFAULT 1;

COMMENT ON COLUMN public.dojos.trial_class_allowance IS 'Free classes a trial member may attend before choosing a plan. NULL = unlimited, 0 = no free trial.';

ALTER TABLE public.attendances
  ADD COLUMN IF NOT EXISTS trial_override_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS trial_override_at timestamptz,
  ADD COLUMN IF NOT EXISTS trial_override_reason text;

CREATE OR REPLACE FUNCTION public.enforce_trial_allowance_attendance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status public.member_status;
  v_allow integer;
  v_used integer;
BEGIN
  SELECT status INTO v_status FROM public.members WHERE id = NEW.member_id;
  IF v_status IS DISTINCT FROM 'trial'::public.member_status THEN
    NEW.trial_override_by := NULL;
    NEW.trial_override_at := NULL;
    NEW.trial_override_reason := NULL;
    RETURN NEW;
  END IF;

  SELECT trial_class_allowance INTO v_allow FROM public.dojos WHERE id = NEW.dojo_id;
  IF v_allow IS NULL THEN
    NEW.trial_override_by := NULL;
    NEW.trial_override_at := NULL;
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_used FROM public.attendances WHERE member_id = NEW.member_id;

  IF v_used < v_allow THEN
    NEW.trial_override_by := NULL;
    NEW.trial_override_at := NULL;
    NEW.trial_override_reason := NULL;
    RETURN NEW;
  END IF;

  IF NEW.trial_override_by IS NULL THEN
    RAISE EXCEPTION 'TRIAL_ALLOWANCE_EXCEEDED: this member has already used their % free trial class(es). Set them up on a plan, or override to allow this class.', v_allow;
  END IF;

  IF NOT public.is_dojo_staff(NEW.trial_override_by, NEW.dojo_id) THEN
    RAISE EXCEPTION 'TRIAL_OVERRIDE_FORBIDDEN: only gym staff can allow an extra trial class.';
  END IF;

  NEW.trial_override_at := coalesce(NEW.trial_override_at, now());
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS enforce_trial_allowance_attendance ON public.attendances;
CREATE TRIGGER enforce_trial_allowance_attendance
  BEFORE INSERT ON public.attendances
  FOR EACH ROW EXECUTE FUNCTION public.enforce_trial_allowance_attendance();

CREATE OR REPLACE FUNCTION public.enforce_trial_allowance_booking()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status public.member_status;
  v_allow integer;
  v_used integer;
BEGIN
  SELECT status INTO v_status FROM public.members WHERE id = NEW.member_id;
  IF v_status IS DISTINCT FROM 'trial'::public.member_status THEN
    RETURN NEW;
  END IF;

  SELECT trial_class_allowance INTO v_allow FROM public.dojos WHERE id = NEW.dojo_id;
  IF v_allow IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT
    (SELECT count(*) FROM public.attendances a WHERE a.member_id = NEW.member_id)
    + (SELECT count(*) FROM public.class_bookings b
        WHERE b.member_id = NEW.member_id
          AND b.status = 'booked'::public.class_booking_status
          AND b.booked_for_date >= current_date)
  INTO v_used;

  IF v_used >= v_allow THEN
    RAISE EXCEPTION 'TRIAL_ALLOWANCE_EXCEEDED: your % free trial class(es) are used up. Choose a plan to keep training.', v_allow;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS enforce_trial_allowance_booking ON public.class_bookings;
CREATE TRIGGER enforce_trial_allowance_booking
  BEFORE INSERT ON public.class_bookings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_trial_allowance_booking();

REVOKE ALL ON FUNCTION public.enforce_trial_allowance_attendance() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_trial_allowance_booking() FROM anon, authenticated;