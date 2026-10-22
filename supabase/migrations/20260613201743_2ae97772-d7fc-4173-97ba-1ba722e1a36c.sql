CREATE TABLE public.dojo_class_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  name text NOT NULL,
  discipline public.discipline NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_dojo_class_types_dojo ON public.dojo_class_types(dojo_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.dojo_class_types TO authenticated;
GRANT ALL ON public.dojo_class_types TO service_role;

ALTER TABLE public.dojo_class_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "class types read in dojo"
ON public.dojo_class_types FOR SELECT
TO authenticated
USING (public.user_is_in_dojo(auth.uid(), dojo_id));

CREATE POLICY "class types staff manage in dojo"
ON public.dojo_class_types
TO authenticated
USING (public.is_dojo_staff(auth.uid(), dojo_id))
WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE TRIGGER dojo_class_types_updated_at
BEFORE UPDATE ON public.dojo_class_types
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();