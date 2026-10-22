
-- Segments: saved audience folders (reusable filters)
CREATE TABLE public.segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  filter JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.segments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "segments staff all" ON public.segments
  FOR ALL TO authenticated
  USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));
CREATE TRIGGER segments_updated_at BEFORE UPDATE ON public.segments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Workflows: trigger + conditions + ordered actions
CREATE TYPE public.workflow_trigger_type AS ENUM ('manual','scheduled','event');
CREATE TYPE public.workflow_run_status AS ENUM ('queued','running','succeeded','failed','partial');

CREATE TABLE public.workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  trigger_type public.workflow_trigger_type NOT NULL,
  trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  filter JSONB NOT NULL DEFAULT '{}'::jsonb,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_run_at TIMESTAMPTZ,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.workflows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "workflows staff all" ON public.workflows
  FOR ALL TO authenticated
  USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));
CREATE TRIGGER workflows_updated_at BEFORE UPDATE ON public.workflows
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Workflow runs: history
CREATE TABLE public.workflow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  status public.workflow_run_status NOT NULL DEFAULT 'queued',
  trigger_source TEXT,
  matched_count INTEGER NOT NULL DEFAULT 0,
  succeeded_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
ALTER TABLE public.workflow_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "workflow_runs staff all" ON public.workflow_runs
  FOR ALL TO authenticated
  USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));
CREATE INDEX workflow_runs_workflow_idx ON public.workflow_runs(workflow_id, started_at DESC);

-- Internal tasks (for the "create task" action)
CREATE TYPE public.task_status AS ENUM ('open','done','dismissed');
CREATE TABLE public.internal_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID,
  title TEXT NOT NULL,
  description TEXT,
  due_date DATE,
  status public.task_status NOT NULL DEFAULT 'open',
  source_workflow_id UUID REFERENCES public.workflows(id) ON DELETE SET NULL,
  created_by UUID,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.internal_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tasks staff all" ON public.internal_tasks
  FOR ALL TO authenticated
  USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));
CREATE TRIGGER tasks_updated_at BEFORE UPDATE ON public.internal_tasks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Marketing broadcasts (audit log of sent campaigns)
CREATE TYPE public.broadcast_status AS ENUM ('draft','sending','sent','failed');
CREATE TABLE public.marketing_broadcasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  from_name TEXT,
  segment_id UUID REFERENCES public.segments(id) ON DELETE SET NULL,
  filter_snapshot JSONB,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  status public.broadcast_status NOT NULL DEFAULT 'draft',
  sent_at TIMESTAMPTZ,
  error TEXT,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.marketing_broadcasts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "broadcasts staff all" ON public.marketing_broadcasts
  FOR ALL TO authenticated
  USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));
CREATE TRIGGER broadcasts_updated_at BEFORE UPDATE ON public.marketing_broadcasts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Marketing email opt-out (separate from auth/transactional)
ALTER TABLE public.members ADD COLUMN IF NOT EXISTS marketing_opt_out BOOLEAN NOT NULL DEFAULT false;
