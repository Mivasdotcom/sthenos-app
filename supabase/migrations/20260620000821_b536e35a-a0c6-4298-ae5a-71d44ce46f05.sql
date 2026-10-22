ALTER TABLE public.workflows ADD COLUMN IF NOT EXISTS segment_id uuid REFERENCES public.segments(id) ON DELETE SET NULL;
ALTER TABLE public.workflow_runs ADD COLUMN IF NOT EXISTS member_id uuid REFERENCES public.members(id) ON DELETE CASCADE;
ALTER TABLE public.workflow_runs ADD COLUMN IF NOT EXISTS triggered_at timestamptz NOT NULL DEFAULT now();
ALTER TYPE public.workflow_run_status ADD VALUE IF NOT EXISTS 'pending';
CREATE INDEX IF NOT EXISTS idx_workflow_runs_member ON public.workflow_runs(member_id);