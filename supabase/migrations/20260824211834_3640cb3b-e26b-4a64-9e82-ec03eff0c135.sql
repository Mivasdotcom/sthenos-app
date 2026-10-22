CREATE OR REPLACE FUNCTION public.guard_member_self_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auth_email text;
  v_agreements boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF public.is_dojo_staff(auth.uid(), NEW.dojo_id) THEN
    RETURN NEW;
  END IF;

  v_agreements := coalesce(current_setting('app.agreements_rpc', true), '') = '1';

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

  IF auth.uid() = OLD.user_id AND NEW.user_id = OLD.user_id THEN
    IF NOT v_agreements AND (
         NEW.waiver_version_accepted IS DISTINCT FROM OLD.waiver_version_accepted
      OR NEW.waiver_audience_accepted IS DISTINCT FROM OLD.waiver_audience_accepted
      OR NEW.waiver_signed_by IS DISTINCT FROM OLD.waiver_signed_by
      OR NEW.waiver_signed_at IS DISTINCT FROM OLD.waiver_signed_at
      OR NEW.terms_version_accepted IS DISTINCT FROM OLD.terms_version_accepted
      OR NEW.terms_accepted_at IS DISTINCT FROM OLD.terms_accepted_at
    ) THEN
      RAISE EXCEPTION 'Agreement acceptances must be recorded through accept_my_agreements';
    END IF;

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
       OR NEW.date_of_birth IS DISTINCT FROM OLD.date_of_birth
       OR NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at
       OR NEW.payment_status IS DISTINCT FROM OLD.payment_status
       OR NEW.payment_status_updated_at IS DISTINCT FROM OLD.payment_status_updated_at
       OR NEW.selected_plan_id IS DISTINCT FROM OLD.selected_plan_id
       OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
       OR (NOT v_agreements AND NEW.waiver_signed_at IS DISTINCT FROM OLD.waiver_signed_at)
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
$$;

REVOKE ALL ON FUNCTION public.guard_member_self_update() FROM anon, authenticated;