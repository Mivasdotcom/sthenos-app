ALTER TYPE broadcast_status ADD VALUE IF NOT EXISTS 'queued';
ALTER TABLE public.marketing_broadcasts ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;
ALTER TABLE public.marketing_broadcasts ADD COLUMN IF NOT EXISTS segment_type text;