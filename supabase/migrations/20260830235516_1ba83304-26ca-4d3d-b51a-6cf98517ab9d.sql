CREATE OR REPLACE FUNCTION public.trial_check(_member_id uuid, _dojo_id uuid, _date date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member record;
  v_tz text;
  v_today date;
  v_len integer;
  v_per_day integer;
  v_max_total integer;
  v_start date;
  v_first date;
  v_next date;
  v_anchor date;
  v_bookable_until date;
  v_used_today integer;
  v_used_total integer;
  v_upcoming integer;
  v_day integer;
  v_ends date;
  v_days_left integer;
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

  SELECT coalesce(nullif(timezone, ''), 'UTC'),
         trial_length_days, coalesce(trial_classes_per_day, 1), trial_max_total_classes
    INTO v_tz, v_len, v_per_day, v_max_total
    FROM public.dojos WHERE id = coalesce(_dojo_id, v_member.dojo_id);

  v_tz := coalesce(v_tz, 'UTC');
  v_today := (now() AT TIME ZONE v_tz)::date;
  _date := coalesce(_date, v_today);

  -- The trial clock starts on the first class the member ATTENDED, in gym-local time.
  SELECT min((checked_in_at AT TIME ZONE v_tz)::date) INTO v_first
    FROM public.attendances WHERE member_id = _member_id;

  v_start := coalesce(v_member.trial_started_at, v_first);

  SELECT min(booked_for_date) INTO v_next
    FROM public.class_bookings
   WHERE member_id = _member_id AND status = 'booked' AND booked_for_date >= v_today;

  SELECT count(*) INTO v_used_today FROM (
    SELECT 1 FROM public.attendances
      WHERE member_id = _member_id AND (checked_in_at AT TIME ZONE v_tz)::date = _date
    UNION ALL
    SELECT 1 FROM public.class_bookings
      WHERE member_id = _member_id AND booked_for_date = _date
        AND status IN ('booked','attended')
  ) y;

  SELECT count(*) INTO v_used_total FROM public.attendances WHERE member_id = _member_id;
  SELECT count(*) INTO v_upcoming FROM public.class_bookings
    WHERE member_id = _member_id AND status = 'booked' AND booked_for_date >= v_today;

  IF v_start IS NULL OR v_len IS NULL THEN
    v_ends := NULL;
  ELSE
    v_ends := v_start + (greatest(v_len, 1) - 1);
  END IF;

  -- ONE window: anchored to the first ATTENDED class, or provisionally to the
  -- earliest class already booked, or today. Bookings and check-ins both use it.
  v_anchor := coalesce(v_start, v_next, v_today);
  v_bookable_until := CASE WHEN v_len IS NULL THEN NULL
                           ELSE v_anchor + (greatest(v_len, 1) - 1) END;

  -- Day number and days remaining come from the same start date, so they agree.
  v_day := CASE WHEN v_start IS NULL THEN 0 ELSE (_date - v_start) + 1 END;
  v_days_left := CASE WHEN v_ends IS NULL THEN NULL ELSE greatest(0, (v_ends - _date) + 1) END;

  IF coalesce(v_len, 1) = 0 OR coalesce(v_max_total, 1) = 0 THEN
    v_reason := 'no_trial';
    v_msg := 'This gym does not include free trial classes.';
  ELSIF v_ends IS NOT NULL AND _date > v_ends THEN
    v_reason := 'window_ended';
    v_msg := format('The %s-day free trial ended on %s.', v_len, to_char(v_ends, 'DD Mon YYYY'));
  ELSIF v_bookable_until IS NOT NULL AND _date > v_bookable_until THEN
    v_reason := 'outside_window';
    v_msg := format('A %s-day free trial runs to %s, so that class falls outside it.',
                    v_len, to_char(v_bookable_until, 'DD Mon YYYY'));
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
    'timezone', v_tz,
    'today', v_today,
    'start_date', v_start,
    'clock_started', v_start IS NOT NULL,
    'next_booked_date', v_next,
    'anchor_date', v_anchor,
    'bookable_until', v_bookable_until,
    'day_number', v_day,
    'length_days', v_len,
    'per_day', v_per_day,
    'max_total', v_max_total,
    'ends_on', v_ends,
    'days_left', v_days_left,
    'used_today', v_used_today,
    'used_total', v_used_total,
    'upcoming', v_upcoming
  );
END;
$$;

REVOKE ALL ON FUNCTION public.trial_check(uuid, uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.trial_check(uuid, uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.trial_check(uuid, uuid, date) TO service_role;

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

  RETURN NEW;
END;
$$;