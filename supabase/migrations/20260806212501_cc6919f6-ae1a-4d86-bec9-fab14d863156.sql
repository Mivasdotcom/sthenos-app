CREATE TABLE public.retention_interventions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  flagged_at timestamptz NOT NULL DEFAULT now(),
  risk_level_at_flag text NOT NULL,
  risk_score_at_flag integer NOT NULL DEFAULT 0,
  risk_factors_at_flag jsonb NOT NULL DEFAULT '[]'::jsonb,
  intervention_type text,
  workflow_id uuid REFERENCES public.workflows(id) ON DELETE SET NULL,
  intervention_at timestamptz,
  outcome text NOT NULL DEFAULT 'pending',
  outcome_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.retention_interventions TO authenticated;
GRANT ALL ON public.retention_interventions TO service_role;

ALTER TABLE public.retention_interventions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view interventions in their dojo"
  ON public.retention_interventions FOR SELECT TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE POLICY "Staff can create interventions in their dojo"
  ON public.retention_interventions FOR INSERT TO authenticated
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE POLICY "Staff can update interventions in their dojo"
  ON public.retention_interventions FOR UPDATE TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE INDEX idx_retention_interventions_dojo_flagged ON public.retention_interventions (dojo_id, flagged_at DESC);
CREATE INDEX idx_retention_interventions_open ON public.retention_interventions (dojo_id, member_id) WHERE outcome = 'pending';

CREATE TRIGGER retention_interventions_updated_at
  BEFORE UPDATE ON public.retention_interventions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();