ALTER TABLE public.dojos
  ADD COLUMN IF NOT EXISTS signup_free_days integer NOT NULL DEFAULT 0;

ALTER TABLE public.dojos
  ADD CONSTRAINT dojos_signup_free_days_range CHECK (signup_free_days >= 0 AND signup_free_days <= 90);

GRANT SELECT (signup_free_days) ON public.dojos TO authenticated, anon;

ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS free_trial_ends_at timestamptz;

CREATE OR REPLACE FUNCTION public.trial_check(_member_id uuid, _dojo_id uuid, _date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_free_days integer;
  v_free_end date;
BEGIN
  SELECT id, user_id, status, dojo_id, trial_started_at, free_trial_ends_at INTO v_member
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
         trial_length_days, coalesce(trial_classes_per_day, 1), trial_max_total_classes,
         coalesce(signup_free_days, 0)
    INTO v_tz, v_len, v_per_day, v_max_total, v_free_days
    FROM public.dojos WHERE id = coalesce(_dojo_id, v_member.dojo_id);

  v_tz := coalesce(v_tz, 'UTC');
  v_today := (now() AT TIME ZONE v_tz)::date;
  _date := coalesce(_date, v_today);

  -- SIGNUP FREE PERIOD (per-gym setting, off by default): a member who joined
  -- with a plan and a card gets FULL access for a fixed number of days from
  -- signup. No attendance clock, no per-day allowance, no total cap.
  IF v_member.free_trial_ends_at IS NOT NULL THEN
    v_free_end := (v_member.free_trial_ends_at AT TIME ZONE v_tz)::date;
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
    v_start := (v_member.free_trial_ends_at AT TIME ZONE v_tz)::date - greatest(coalesce(v_free_days, 1), 1);

    IF _date > v_free_end THEN
      v_reason := 'window_ended';
      v_msg := format('Your free period ended on %s.', to_char(v_free_end, 'DD Mon YYYY'));
    END IF;

    RETURN jsonb_build_object(
      'allowed', v_reason IS NULL,
      'reason', v_reason,
      'message', v_msg,
      'full_access', true,
      'is_trial', v_member.status = 'trial',
      'timezone', v_tz,
      'today', v_today,
      'start_date', v_start,
      'clock_started', true,
      'next_booked_date', NULL,
      'anchor_date', v_start,
      'bookable_until', v_free_end,
      'day_number', greatest(1, (_date - v_start) + 1),
      'length_days', greatest(coalesce(v_free_days, 1), 1),
      'per_day', NULL,
      'max_total', NULL,
      'ends_on', v_free_end,
      'days_left', greatest(0, (v_free_end - _date) + 1),
      'used_today', v_used_today,
      'used_total', v_used_total,
      'upcoming', v_upcoming
    );
  END IF;

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
    'full_access', false,
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
$function$;