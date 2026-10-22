ALTER TABLE public.cancellation_audit_log
  ADD COLUMN IF NOT EXISTS cancel_mode text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_canceled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS access_until timestamptz;

ALTER TABLE public.cancellation_audit_log
  ADD CONSTRAINT cancellation_audit_log_cancel_mode_chk
  CHECK (cancel_mode IS NULL OR cancel_mode IN ('period_end','immediate'));