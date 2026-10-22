
-- 1. Rename enum values (preserves all existing data and policy constants)
ALTER TYPE public.app_role RENAME VALUE 'owner' TO 'manager';
ALTER TYPE public.dojo_role RENAME VALUE 'owner' TO 'manager';

-- 2. Update functions that referenced the 'owner' label in source text
CREATE OR REPLACE FUNCTION public.is_staff(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role IN ('manager','coach')
  )
$$;

CREATE OR REPLACE FUNCTION public.is_dojo_staff(_user_id uuid, _dojo_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.dojo_memberships
    WHERE user_id = _user_id
      AND dojo_id = _dojo_id
      AND role IN ('manager','admin','coach')
  )
$$;

CREATE OR REPLACE FUNCTION public.ensure_owner_member_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_email text;
  v_name text;
BEGIN
  IF NEW.role <> 'manager' THEN RETURN NEW; END IF;

  IF EXISTS (SELECT 1 FROM public.members
             WHERE dojo_id = NEW.dojo_id AND user_id = NEW.user_id) THEN
    RETURN NEW;
  END IF;

  SELECT email, display_name INTO v_email, v_name
  FROM public.profiles WHERE user_id = NEW.user_id;

  INSERT INTO public.members
    (dojo_id, user_id, name, email, discipline, plan, status, payment_status)
  VALUES
    (NEW.dojo_id,
     NEW.user_id,
     COALESCE(v_name, split_part(COALESCE(v_email,'manager'),'@',1)),
     v_email,
     'BJJ'::public.discipline,
     'Monthly'::public.plan_type,
     'active'::public.member_status,
     'current'::public.member_payment_status);
  RETURN NEW;
END;
$$;

-- 3. Restrict class editing to manager only (read stays open to dojo members)
DROP POLICY IF EXISTS "classes staff manage in dojo" ON public.classes;
CREATE POLICY "classes manager manage in dojo"
ON public.classes
FOR ALL
USING (public.has_dojo_role(auth.uid(), dojo_id, 'manager'::public.dojo_role))
WITH CHECK (public.has_dojo_role(auth.uid(), dojo_id, 'manager'::public.dojo_role));
