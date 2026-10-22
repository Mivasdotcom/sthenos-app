-- Evidence-based payment status recompute. Replaces the old
-- "local period_end is in the past = overdue" inference, which marked paid
-- members overdue whenever member_subscriptions rows went stale.
CREATE OR REPLACE FUNCTION public.recompute_member_payment_statuses(_dojo_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_changed integer := 0;
  m record;
  v_has_active_sub boolean;
  v_has_bad_sub boolean;
  v_last_paid timestamptz;
  v_last_failed timestamptz;
  v_new public.member_payment_status;
BEGIN
  FOR m IN
    SELECT id, dojo_id, payment_status
      FROM public.members
     WHERE (_dojo_id IS NULL OR dojo_id = _dojo_id)
       AND plan_covered_by IS NULL
       AND status IN ('active','trial')
  LOOP
    SELECT EXISTS (
             SELECT 1 FROM public.member_subscriptions s
              WHERE s.member_id = m.id AND s.status IN ('active','trialing')
           ),
           EXISTS (
             SELECT 1 FROM public.member_subscriptions s
              WHERE s.member_id = m.id AND s.status IN ('past_due','unpaid','incomplete')
           )
      INTO v_has_active_sub, v_has_bad_sub;

    SELECT max(coalesce(i.paid_at, i.updated_at))
      INTO v_last_paid
      FROM public.invoices i
     WHERE i.member_id = m.id AND i.status = 'paid';

    SELECT max(i.updated_at)
      INTO v_last_failed
      FROM public.invoices i
     WHERE i.member_id = m.id AND i.status = 'overdue';

    v_new := NULL;

    IF v_has_bad_sub AND (v_last_paid IS NULL OR v_last_failed IS NULL OR v_last_failed >= v_last_paid) THEN
      v_new := 'overdue';
    ELSIF v_has_active_sub THEN
      -- Active/trialing subscription: never downgrade.
      v_new := 'current';
    ELSIF v_last_failed IS NOT NULL AND (v_last_paid IS NULL OR v_last_failed > v_last_paid) THEN
      v_new := 'overdue';
    ELSIF v_last_paid IS NOT NULL AND v_last_paid > now() - interval '40 days' THEN
      v_new := 'current';
    END IF;

    IF v_new IS NOT NULL AND v_new IS DISTINCT FROM m.payment_status THEN
      UPDATE public.members
         SET payment_status = v_new,
             payment_status_updated_at = now(),
             updated_at = now()
       WHERE id = m.id;
      v_changed := v_changed + 1;
    END IF;
  END LOOP;

  RETURN v_changed;
END;
$$;

-- The nightly sweep now delegates to the evidence-based recompute instead of
-- inferring overdue from a possibly stale local current_period_end.
CREATE OR REPLACE FUNCTION public.enforce_overdue_grace()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM public.recompute_member_payment_statuses(NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.recompute_member_payment_statuses(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recompute_member_payment_statuses(uuid) TO service_role;