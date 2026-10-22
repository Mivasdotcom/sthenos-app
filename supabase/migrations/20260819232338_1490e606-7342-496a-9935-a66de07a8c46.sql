DROP POLICY IF EXISTS "Members can read own cash payments" ON public.cash_payments;
CREATE POLICY "Members can read own cash payments"
  ON public.cash_payments FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.members m
      WHERE m.id = cash_payments.member_id
        AND m.dojo_id = cash_payments.dojo_id
        AND m.user_id = auth.uid()
    )
  );