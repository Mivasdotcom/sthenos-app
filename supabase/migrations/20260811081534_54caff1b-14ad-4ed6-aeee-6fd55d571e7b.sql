ALTER TABLE public.dojos
  ADD COLUMN IF NOT EXISTS family_pricing_mode text NOT NULL DEFAULT 'tiered';

ALTER TABLE public.dojos
  DROP CONSTRAINT IF EXISTS dojos_family_pricing_mode_check;
ALTER TABLE public.dojos
  ADD CONSTRAINT dojos_family_pricing_mode_check
  CHECK (family_pricing_mode IN ('flat','tiered'));

CREATE TABLE IF NOT EXISTS public.family_discount_tiers (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  min_members integer NOT NULL CHECK (min_members >= 2),
  discount_percent numeric(5,2) NOT NULL CHECK (discount_percent >= 0 AND discount_percent <= 100),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (dojo_id, min_members)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.family_discount_tiers TO authenticated;
GRANT ALL ON public.family_discount_tiers TO service_role;

ALTER TABLE public.family_discount_tiers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Dojo members can view family discount tiers"
ON public.family_discount_tiers FOR SELECT TO authenticated
USING (public.user_in_dojo(auth.uid(), dojo_id));

CREATE POLICY "Dojo staff manage family discount tiers"
ON public.family_discount_tiers FOR ALL TO authenticated
USING (
  public.has_dojo_role(auth.uid(), dojo_id, 'owner')
  OR public.has_dojo_role(auth.uid(), dojo_id, 'manager')
  OR public.has_dojo_role(auth.uid(), dojo_id, 'admin')
)
WITH CHECK (
  public.has_dojo_role(auth.uid(), dojo_id, 'owner')
  OR public.has_dojo_role(auth.uid(), dojo_id, 'manager')
  OR public.has_dojo_role(auth.uid(), dojo_id, 'admin')
);

CREATE TRIGGER family_discount_tiers_updated_at
BEFORE UPDATE ON public.family_discount_tiers
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.family_discount_tiers (dojo_id, min_members, discount_percent)
SELECT d.id, t.min_members, t.discount_percent
FROM public.dojos d
CROSS JOIN (VALUES (2, 10.00), (3, 20.00), (4, 30.00), (5, 35.00)) AS t(min_members, discount_percent)
ON CONFLICT (dojo_id, min_members) DO NOTHING;