-- Onboarding-friendly INSERT policies (permissive, layered on existing).
CREATE POLICY "authenticated users can create dojo"
  ON public.dojos FOR INSERT TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "owner can insert class types"
  ON public.dojo_class_types FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.dojos d
            WHERE d.id = dojo_class_types.dojo_id
              AND d.owner_user_id = auth.uid())
  );

CREATE POLICY "owner can insert waiver"
  ON public.dojo_waivers FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.dojos d
            WHERE d.id = dojo_waivers.dojo_id
              AND d.owner_user_id = auth.uid())
  );