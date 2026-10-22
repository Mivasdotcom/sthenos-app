ALTER TABLE public.dojos
  ADD COLUMN IF NOT EXISTS price_change_notice_days smallint NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS paused_members_can_book boolean NOT NULL DEFAULT false;

ALTER TYPE public.member_status ADD VALUE IF NOT EXISTS 'paused';

ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS plan_price_cents integer,
  ADD COLUMN IF NOT EXISTS plan_price_locked_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS pending_price_cents integer,
  ADD COLUMN IF NOT EXISTS pending_price_effective_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS paused_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS pause_reason text,
  ADD COLUMN IF NOT EXISTS pause_note text,
  ADD COLUMN IF NOT EXISTS pause_resumes_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS status_before_pause public.member_status;

CREATE TABLE IF NOT EXISTS public.plan_price_changes (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES public.dojo_plans(id) ON DELETE CASCADE,
  old_price_cents integer NOT NULL,
  new_price_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  scope text NOT NULL DEFAULT 'new_members' CHECK (scope IN ('new_members','all_members')),
  notice_days smallint NOT NULL DEFAULT 30,
  decided_at timestamp with time zone NOT NULL DEFAULT now(),
  effective_at timestamp with time zone NOT NULL,
  decided_by uuid REFERENCES auth.users(id),
  members_affected integer NOT NULL DEFAULT 0,
  member_ids uuid[] NOT NULL DEFAULT '{}',
  old_total_cents integer NOT NULL DEFAULT 0,
  new_total_cents integer NOT NULL DEFAULT 0,
  applied_at timestamp with time zone,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.plan_price_changes TO authenticated;
GRANT ALL ON public.plan_price_changes TO service_role;
ALTER TABLE public.plan_price_changes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff view plan price changes"
ON public.plan_price_changes FOR SELECT TO authenticated
USING (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE POLICY "Staff record plan price changes"
ON public.plan_price_changes FOR INSERT TO authenticated
WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE POLICY "Staff update plan price changes"
ON public.plan_price_changes FOR UPDATE TO authenticated
USING (public.is_dojo_staff(auth.uid(), dojo_id))
WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE TABLE IF NOT EXISTS public.membership_pauses (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  reason text NOT NULL DEFAULT 'other' CHECK (reason IN ('injury','travel','other')),
  note text,
  paused_at timestamp with time zone NOT NULL DEFAULT now(),
  resume_at timestamp with time zone,
  resumed_at timestamp with time zone,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','resumed','canceled')),
  scope text NOT NULL DEFAULT 'member' CHECK (scope IN ('member','family')),
  family_group_id uuid REFERENCES public.family_groups(id) ON DELETE SET NULL,
  stripe_subscription_id text,
  stripe_paused boolean NOT NULL DEFAULT false,
  status_before public.member_status,
  payment_status_before public.member_payment_status,
  reminder_sent_at timestamp with time zone,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS membership_pauses_member_idx ON public.membership_pauses(member_id, status);
CREATE INDEX IF NOT EXISTS membership_pauses_resume_idx ON public.membership_pauses(status, resume_at);

GRANT SELECT, INSERT, UPDATE ON public.membership_pauses TO authenticated;
GRANT ALL ON public.membership_pauses TO service_role;
ALTER TABLE public.membership_pauses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff view membership pauses"
ON public.membership_pauses FOR SELECT TO authenticated
USING (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE POLICY "Members view their own pauses"
ON public.membership_pauses FOR SELECT TO authenticated
USING (member_id IN (SELECT id FROM public.members WHERE user_id = auth.uid()));

CREATE POLICY "Staff create membership pauses"
ON public.membership_pauses FOR INSERT TO authenticated
WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE POLICY "Staff update membership pauses"
ON public.membership_pauses FOR UPDATE TO authenticated
USING (public.is_dojo_staff(auth.uid(), dojo_id))
WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE TRIGGER update_plan_price_changes_updated_at
BEFORE UPDATE ON public.plan_price_changes
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_membership_pauses_updated_at
BEFORE UPDATE ON public.membership_pauses
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();