
-- ============ ENUM TYPES ============
CREATE TYPE public.app_role AS ENUM ('owner', 'coach', 'member');
CREATE TYPE public.discipline AS ENUM ('BJJ', 'Judo', 'Karate', 'Muay Thai');
CREATE TYPE public.belt_color AS ENUM ('white','yellow','orange','green','blue','purple','brown','red','black');
CREATE TYPE public.member_status AS ENUM ('active','lapsed','trial');
CREATE TYPE public.plan_type AS ENUM ('Monthly','Annual','Drop-in','Family');
CREATE TYPE public.invoice_status AS ENUM ('paid','due','overdue');

-- ============ UPDATED_AT HELPER ============
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- ============ PROFILES ============
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  email TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ USER ROLES ============
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, role)
);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Security-definer role check (avoids RLS recursion)
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

CREATE OR REPLACE FUNCTION public.is_staff(_user_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role IN ('owner','coach')
  )
$$;

-- ============ AUTO-CREATE PROFILE + ASSIGN ROLE ON SIGNUP ============
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_is_first BOOLEAN;
BEGIN
  INSERT INTO public.profiles (user_id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', split_part(NEW.email,'@',1))
  );

  SELECT NOT EXISTS (SELECT 1 FROM public.user_roles) INTO v_is_first;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, CASE WHEN v_is_first THEN 'owner'::public.app_role ELSE 'member'::public.app_role END);

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============ MEMBERS (gym roster) ============
CREATE TABLE public.members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  discipline public.discipline NOT NULL,
  belt_color public.belt_color NOT NULL DEFAULT 'white',
  belt_label TEXT NOT NULL DEFAULT 'White Belt',
  stripes SMALLINT NOT NULL DEFAULT 0 CHECK (stripes BETWEEN 0 AND 4),
  dan SMALLINT CHECK (dan IS NULL OR dan BETWEEN 1 AND 10),
  status public.member_status NOT NULL DEFAULT 'active',
  plan public.plan_type NOT NULL DEFAULT 'Monthly',
  joined_at DATE NOT NULL DEFAULT CURRENT_DATE,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.members ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_members_discipline ON public.members(discipline);
CREATE INDEX idx_members_status ON public.members(status);
CREATE TRIGGER members_updated_at BEFORE UPDATE ON public.members
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ CLASSES ============
CREATE TABLE public.classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  discipline public.discipline NOT NULL,
  instructor TEXT NOT NULL,
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0=Sun
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  capacity SMALLINT NOT NULL DEFAULT 20,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.classes ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER classes_updated_at BEFORE UPDATE ON public.classes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ ATTENDANCES ============
CREATE TABLE public.attendances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  class_id UUID REFERENCES public.classes(id) ON DELETE SET NULL,
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.attendances ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_attendances_member ON public.attendances(member_id);
CREATE INDEX idx_attendances_checked_in ON public.attendances(checked_in_at);

-- ============ PROMOTIONS ============
CREATE TABLE public.promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  discipline public.discipline NOT NULL,
  from_color public.belt_color NOT NULL,
  from_label TEXT NOT NULL,
  from_stripes SMALLINT NOT NULL DEFAULT 0,
  from_dan SMALLINT,
  to_color public.belt_color NOT NULL,
  to_label TEXT NOT NULL,
  to_stripes SMALLINT NOT NULL DEFAULT 0,
  to_dan SMALLINT,
  awarded_by TEXT,
  note TEXT,
  promoted_at DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_promotions_member ON public.promotions(member_id);

-- ============ INVOICES ============
CREATE TABLE public.invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  plan public.plan_type NOT NULL,
  status public.invoice_status NOT NULL DEFAULT 'due',
  due_date DATE NOT NULL,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_invoices_member ON public.invoices(member_id);
CREATE INDEX idx_invoices_status ON public.invoices(status);
CREATE TRIGGER invoices_updated_at BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ RLS POLICIES ============

-- profiles: read own, read all if staff; update own
CREATE POLICY "profiles read own" ON public.profiles FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_staff(auth.uid()));
CREATE POLICY "profiles update own" ON public.profiles FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);

-- user_roles: users see own roles; owners see all and manage
CREATE POLICY "user_roles read own" ON public.user_roles FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(),'owner'));
CREATE POLICY "user_roles owner manage" ON public.user_roles FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'owner'))
  WITH CHECK (public.has_role(auth.uid(),'owner'));

-- members: staff full access; members read own
CREATE POLICY "members staff all" ON public.members FOR ALL TO authenticated
  USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));
CREATE POLICY "members read own" ON public.members FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- classes: staff manage; any authenticated user can read
CREATE POLICY "classes read all auth" ON public.classes FOR SELECT TO authenticated USING (true);
CREATE POLICY "classes staff manage" ON public.classes FOR ALL TO authenticated
  USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

-- attendances: staff full; member reads own
CREATE POLICY "attendances staff all" ON public.attendances FOR ALL TO authenticated
  USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));
CREATE POLICY "attendances read own" ON public.attendances FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.members m WHERE m.id = attendances.member_id AND m.user_id = auth.uid()));

-- promotions: staff full; member reads own
CREATE POLICY "promotions staff all" ON public.promotions FOR ALL TO authenticated
  USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));
CREATE POLICY "promotions read own" ON public.promotions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.members m WHERE m.id = promotions.member_id AND m.user_id = auth.uid()));

-- invoices: staff full; member reads own
CREATE POLICY "invoices staff all" ON public.invoices FOR ALL TO authenticated
  USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));
CREATE POLICY "invoices read own" ON public.invoices FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.members m WHERE m.id = invoices.member_id AND m.user_id = auth.uid()));
