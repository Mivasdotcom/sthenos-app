-- Allow a user to insert their own owner membership during dojo onboarding.
-- Existing "memberships owner manage" policy fails at the moment of first insert
-- because there is no owner row yet.
CREATE POLICY "membership self insert owner"
  ON public.dojo_memberships
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND role = 'owner'::public.dojo_role
    AND EXISTS (
      SELECT 1 FROM public.dojos d
      WHERE d.id = dojo_memberships.dojo_id
        AND d.owner_user_id = auth.uid()
    )
  );