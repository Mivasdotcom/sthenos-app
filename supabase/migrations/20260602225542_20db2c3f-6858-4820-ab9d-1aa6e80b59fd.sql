ALTER TABLE public.members
  ADD COLUMN selected_plan_id uuid REFERENCES public.dojo_plans(id) ON DELETE SET NULL;

CREATE INDEX idx_members_selected_plan ON public.members(selected_plan_id);