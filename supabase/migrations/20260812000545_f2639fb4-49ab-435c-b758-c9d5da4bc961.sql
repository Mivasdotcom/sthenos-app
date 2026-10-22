CREATE TABLE IF NOT EXISTS public.stripe_events (
  event_id text PRIMARY KEY,
  type text NOT NULL,
  account text,
  created_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  status text NOT NULL DEFAULT 'received'
);

GRANT ALL ON public.stripe_events TO service_role;
ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages stripe events"
  ON public.stripe_events FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE public.member_subscriptions
  ADD COLUMN IF NOT EXISTS last_event_at timestamptz;