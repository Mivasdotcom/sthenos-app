-- 1. Trial policy on the dojo
ALTER TABLE public.dojos
  ADD COLUMN IF NOT EXISTS trial_length_days integer DEFAULT 7,
  ADD COLUMN IF NOT EXISTS trial_classes_per_day integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS trial_max_total_classes integer;

COMMENT ON COLUMN public.dojos.trial_length_days IS 'Length of the free trial in days from the first booked/attended class. 0 = no trial, NULL = no time limit.';
COMMENT ON COLUMN public.dojos.trial_classes_per_day IS 'Maximum free trial classes a member may book/attend per day.';
COMMENT ON COLUMN public.dojos.trial_max_total_classes IS 'Optional cap on total free trial classes. NULL = no total cap.';

-- Carry the old allowance across: N classes -> N days, 1/day, total cap N.
UPDATE public.dojos
   SET trial_length_days = CASE
         WHEN trial_class_allowance IS NULL THEN NULL
         ELSE trial_class_allowance
       END,
       trial_classes_per_day = 1,
       trial_max_total_classes = trial_class_allowance;

-- 2. Trial clock on the member
ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS trial_started_at date,
  ADD COLUMN IF NOT EXISTS trial_reminder_sent_at timestamptz;

COMMENT ON COLUMN public.members.trial_started_at IS 'Date of the member''s first booked or attended class; the trial window runs from here.';

-- Backfill from earliest existing activity so mid-trial members are not cut off.
UPDATE public.members m
   SET trial_started_at = s.first_date
  FROM (
    SELECT member_id, min(d) AS first_date FROM (
      SELECT member_id, (checked_in_at)::date AS d FROM public.attendances
      UNION ALL
      SELECT member_id, booked_for_date AS d FROM public.class_bookings
    ) x GROUP BY member_id
  ) s
 WHERE s.member_id = m.id AND m.trial_started_at IS NULL;

-- 3. Shared policy evaluation
CREATE OR REPLACE FUNCTION public.trial_check(_member_id uuid, _dojo_id uuid, _date date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member record;
  v_len integer;
  v_per_day integer;
  v_max_total integer;
  v_start date;
  v_first date;
  v_used_today integer;
  v_used_total integer;
  v_upcoming integer;
  v_day integer;
  v_ends date;
  v_reason text := NULL;
  v_msg text := NULL;
BEGIN
  SELECT id, user_id, status, dojo_id, trial_started_at INTO v_member
    FROM public.members WHERE id = _member_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'not_found', 'message', 'Member not found');
  END IF;

  IF auth.uid() IS NOT NULL
     AND v_member.user_id IS DISTINCT FROM auth.uid()
     AND NOT public.is_dojo_staff(auth.uid(), v_member.dojo_id) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  SELECT trial_length_days, coalesce(trial_classes_per_day, 1), trial_max_total_classes
    INTO v_len, v_per_day, v_max_total
    FROM public.dojos WHERE id = coalesce(_dojo_id, v_member.dojo_id);

  SELECT min(d) INTO v_first FROM (
    SELECT (checked_in_at)::date AS d FROM public.attendances WHERE member_id = _member_id
    UNION ALL
    SELECT booked_for_date AS d FROM public.class_bookings
      WHERE member_id = _member_id AND status <> 'no_show'
  ) x;

  v_start := coalesce(v_member.trial_started_at, v_first, _date);

  SELECT count(*) INTO v_used_today FROM (
    SELECT 1 FROM public.attendances
      WHERE member_id = _member_id AND (checked_in_at)::date = _date
    UNION ALL
    SELECT 1 FROM public.class_bookings
      WHERE member_id = _member_id AND booked_for_date = _date
        AND status IN ('booked','attended')
  ) y;

  SELECT count(*) INTO v_used_total FROM public.attendances WHERE member_id = _member_id;
  SELECT count(*) INTO v_upcoming FROM public.class_bookings
    WHERE member_id = _member_id AND status = 'booked' AND booked_for_date >= current_date;

  v_day := (_date - v_start) + 1;
  v_ends := CASE WHEN v_len IS NULL THEN NULL ELSE v_start + (greatest(v_len, 1) - 1) END;

  IF coalesce(v_len, 1) = 0 OR coalesce(v_max_total, 1) = 0 THEN
    v_reason := 'no_trial';
    v_msg := 'This gym does not include free trial classes.';
  ELSIF v_len IS NOT NULL AND _date > v_ends THEN
    v_reason := 'window_ended';
    v_msg := format('The %s-day free trial ended on %s.', v_len, to_char(v_ends, 'DD Mon YYYY'));
  ELSIF v_len IS NOT NULL AND _date < v_start THEN
    v_reason := 'before_start';
    v_msg := 'That date is before the trial started.';
  ELSIF v_used_today >= v_per_day THEN
    v_reason := 'day_limit';
    v_msg := format('A free trial allows %s class%s per day, and that day is already taken.',
                    v_per_day, CASE WHEN v_per_day = 1 THEN '' ELSE 'es' END);
  ELSIF v_max_total IS NOT NULL AND (v_used_total + v_upcoming) >= v_max_total THEN
    v_reason := 'total_cap';
    v_msg := format('All %s free trial classes have been used.', v_max_total);
  END IF;

  RETURN jsonb_build_object(
    'allowed', v_reason IS NULL,
    'reason', v_reason,
    'message', v_msg,
    'is_trial', v_member.status = 'trial',
    'start_date', v_start,
    'clock_started', (v_member.trial_started_at IS NOT NULL OR v_first IS NOT NULL),
    'day_number', greatest(v_day, 1),
    'length_days', v_len,
    'per_day', v_per_day,
    'max_total', v_max_total,
    'ends_on', v_ends,
    'used_today', v_used_today,
    'used_total', v_used_total,
    'upcoming', v_upcoming
  );
END;
$$;

REVOKE ALL ON FUNCTION public.trial_check(uuid, uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.trial_check(uuid, uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.trial_check(uuid, uuid, date) TO service_role;

-- 4. Enforcement on booking
CREATE OR REPLACE FUNCTION public.enforce_trial_allowance_booking()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status public.member_status;
  v_chk jsonb;
BEGIN
  SELECT status INTO v_status FROM public.members WHERE id = NEW.member_id;
  IF v_status IS DISTINCT FROM 'trial'::public.member_status THEN
    RETURN NEW;
  END IF;

  v_chk := public.trial_check(NEW.member_id, NEW.dojo_id, NEW.booked_for_date);
  IF NOT (v_chk->>'allowed')::boolean THEN
    RAISE EXCEPTION 'TRIAL_BLOCKED: %', coalesce(v_chk->>'message', 'Your free trial is finished.')
      USING HINT = 'Choose a plan to keep training.';
  END IF;

  UPDATE public.members
     SET trial_started_at = least(coalesce(trial_started_at, NEW.booked_for_date), NEW.booked_for_date),
         updated_at = now()
   WHERE id = NEW.member_id
     AND (trial_started_at IS NULL OR trial_started_at > NEW.booked_for_date);

  RETURN NEW;
END;
$$;

-- 5. Enforcement on staff check-in
CREATE OR REPLACE FUNCTION public.enforce_trial_allowance_attendance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status public.member_status;
  v_chk jsonb;
  v_date date;
BEGIN
  SELECT status INTO v_status FROM public.members WHERE id = NEW.member_id;
  IF v_status IS DISTINCT FROM 'trial'::public.member_status THEN
    NEW.trial_override_by := NULL;
    NEW.trial_override_at := NULL;
    NEW.trial_override_reason := NULL;
    RETURN NEW;
  END IF;

  v_date := coalesce(NEW.checked_in_at, now())::date;
  v_chk := public.trial_check(NEW.member_id, NEW.dojo_id, v_date);

  IF (v_chk->>'allowed')::boolean THEN
    NEW.trial_override_by := NULL;
    NEW.trial_override_at := NULL;
    NEW.trial_override_reason := NULL;
  ELSE
    IF NEW.trial_override_by IS NULL THEN
      RAISE EXCEPTION 'TRIAL_BLOCKED: %', coalesce(v_chk->>'message', 'This member''s free trial is finished.')
        USING HINT = 'Set them up on a plan, or override to allow this class.';
    END IF;
    IF NOT public.is_dojo_staff(NEW.trial_override_by, NEW.dojo_id) THEN
      RAISE EXCEPTION 'TRIAL_OVERRIDE_FORBIDDEN: only gym staff can allow an extra trial class.';
    END IF;
    NEW.trial_override_at := coalesce(NEW.trial_override_at, now());
  END IF;

  UPDATE public.members
     SET trial_started_at = least(coalesce(trial_started_at, v_date), v_date),
         updated_at = now()
   WHERE id = NEW.member_id
     AND (trial_started_at IS NULL OR trial_started_at > v_date);

  RETURN NEW;
END;
$$;
