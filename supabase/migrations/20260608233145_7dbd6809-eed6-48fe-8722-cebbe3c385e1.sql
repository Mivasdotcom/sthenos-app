
-- Enums
DO $$ BEGIN
  CREATE TYPE public.overhead_category AS ENUM ('rent','utilities','payroll','equipment','marketing','insurance','software','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.overhead_recurrence AS ENUM ('one_off','monthly','yearly');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Overheads
CREATE TABLE public.dojo_overheads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  name text NOT NULL,
  category public.overhead_category NOT NULL DEFAULT 'other',
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  currency text NOT NULL DEFAULT 'usd',
  recurrence public.overhead_recurrence NOT NULL DEFAULT 'monthly',
  starts_on date NOT NULL DEFAULT CURRENT_DATE,
  ends_on date,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dojo_overheads TO authenticated;
GRANT ALL ON public.dojo_overheads TO service_role;
ALTER TABLE public.dojo_overheads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "overheads staff read" ON public.dojo_overheads
  FOR SELECT TO authenticated USING (public.is_dojo_staff(auth.uid(), dojo_id));
CREATE POLICY "overheads staff write" ON public.dojo_overheads
  FOR ALL TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));
CREATE TRIGGER trg_overheads_updated_at BEFORE UPDATE ON public.dojo_overheads
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Manual revenue
CREATE TABLE public.manual_revenue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  description text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  currency text NOT NULL DEFAULT 'usd',
  received_on date NOT NULL DEFAULT CURRENT_DATE,
  category text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.manual_revenue TO authenticated;
GRANT ALL ON public.manual_revenue TO service_role;
ALTER TABLE public.manual_revenue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "manual_revenue staff read" ON public.manual_revenue
  FOR SELECT TO authenticated USING (public.is_dojo_staff(auth.uid(), dojo_id));
CREATE POLICY "manual_revenue staff write" ON public.manual_revenue
  FOR ALL TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));
CREATE TRIGGER trg_manual_revenue_updated_at BEFORE UPDATE ON public.manual_revenue
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_overheads_dojo ON public.dojo_overheads(dojo_id, is_active);
CREATE INDEX idx_manual_revenue_dojo_date ON public.manual_revenue(dojo_id, received_on);
