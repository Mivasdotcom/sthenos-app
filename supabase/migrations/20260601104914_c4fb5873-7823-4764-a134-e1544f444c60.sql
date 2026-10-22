
-- =========================================================
-- Phase 0: Multi-tenant RLS swap
-- =========================================================

-- Helper: any dojo membership (incl. plain member) for scoping reads
CREATE OR REPLACE FUNCTION public.user_is_in_dojo(_user_id uuid, _dojo_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.dojo_memberships
    WHERE user_id = _user_id AND dojo_id = _dojo_id AND role <> 'pending'
  )
$$;

-- ----- members -----
DROP POLICY IF EXISTS "members read own" ON public.members;
DROP POLICY IF EXISTS "members staff all" ON public.members;

CREATE POLICY "members read own dojo-scoped"
  ON public.members FOR SELECT TO authenticated
  USING (auth.uid() = user_id AND public.user_is_in_dojo(auth.uid(), dojo_id));

CREATE POLICY "members staff in dojo"
  ON public.members FOR ALL TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

-- Backfill any null dojo_id members to first dojo (defensive), then NOT NULL
UPDATE public.members
SET dojo_id = (SELECT id FROM public.dojos ORDER BY created_at LIMIT 1)
WHERE dojo_id IS NULL;
ALTER TABLE public.members ALTER COLUMN dojo_id SET NOT NULL;

-- ----- classes -----
DROP POLICY IF EXISTS "classes read all auth" ON public.classes;
DROP POLICY IF EXISTS "classes staff manage" ON public.classes;

CREATE POLICY "classes read in dojo"
  ON public.classes FOR SELECT TO authenticated
  USING (public.user_is_in_dojo(auth.uid(), dojo_id));

CREATE POLICY "classes staff manage in dojo"
  ON public.classes FOR ALL TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

-- ----- attendances -----
DROP POLICY IF EXISTS "attendances read own" ON public.attendances;
DROP POLICY IF EXISTS "attendances staff all" ON public.attendances;

CREATE POLICY "attendances read own in dojo"
  ON public.attendances FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.members m
    WHERE m.id = attendances.member_id
      AND m.user_id = auth.uid()
      AND m.dojo_id = attendances.dojo_id
  ));

CREATE POLICY "attendances staff in dojo"
  ON public.attendances FOR ALL TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

-- ----- invoices -----
DROP POLICY IF EXISTS "invoices read own" ON public.invoices;
DROP POLICY IF EXISTS "invoices staff all" ON public.invoices;

CREATE POLICY "invoices read own in dojo"
  ON public.invoices FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.members m
    WHERE m.id = invoices.member_id
      AND m.user_id = auth.uid()
      AND m.dojo_id = invoices.dojo_id
  ));

CREATE POLICY "invoices staff in dojo"
  ON public.invoices FOR ALL TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

-- ----- promotions -----
DROP POLICY IF EXISTS "promotions read own" ON public.promotions;
DROP POLICY IF EXISTS "promotions staff all" ON public.promotions;

CREATE POLICY "promotions read own in dojo"
  ON public.promotions FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.members m
    WHERE m.id = promotions.member_id
      AND m.user_id = auth.uid()
      AND m.dojo_id = promotions.dojo_id
  ));

CREATE POLICY "promotions staff in dojo"
  ON public.promotions FOR ALL TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

-- ----- internal_tasks / marketing_broadcasts / segments / workflows / workflow_runs -----
DROP POLICY IF EXISTS "tasks staff all" ON public.internal_tasks;
CREATE POLICY "tasks staff in dojo"
  ON public.internal_tasks FOR ALL TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

DROP POLICY IF EXISTS "broadcasts staff all" ON public.marketing_broadcasts;
CREATE POLICY "broadcasts staff in dojo"
  ON public.marketing_broadcasts FOR ALL TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

DROP POLICY IF EXISTS "segments staff all" ON public.segments;
CREATE POLICY "segments staff in dojo"
  ON public.segments FOR ALL TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

DROP POLICY IF EXISTS "workflows staff all" ON public.workflows;
CREATE POLICY "workflows staff in dojo"
  ON public.workflows FOR ALL TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

DROP POLICY IF EXISTS "workflow_runs staff all" ON public.workflow_runs;
CREATE POLICY "workflow_runs staff in dojo"
  ON public.workflow_runs FOR ALL TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

-- ----- email_settings (per-dojo now) -----
DROP POLICY IF EXISTS "email_settings owner update" ON public.email_settings;
DROP POLICY IF EXISTS "email_settings staff read" ON public.email_settings;

CREATE POLICY "email_settings read in dojo"
  ON public.email_settings FOR SELECT TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE POLICY "email_settings owner update in dojo"
  ON public.email_settings FOR UPDATE TO authenticated
  USING (public.has_dojo_role(auth.uid(), dojo_id, 'owner'::public.dojo_role))
  WITH CHECK (public.has_dojo_role(auth.uid(), dojo_id, 'owner'::public.dojo_role));

CREATE POLICY "email_settings owner insert in dojo"
  ON public.email_settings FOR INSERT TO authenticated
  WITH CHECK (public.has_dojo_role(auth.uid(), dojo_id, 'owner'::public.dojo_role));

-- ----- profiles: scope readable-by-staff to staff who share a dojo -----
DROP POLICY IF EXISTS "profiles read own" ON public.profiles;
CREATE POLICY "profiles read own or shared dojo staff"
  ON public.profiles FOR SELECT TO authenticated
  USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1
      FROM public.dojo_memberships me
      JOIN public.dojo_memberships them ON them.dojo_id = me.dojo_id
      WHERE me.user_id = auth.uid()
        AND me.role IN ('owner','admin','coach')
        AND them.user_id = profiles.user_id
    )
  );

-- ----- handle_new_user: profile only, no global role assignment -----
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name',
      split_part(NEW.email, '@', 1)
    )
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;
