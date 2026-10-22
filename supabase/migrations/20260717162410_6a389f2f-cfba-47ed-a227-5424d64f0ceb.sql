
-- 1. Tighten the default grace period to 1 day
ALTER TABLE public.dojos ALTER COLUMN hold_grace_days SET DEFAULT 1;
UPDATE public.dojos SET hold_grace_days = 1 WHERE hold_grace_days IS NULL OR hold_grace_days = 5;

-- 2. Track the environment (sandbox/live) on member_subscriptions
ALTER TABLE public.member_subscriptions
  ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'sandbox';
CREATE INDEX IF NOT EXISTS idx_member_subs_environment ON public.member_subscriptions(environment);

-- 3. Cancel-at-period-end flag for graceful cancellations
ALTER TABLE public.member_subscriptions
  ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false;

-- 4. Family: allow linking dependent members to their family group during signup
--    (family_group_id already exists; nothing extra needed here)

-- 5. Daily cron: mark members with a subscription whose period ended more than
--    <dojo.hold_grace_days> ago as 'overdue' (safety net if webhooks miss).
--    Skip anyone already 'overdue' or 'none', and anyone covered by a family payer.
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION public.enforce_overdue_grace()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.members m
     SET payment_status = 'overdue'::public.member_payment_status,
         payment_status_updated_at = now(),
         updated_at = now()
   WHERE m.payment_status = 'current'::public.member_payment_status
     AND m.plan_covered_by IS NULL
     AND EXISTS (
       SELECT 1
         FROM public.member_subscriptions s
         JOIN public.dojos d ON d.id = m.dojo_id
        WHERE s.member_id = m.id
          AND s.status IN ('active','trialing','past_due','unpaid')
          AND s.current_period_end IS NOT NULL
          AND s.current_period_end < now() - (COALESCE(d.hold_grace_days, 1) || ' days')::interval
     );
END;
$$;

-- Schedule daily at 03:00 UTC
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'enforce-overdue-grace') THEN
    PERFORM cron.schedule(
      'enforce-overdue-grace',
      '0 3 * * *',
      $cron$ SELECT public.enforce_overdue_grace(); $cron$
    );
  END IF;
END $$;
