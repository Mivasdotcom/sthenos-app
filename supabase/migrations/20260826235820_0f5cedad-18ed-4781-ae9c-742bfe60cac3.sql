ALTER TABLE public.retention_interventions
ADD COLUMN intervention_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX retention_interventions_intervention_by_idx
ON public.retention_interventions(intervention_by);