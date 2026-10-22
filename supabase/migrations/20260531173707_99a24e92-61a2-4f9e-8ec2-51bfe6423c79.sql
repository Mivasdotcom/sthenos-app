
-- 1. dojo role enum
CREATE TYPE public.dojo_role AS ENUM ('owner','admin','coach','member','pending');

-- 2. dojos table
CREATE TABLE public.dojos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  owner_user_id uuid NOT NULL,
  plan text NOT NULL DEFAULT 'free',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.dojos TO authenticated;
GRANT ALL ON public.dojos TO service_role;
ALTER TABLE public.dojos ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_dojos_updated_at
  BEFORE UPDATE ON public.dojos
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. dojo_memberships table
CREATE TABLE public.dojo_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role public.dojo_role NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dojo_id, user_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dojo_memberships TO authenticated;
GRANT ALL ON public.dojo_memberships TO service_role;
ALTER TABLE public.dojo_memberships ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_dojo_memberships_user ON public.dojo_memberships(user_id);
CREATE INDEX idx_dojo_memberships_dojo ON public.dojo_memberships(dojo_id);

-- 4. Security definer helpers
CREATE OR REPLACE FUNCTION public.is_dojo_staff(_user_id uuid, _dojo_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.dojo_memberships
    WHERE user_id = _user_id
      AND dojo_id = _dojo_id
      AND role IN ('owner','admin','coach')
  )
$$;
GRANT EXECUTE ON FUNCTION public.is_dojo_staff(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.has_dojo_role(_user_id uuid, _dojo_id uuid, _role public.dojo_role)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.dojo_memberships
    WHERE user_id = _user_id AND dojo_id = _dojo_id AND role = _role
  )
$$;
GRANT EXECUTE ON FUNCTION public.has_dojo_role(uuid, uuid, public.dojo_role) TO authenticated;

CREATE OR REPLACE FUNCTION public.user_in_dojo(_user_id uuid, _dojo_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.dojo_memberships
    WHERE user_id = _user_id AND dojo_id = _dojo_id AND role <> 'pending'
  )
$$;
GRANT EXECUTE ON FUNCTION public.user_in_dojo(uuid, uuid) TO authenticated;

-- 5. RLS policies for dojos & memberships
CREATE POLICY "dojos read own"
ON public.dojos FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.dojo_memberships m
    WHERE m.dojo_id = dojos.id AND m.user_id = auth.uid()
  )
);

CREATE POLICY "dojos insert own"
ON public.dojos FOR INSERT TO authenticated
WITH CHECK (owner_user_id = auth.uid());

CREATE POLICY "dojos owner update"
ON public.dojos FOR UPDATE TO authenticated
USING (public.has_dojo_role(auth.uid(), id, 'owner'::public.dojo_role))
WITH CHECK (public.has_dojo_role(auth.uid(), id, 'owner'::public.dojo_role));

CREATE POLICY "memberships read own"
ON public.dojo_memberships FOR SELECT TO authenticated
USING (
  user_id = auth.uid()
  OR public.is_dojo_staff(auth.uid(), dojo_id)
);

CREATE POLICY "memberships self join pending"
ON public.dojo_memberships FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid() AND role = 'pending'::public.dojo_role);

CREATE POLICY "memberships owner manage"
ON public.dojo_memberships FOR ALL TO authenticated
USING (public.has_dojo_role(auth.uid(), dojo_id, 'owner'::public.dojo_role) OR public.has_dojo_role(auth.uid(), dojo_id, 'admin'::public.dojo_role))
WITH CHECK (public.has_dojo_role(auth.uid(), dojo_id, 'owner'::public.dojo_role) OR public.has_dojo_role(auth.uid(), dojo_id, 'admin'::public.dojo_role));

-- 6. Add dojo_id column (nullable) to tenant tables
ALTER TABLE public.members              ADD COLUMN dojo_id uuid REFERENCES public.dojos(id) ON DELETE CASCADE;
ALTER TABLE public.classes              ADD COLUMN dojo_id uuid REFERENCES public.dojos(id) ON DELETE CASCADE;
ALTER TABLE public.attendances          ADD COLUMN dojo_id uuid REFERENCES public.dojos(id) ON DELETE CASCADE;
ALTER TABLE public.invoices             ADD COLUMN dojo_id uuid REFERENCES public.dojos(id) ON DELETE CASCADE;
ALTER TABLE public.promotions           ADD COLUMN dojo_id uuid REFERENCES public.dojos(id) ON DELETE CASCADE;
ALTER TABLE public.segments             ADD COLUMN dojo_id uuid REFERENCES public.dojos(id) ON DELETE CASCADE;
ALTER TABLE public.workflows            ADD COLUMN dojo_id uuid REFERENCES public.dojos(id) ON DELETE CASCADE;
ALTER TABLE public.workflow_runs        ADD COLUMN dojo_id uuid REFERENCES public.dojos(id) ON DELETE CASCADE;
ALTER TABLE public.internal_tasks       ADD COLUMN dojo_id uuid REFERENCES public.dojos(id) ON DELETE CASCADE;
ALTER TABLE public.marketing_broadcasts ADD COLUMN dojo_id uuid REFERENCES public.dojos(id) ON DELETE CASCADE;
ALTER TABLE public.email_settings       ADD COLUMN dojo_id uuid REFERENCES public.dojos(id) ON DELETE CASCADE;
ALTER TABLE public.view_switch_audit_log ADD COLUMN dojo_id uuid REFERENCES public.dojos(id) ON DELETE CASCADE;

-- 7. Backfill into a default dojo owned by the first existing owner (if any)
DO $$
DECLARE
  v_owner uuid;
  v_dojo  uuid;
BEGIN
  SELECT user_id INTO v_owner FROM public.user_roles WHERE role = 'owner'::public.app_role ORDER BY created_at LIMIT 1;

  IF v_owner IS NULL THEN
    -- no owner yet: skip backfill, future signups will create their own dojo
    RETURN;
  END IF;

  INSERT INTO public.dojos (name, slug, owner_user_id)
  VALUES ('Sthenos HQ', 'sthenos-hq', v_owner)
  RETURNING id INTO v_dojo;

  -- owner + existing user_roles → memberships
  INSERT INTO public.dojo_memberships (dojo_id, user_id, role)
  SELECT v_dojo, ur.user_id,
    CASE ur.role::text
      WHEN 'owner'   THEN 'owner'::public.dojo_role
      WHEN 'coach'   THEN 'coach'::public.dojo_role
      WHEN 'member'  THEN 'member'::public.dojo_role
      WHEN 'pending' THEN 'pending'::public.dojo_role
      ELSE 'member'::public.dojo_role
    END
  FROM public.user_roles ur
  ON CONFLICT (dojo_id, user_id) DO NOTHING;

  -- backfill all tenant tables
  UPDATE public.members              SET dojo_id = v_dojo WHERE dojo_id IS NULL;
  UPDATE public.classes              SET dojo_id = v_dojo WHERE dojo_id IS NULL;
  UPDATE public.attendances          SET dojo_id = v_dojo WHERE dojo_id IS NULL;
  UPDATE public.invoices             SET dojo_id = v_dojo WHERE dojo_id IS NULL;
  UPDATE public.promotions           SET dojo_id = v_dojo WHERE dojo_id IS NULL;
  UPDATE public.segments             SET dojo_id = v_dojo WHERE dojo_id IS NULL;
  UPDATE public.workflows            SET dojo_id = v_dojo WHERE dojo_id IS NULL;
  UPDATE public.workflow_runs        SET dojo_id = v_dojo WHERE dojo_id IS NULL;
  UPDATE public.internal_tasks       SET dojo_id = v_dojo WHERE dojo_id IS NULL;
  UPDATE public.marketing_broadcasts SET dojo_id = v_dojo WHERE dojo_id IS NULL;
  UPDATE public.email_settings       SET dojo_id = v_dojo WHERE dojo_id IS NULL;
  UPDATE public.view_switch_audit_log SET dojo_id = v_dojo WHERE dojo_id IS NULL;
END $$;

-- 8. Indexes on dojo_id for tenant tables
CREATE INDEX IF NOT EXISTS idx_members_dojo              ON public.members(dojo_id);
CREATE INDEX IF NOT EXISTS idx_classes_dojo              ON public.classes(dojo_id);
CREATE INDEX IF NOT EXISTS idx_attendances_dojo          ON public.attendances(dojo_id);
CREATE INDEX IF NOT EXISTS idx_invoices_dojo             ON public.invoices(dojo_id);
CREATE INDEX IF NOT EXISTS idx_promotions_dojo           ON public.promotions(dojo_id);
CREATE INDEX IF NOT EXISTS idx_segments_dojo             ON public.segments(dojo_id);
CREATE INDEX IF NOT EXISTS idx_workflows_dojo            ON public.workflows(dojo_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_dojo        ON public.workflow_runs(dojo_id);
CREATE INDEX IF NOT EXISTS idx_internal_tasks_dojo       ON public.internal_tasks(dojo_id);
CREATE INDEX IF NOT EXISTS idx_marketing_broadcasts_dojo ON public.marketing_broadcasts(dojo_id);
