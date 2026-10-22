-- 1) Member payment method
ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'card';

ALTER TABLE public.members
  DROP CONSTRAINT IF EXISTS members_payment_method_check;
ALTER TABLE public.members
  ADD CONSTRAINT members_payment_method_check
  CHECK (payment_method IN ('card', 'cash'));

-- 2) Cash payments
CREATE TABLE IF NOT EXISTS public.cash_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL DEFAULT 'usd',
  paid_on date NOT NULL DEFAULT current_date,
  period_start date NOT NULL,
  period_end date NOT NULL,
  recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cash_payments_dojo_paid_on_idx
  ON public.cash_payments (dojo_id, paid_on);
CREATE INDEX IF NOT EXISTS cash_payments_member_period_idx
  ON public.cash_payments (member_id, period_end);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.cash_payments TO authenticated;
GRANT ALL ON public.cash_payments TO service_role;

ALTER TABLE public.cash_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can read dojo cash payments" ON public.cash_payments;
CREATE POLICY "Staff can read dojo cash payments"
  ON public.cash_payments FOR SELECT TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id));

DROP POLICY IF EXISTS "Staff can record dojo cash payments" ON public.cash_payments;
CREATE POLICY "Staff can record dojo cash payments"
  ON public.cash_payments FOR INSERT TO authenticated
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

DROP POLICY IF EXISTS "Staff can update dojo cash payments" ON public.cash_payments;
CREATE POLICY "Staff can update dojo cash payments"
  ON public.cash_payments FOR UPDATE TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

DROP POLICY IF EXISTS "Staff can delete dojo cash payments" ON public.cash_payments;
CREATE POLICY "Staff can delete dojo cash payments"
  ON public.cash_payments FOR DELETE TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id));

-- 3) Payment status recomputation now understands cash members
CREATE OR REPLACE FUNCTION public.recompute_member_payment_statuses(_dojo_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_changed integer := 0;
  m record;
  v_has_active_sub boolean;
  v_has_bad_sub boolean;
  v_last_paid timestamptz;
  v_last_failed timestamptz;
  v_new public.member_payment_status;
  v_plan record;
  v_period_start date;
  v_grace integer;
  v_covered boolean;
BEGIN
  FOR m IN
    SELECT id, dojo_id, payment_status, payment_method, selected_plan_id
      FROM public.members
     WHERE (_dojo_id IS NULL OR dojo_id = _dojo_id)
       AND plan_covered_by IS NULL
       AND status IN ('active','trial')
  LOOP
    v_new := NULL;

    IF m.payment_method = 'cash' THEN
      IF m.selected_plan_id IS NULL THEN
        CONTINUE;
      END IF;

      SELECT price_cents, interval INTO v_plan
        FROM public.dojo_plans WHERE id = m.selected_plan_id;
      IF v_plan IS NULL OR coalesce(v_plan.price_cents, 0) = 0 THEN
        CONTINUE;
      END IF;

      SELECT coalesce(hold_grace_days, 0) INTO v_grace
        FROM public.dojos WHERE id = m.dojo_id;
      v_grace := coalesce(v_grace, 0);

      IF lower(coalesce(v_plan.interval, 'month')) IN ('year','yearly','annual') THEN
        v_period_start := date_trunc('year', now())::date;
      ELSE
        v_period_start := date_trunc('month', now())::date;
      END IF;

      SELECT EXISTS (
        SELECT 1 FROM public.cash_payments c
         WHERE c.member_id = m.id
           AND c.dojo_id = m.dojo_id
           AND c.period_end >= current_date
      ) INTO v_covered;

      IF v_covered THEN
        v_new := 'current';
      ELSIF current_date > (v_period_start + v_grace) THEN
        v_new := 'overdue';
      ELSE
        v_new := 'due';
      END IF;
    ELSE
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

      IF v_has_bad_sub AND (v_last_paid IS NULL OR v_last_failed IS NULL OR v_last_failed >= v_last_paid) THEN
        v_new := 'overdue';
      ELSIF v_has_active_sub THEN
        v_new := 'current';
      ELSIF v_last_failed IS NOT NULL AND (v_last_paid IS NULL OR v_last_failed > v_last_paid) THEN
        v_new := 'overdue';
      ELSIF v_last_paid IS NOT NULL AND v_last_paid > now() - interval '40 days' THEN
        v_new := 'current';
      END IF;
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
$function$;
