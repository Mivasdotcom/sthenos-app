
-- =========================================================
-- Phase 1: owner ↔ member self-row trigger
-- Phase 2a: schema for public signup, waivers, payments
-- =========================================================

ALTER TABLE public.dojos
  ADD COLUMN IF NOT EXISTS public_page_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tagline text,
  ADD COLUMN IF NOT EXISTS hero_image_url text,
  ADD COLUMN IF NOT EXISTS hold_grace_days smallint NOT NULL DEFAULT 5;

CREATE POLICY "dojos public read when enabled"
  ON public.dojos FOR SELECT TO anon
  USING (public_page_enabled = true);
GRANT SELECT ON public.dojos TO anon;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'member_payment_status') THEN
    CREATE TYPE public.member_payment_status AS ENUM ('current','due','overdue','none');
  END IF;
END $$;

ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS payment_status public.member_payment_status NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS payment_status_updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS waiver_signed_at timestamptz;

CREATE TABLE IF NOT EXISTS public.waiver_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  discipline text,
  body_markdown text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.waiver_templates TO anon, authenticated;
GRANT ALL ON public.waiver_templates TO service_role;
ALTER TABLE public.waiver_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "waiver_templates public read"
  ON public.waiver_templates FOR SELECT TO anon, authenticated USING (true);

INSERT INTO public.waiver_templates (name, discipline, body_markdown) VALUES
  ('General Martial Arts Release', 'general',
   E'# Release of Liability\n\nI acknowledge that participation in martial arts training involves inherent risks of injury. I voluntarily assume all such risks and release the dojo, its instructors, and staff from any claims arising from my participation.\n\nI confirm I am physically able to train and will notify staff of any medical conditions.'),
  ('Brazilian Jiu-Jitsu Waiver', 'bjj',
   E'# BJJ Training Waiver\n\nI understand that Brazilian Jiu-Jitsu is a contact grappling sport that involves submission holds, takedowns, and the risk of injury. I voluntarily assume these risks and release all liability against the academy and training partners.'),
  ('Muay Thai / Striking Waiver', 'striking',
   E'# Striking Sports Waiver\n\nI understand that Muay Thai and striking sports involve heavy contact, including strikes to the head and body, and carry risk of injury. I voluntarily assume these risks and release liability against the gym and training partners.'),
  ('Kids Program Waiver (Parent/Guardian)', 'kids',
   E'# Kids Program — Parent / Guardian Waiver\n\nAs the parent or legal guardian of the minor named in this registration, I acknowledge the inherent risks of martial arts training and consent to my child''s participation. I release the dojo from liability for injuries sustained during normal training activities.')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.dojo_waivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  version smallint NOT NULL DEFAULT 1,
  title text NOT NULL DEFAULT 'Training Waiver',
  body_markdown text NOT NULL,
  is_current boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS dojo_waivers_one_current
  ON public.dojo_waivers (dojo_id) WHERE is_current = true;

GRANT SELECT ON public.dojo_waivers TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dojo_waivers TO authenticated;
GRANT ALL ON public.dojo_waivers TO service_role;
ALTER TABLE public.dojo_waivers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dojo_waivers public read current when dojo public"
  ON public.dojo_waivers FOR SELECT TO anon
  USING (is_current = true AND EXISTS (
    SELECT 1 FROM public.dojos d
    WHERE d.id = dojo_waivers.dojo_id AND d.public_page_enabled = true
  ));

CREATE POLICY "dojo_waivers staff manage"
  ON public.dojo_waivers FOR ALL TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE POLICY "dojo_waivers member read own dojo"
  ON public.dojo_waivers FOR SELECT TO authenticated
  USING (public.user_is_in_dojo(auth.uid(), dojo_id));

CREATE TABLE IF NOT EXISTS public.member_waivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  waiver_id uuid REFERENCES public.dojo_waivers(id),
  waiver_version smallint,
  signed_name text NOT NULL,
  signature_text text NOT NULL,
  guardian_name text,
  ip_address text,
  user_agent text,
  signed_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.member_waivers TO authenticated;
GRANT ALL ON public.member_waivers TO service_role;
ALTER TABLE public.member_waivers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "member_waivers read own"
  ON public.member_waivers FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.members m
                 WHERE m.id = member_waivers.member_id AND m.user_id = auth.uid()));

CREATE POLICY "member_waivers staff in dojo"
  ON public.member_waivers FOR ALL TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE TABLE IF NOT EXISTS public.member_payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL UNIQUE REFERENCES public.members(id) ON DELETE CASCADE,
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  stripe_customer_id text NOT NULL,
  stripe_payment_method_id text,
  brand text,
  last4 text,
  exp_month smallint,
  exp_year smallint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.member_payment_methods TO authenticated;
GRANT ALL ON public.member_payment_methods TO service_role;
ALTER TABLE public.member_payment_methods ENABLE ROW LEVEL SECURITY;

CREATE POLICY "member_payment_methods read own"
  ON public.member_payment_methods FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.members m
                 WHERE m.id = member_payment_methods.member_id AND m.user_id = auth.uid()));

CREATE POLICY "member_payment_methods staff in dojo"
  ON public.member_payment_methods FOR ALL TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE TABLE IF NOT EXISTS public.dojo_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  price_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  interval text NOT NULL DEFAULT 'month',
  stripe_price_id text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.dojo_plans TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.dojo_plans TO authenticated;
GRANT ALL ON public.dojo_plans TO service_role;
ALTER TABLE public.dojo_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dojo_plans public read when dojo public"
  ON public.dojo_plans FOR SELECT TO anon
  USING (is_active = true AND EXISTS (
    SELECT 1 FROM public.dojos d
    WHERE d.id = dojo_plans.dojo_id AND d.public_page_enabled = true
  ));

CREATE POLICY "dojo_plans members read in dojo"
  ON public.dojo_plans FOR SELECT TO authenticated
  USING (public.user_is_in_dojo(auth.uid(), dojo_id));

CREATE POLICY "dojo_plans staff manage"
  ON public.dojo_plans FOR ALL TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE TRIGGER dojo_plans_updated_at
  BEFORE UPDATE ON public.dojo_plans
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER member_payment_methods_updated_at
  BEFORE UPDATE ON public.member_payment_methods
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Phase 1: ensure owner has a members row in their dojo
CREATE OR REPLACE FUNCTION public.ensure_owner_member_row()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_email text;
  v_name text;
BEGIN
  IF NEW.role <> 'owner' THEN RETURN NEW; END IF;

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
     COALESCE(v_name, split_part(COALESCE(v_email,'owner'),'@',1)),
     v_email,
     'BJJ'::public.discipline,
     'Monthly'::public.plan_type,
     'active'::public.member_status,
     'current'::public.member_payment_status);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ensure_owner_member_row_trg ON public.dojo_memberships;
CREATE TRIGGER ensure_owner_member_row_trg
  AFTER INSERT ON public.dojo_memberships
  FOR EACH ROW EXECUTE FUNCTION public.ensure_owner_member_row();

INSERT INTO public.members (dojo_id, user_id, name, email, discipline, plan, status, payment_status)
SELECT dm.dojo_id, dm.user_id,
       COALESCE(p.display_name, split_part(p.email,'@',1), 'Owner'),
       p.email,
       'BJJ'::public.discipline,
       'Monthly'::public.plan_type,
       'active'::public.member_status,
       'current'::public.member_payment_status
FROM public.dojo_memberships dm
LEFT JOIN public.profiles p ON p.user_id = dm.user_id
WHERE dm.role = 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM public.members m
    WHERE m.dojo_id = dm.dojo_id AND m.user_id = dm.user_id
  );
