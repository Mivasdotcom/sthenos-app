
-- 1) family_groups table (schema first, RLS after members has the column)
CREATE TABLE public.family_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_family_groups_dojo ON public.family_groups(dojo_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.family_groups TO authenticated;
GRANT ALL ON public.family_groups TO service_role;

CREATE TRIGGER update_family_groups_updated_at
  BEFORE UPDATE ON public.family_groups
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2) extend members (must exist before the member-read policy references it)
ALTER TABLE public.members
  ADD COLUMN family_group_id uuid NULL REFERENCES public.family_groups(id) ON DELETE SET NULL,
  ADD COLUMN plan_covered_by uuid NULL REFERENCES public.members(id) ON DELETE SET NULL;

CREATE INDEX idx_members_family_group ON public.members(family_group_id);
CREATE INDEX idx_members_plan_covered_by ON public.members(plan_covered_by);

-- 3) enable RLS + policies on family_groups (now that members.family_group_id exists)
ALTER TABLE public.family_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff full access to family_groups"
  ON public.family_groups
  FOR ALL
  TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE POLICY "Members can read their own family group"
  ON public.family_groups
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.members m
      WHERE m.family_group_id = family_groups.id
        AND m.user_id = auth.uid()
    )
  );

-- 4) extend dojo_plans
ALTER TABLE public.dojo_plans
  ADD COLUMN plan_type text NOT NULL DEFAULT 'individual',
  ADD COLUMN max_family_members int NULL;

ALTER TABLE public.dojo_plans
  ADD CONSTRAINT dojo_plans_plan_type_check
  CHECK (plan_type IN ('individual','family'));

-- 5) propagate payment_status from payer to covered members
CREATE OR REPLACE FUNCTION public.propagate_family_payment_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status THEN
    UPDATE public.members
       SET payment_status = NEW.payment_status,
           payment_status_updated_at = now(),
           updated_at = now()
     WHERE plan_covered_by = NEW.id
       AND payment_status IS DISTINCT FROM NEW.payment_status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_propagate_family_payment_status
  AFTER UPDATE OF payment_status ON public.members
  FOR EACH ROW EXECUTE FUNCTION public.propagate_family_payment_status();
