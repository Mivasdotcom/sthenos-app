-- ============================================================
-- Data retention (GDPR storage limitation)
-- Per-dojo retention periods, member-level state, and an audit
-- trail for the scheduled anonymisation sweep.
-- ============================================================

-- 1) Gym-level retention policy -------------------------------
ALTER TABLE public.dojos
  ADD COLUMN IF NOT EXISTS retention_auto_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS retention_departed_months integer DEFAULT 24,
  ADD COLUMN IF NOT EXISTS retention_waiver_months integer DEFAULT 84,
  ADD COLUMN IF NOT EXISTS retention_notice_days integer NOT NULL DEFAULT 14;

COMMENT ON COLUMN public.dojos.retention_departed_months IS
  'Months to keep records of departed members before anonymising. NULL = retain indefinitely.';
COMMENT ON COLUMN public.dojos.retention_waiver_months IS
  'Months to keep signed waivers / safety records. Deliberately longer than member retention: waivers are the gym''s defence against later personal-injury claims. NULL = retain indefinitely.';

GRANT SELECT (retention_auto_enabled, retention_departed_months, retention_waiver_months, retention_notice_days)
  ON public.dojos TO authenticated;
GRANT UPDATE (retention_auto_enabled, retention_departed_months, retention_waiver_months, retention_notice_days)
  ON public.dojos TO authenticated;

-- 2) Member-level retention state -----------------------------
ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS departed_at timestamptz,
  ADD COLUMN IF NOT EXISTS anonymised_at timestamptz,
  ADD COLUMN IF NOT EXISTS retention_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS retention_hold_reason text,
  ADD COLUMN IF NOT EXISTS retention_hold_by uuid,
  ADD COLUMN IF NOT EXISTS retention_hold_at timestamptz,
  ADD COLUMN IF NOT EXISTS retention_notified_at timestamptz;

COMMENT ON COLUMN public.members.departed_at IS
  'When this membership ended. Starts the retention clock; NULL while they are still training.';
COMMENT ON COLUMN public.members.retention_hold IS
  'Excluded from automatic anonymisation (ongoing dispute, unpaid balance, pending claim). Reason recorded.';

GRANT SELECT (departed_at, anonymised_at, retention_hold, retention_hold_reason,
              retention_hold_by, retention_hold_at, retention_notified_at)
  ON public.members TO authenticated;

CREATE INDEX IF NOT EXISTS members_retention_due_idx
  ON public.members (dojo_id, departed_at)
  WHERE anonymised_at IS NULL;

ALTER TABLE public.member_waivers
  ADD COLUMN IF NOT EXISTS anonymised_at timestamptz;
GRANT SELECT (anonymised_at) ON public.member_waivers TO authenticated;

-- 3) Start / stop the retention clock automatically ------------
CREATE OR REPLACE FUNCTION public.track_member_departure()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'lapsed'::public.member_status THEN
    -- Membership ended: start the clock (keep an existing, earlier date).
    IF NEW.departed_at IS NULL THEN
      NEW.departed_at := now();
    END IF;
  ELSIF OLD.status IS DISTINCT FROM NEW.status
        AND NEW.status IN ('active'::public.member_status,
                           'trial'::public.member_status,
                           'pending'::public.member_status,
                           'paused'::public.member_status) THEN
    -- They came back: stop the clock.
    NEW.departed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS members_track_departure ON public.members;
CREATE TRIGGER members_track_departure
  BEFORE UPDATE ON public.members
  FOR EACH ROW EXECUTE FUNCTION public.track_member_departure();

-- Backfill members who have already left.
UPDATE public.members m
   SET departed_at = coalesce(
         (SELECT max(h.changed_at)
            FROM public.member_status_history h
           WHERE h.member_id = m.id
             AND h.to_status = 'lapsed'::public.member_status),
         m.cancellation_requested_at,
         m.last_seen_at,
         m.updated_at)
 WHERE m.status = 'lapsed'::public.member_status
   AND m.departed_at IS NULL;

-- 4) Run log --------------------------------------------------
CREATE TABLE IF NOT EXISTS public.data_retention_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  dojo_id uuid REFERENCES public.dojos(id) ON DELETE CASCADE,
  trigger_source text NOT NULL DEFAULT 'scheduled',
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  members_considered integer NOT NULL DEFAULT 0,
  members_anonymised integer NOT NULL DEFAULT 0,
  members_skipped integer NOT NULL DEFAULT 0,
  waivers_anonymised integer NOT NULL DEFAULT 0,
  notices_raised integer NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0,
  error text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.data_retention_runs TO authenticated;
GRANT ALL ON public.data_retention_runs TO service_role;
ALTER TABLE public.data_retention_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view their gym's retention runs"
  ON public.data_retention_runs FOR SELECT TO authenticated
  USING (dojo_id IS NOT NULL AND public.is_dojo_staff(auth.uid(), dojo_id));

DROP TRIGGER IF EXISTS data_retention_runs_updated_at ON public.data_retention_runs;
CREATE TRIGGER data_retention_runs_updated_at
  BEFORE UPDATE ON public.data_retention_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 5) Per-record audit trail (holds no personal data) -----------
CREATE TABLE IF NOT EXISTS public.data_retention_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  run_id uuid REFERENCES public.data_retention_runs(id) ON DELETE SET NULL,
  member_id uuid REFERENCES public.members(id) ON DELETE SET NULL,
  action text NOT NULL,
  reason text,
  departed_at timestamptz,
  policy_months integer,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.data_retention_events IS
  'Audit trail of automatic retention actions. Deliberately stores no names or contact details.';

CREATE INDEX IF NOT EXISTS data_retention_events_dojo_idx
  ON public.data_retention_events (dojo_id, created_at DESC);

GRANT SELECT ON public.data_retention_events TO authenticated;
GRANT ALL ON public.data_retention_events TO service_role;
ALTER TABLE public.data_retention_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view their gym's retention events"
  ON public.data_retention_events FOR SELECT TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id));