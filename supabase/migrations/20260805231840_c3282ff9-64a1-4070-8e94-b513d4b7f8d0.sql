ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS retention_risk_level text,
  ADD COLUMN IF NOT EXISTS retention_risk_score integer,
  ADD COLUMN IF NOT EXISTS retention_risk_factors jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS retention_scored_at timestamptz;

ALTER TABLE public.members
  ADD CONSTRAINT members_retention_risk_level_check
  CHECK (retention_risk_level IS NULL OR retention_risk_level IN ('healthy','watch','high'));

CREATE INDEX IF NOT EXISTS members_dojo_retention_idx
  ON public.members (dojo_id, retention_risk_level);

ALTER TABLE public.workflows
  ADD COLUMN IF NOT EXISTS template_id text,
  ADD COLUMN IF NOT EXISTS action_cooldown_days integer NOT NULL DEFAULT 14;

CREATE TABLE IF NOT EXISTS public.workflow_member_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  actioned_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.workflow_member_actions TO authenticated;
GRANT ALL ON public.workflow_member_actions TO service_role;

ALTER TABLE public.workflow_member_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view workflow member actions in their dojo"
  ON public.workflow_member_actions
  FOR SELECT
  TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE INDEX IF NOT EXISTS workflow_member_actions_lookup_idx
  ON public.workflow_member_actions (workflow_id, member_id, actioned_at DESC);
CREATE INDEX IF NOT EXISTS workflow_member_actions_member_idx
  ON public.workflow_member_actions (member_id, actioned_at DESC);

CREATE OR REPLACE FUNCTION public.guard_member_self_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_auth_email text;
BEGIN
  -- System / server-side (service role, no JWT): allow.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Staff in the dojo can change anything
  IF public.is_dojo_staff(auth.uid(), NEW.dojo_id) THEN
    RETURN NEW;
  END IF;

  -- Claim branch: an unlinked member row may be claimed by the auth user whose
  -- email matches, and ONLY user_id may change.
  IF OLD.user_id IS NULL AND NEW.user_id = auth.uid() THEN
    SELECT lower(u.email) INTO v_auth_email FROM auth.users u WHERE u.id = auth.uid();
    IF v_auth_email IS NOT NULL
       AND NEW.email IS NOT NULL
       AND lower(NEW.email) = v_auth_email
       AND lower(coalesce(OLD.email,'')) = lower(coalesce(NEW.email,''))
    THEN
      IF (to_jsonb(NEW) - 'user_id' - 'updated_at') = (to_jsonb(OLD) - 'user_id' - 'updated_at') THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'Not allowed to claim this member record';
  END IF;

  -- Self-update: must be the member themselves AND only allowlisted fields may change
  IF auth.uid() = OLD.user_id AND NEW.user_id = OLD.user_id THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.dojo_id IS DISTINCT FROM OLD.dojo_id
       OR NEW.discipline IS DISTINCT FROM OLD.discipline
       OR NEW.belt_color IS DISTINCT FROM OLD.belt_color
       OR NEW.belt_label IS DISTINCT FROM OLD.belt_label
       OR NEW.stripes IS DISTINCT FROM OLD.stripes
       OR NEW.dan IS DISTINCT FROM OLD.dan
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.plan IS DISTINCT FROM OLD.plan
       OR NEW.joined_at IS DISTINCT FROM OLD.joined_at
       OR NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at
       OR NEW.payment_status IS DISTINCT FROM OLD.payment_status
       OR NEW.payment_status_updated_at IS DISTINCT FROM OLD.payment_status_updated_at
       OR NEW.selected_plan_id IS DISTINCT FROM OLD.selected_plan_id
       OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
       OR NEW.waiver_signed_at IS DISTINCT FROM OLD.waiver_signed_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.retention_risk_level IS DISTINCT FROM OLD.retention_risk_level
       OR NEW.retention_risk_score IS DISTINCT FROM OLD.retention_risk_score
       OR NEW.retention_risk_factors IS DISTINCT FROM OLD.retention_risk_factors
       OR NEW.retention_scored_at IS DISTINCT FROM OLD.retention_scored_at
    THEN
      RAISE EXCEPTION 'Members can only update their own contact info and cancellation notice';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Not allowed to update this member';
END;
$function$;