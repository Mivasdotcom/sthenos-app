-- 1) Two active waivers per gym: adult + minor
ALTER TABLE public.dojo_waivers
  ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'adult';

ALTER TABLE public.dojo_waivers
  DROP CONSTRAINT IF EXISTS dojo_waivers_audience_check;
ALTER TABLE public.dojo_waivers
  ADD CONSTRAINT dojo_waivers_audience_check CHECK (audience IN ('adult','minor'));

DROP INDEX IF EXISTS public.dojo_waivers_one_current;
CREATE UNIQUE INDEX dojo_waivers_one_current
  ON public.dojo_waivers (dojo_id, audience) WHERE (is_current = true);

-- 2) Guardian details + accepted waiver audience on the member
ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS guardian_name text,
  ADD COLUMN IF NOT EXISTS guardian_email text,
  ADD COLUMN IF NOT EXISTS guardian_phone text,
  ADD COLUMN IF NOT EXISTS guardian_relationship text,
  ADD COLUMN IF NOT EXISTS waiver_audience_accepted text,
  ADD COLUMN IF NOT EXISTS waiver_signed_by text;

ALTER TABLE public.members DROP CONSTRAINT IF EXISTS members_waiver_audience_check;
ALTER TABLE public.members
  ADD CONSTRAINT members_waiver_audience_check
  CHECK (waiver_audience_accepted IS NULL OR waiver_audience_accepted IN ('adult','minor'));

ALTER TABLE public.members DROP CONSTRAINT IF EXISTS members_waiver_signed_by_check;
ALTER TABLE public.members
  ADD CONSTRAINT members_waiver_signed_by_check
  CHECK (waiver_signed_by IS NULL OR waiver_signed_by IN ('member','guardian'));

-- 3) Signature records carry audience + who signed
ALTER TABLE public.member_waivers
  ADD COLUMN IF NOT EXISTS waiver_audience text NOT NULL DEFAULT 'adult',
  ADD COLUMN IF NOT EXISTS signed_by text NOT NULL DEFAULT 'member',
  ADD COLUMN IF NOT EXISTS guardian_email text,
  ADD COLUMN IF NOT EXISTS guardian_phone text,
  ADD COLUMN IF NOT EXISTS guardian_relationship text;

ALTER TABLE public.member_waivers DROP CONSTRAINT IF EXISTS member_waivers_audience_check;
ALTER TABLE public.member_waivers
  ADD CONSTRAINT member_waivers_audience_check CHECK (waiver_audience IN ('adult','minor'));

ALTER TABLE public.member_waivers DROP CONSTRAINT IF EXISTS member_waivers_signed_by_check;
ALTER TABLE public.member_waivers
  ADD CONSTRAINT member_waivers_signed_by_check CHECK (signed_by IN ('member','guardian'));

-- 4) Shared default minors waiver template
INSERT INTO public.waiver_templates (name, discipline, body_markdown, dojo_id)
SELECT
  'Minors waiver (parent/guardian)',
  NULL::text,
  'PARENT OR GUARDIAN DECLARATION — MEMBER UNDER 18

I confirm that I am the parent or legal guardian of the member named below and that I have the legal authority to sign this waiver on their behalf.

I acknowledge that martial arts training involves physical contact, physical exertion and a risk of injury. I have explained these risks to the member in terms they understand.

I confirm the member is in good physical health and has no medical condition that would make participation unsafe. I have disclosed any relevant condition, injury, allergy or medication to the gym.

I agree that the member will follow all gym rules, safety instructions and coach direction at all times, and I accept responsibility for their conduct while on the premises.

On behalf of the member and myself, I release the gym, its owners, coaches and staff from liability for injury, loss or damage arising from the member''s participation, except where caused by negligence that cannot be excluded by law.

I consent to emergency medical treatment being arranged for the member if it is needed and I cannot be reached immediately.

I confirm my contact details given at signup are correct and that I will inform the gym if they change. This declaration is binding on me, the member, and our heirs and legal representatives.',
  NULL::uuid
WHERE NOT EXISTS (
  SELECT 1 FROM public.waiver_templates
   WHERE dojo_id IS NULL AND name = 'Minors waiver (parent/guardian)'
);

-- 5) Portal acceptance picks the right waiver for the member's age
CREATE OR REPLACE FUNCTION public.accept_my_agreements(p_member_id uuid, p_signed_name text DEFAULT NULL::text, p_accept_waiver boolean DEFAULT false, p_accept_terms boolean DEFAULT false)
 RETURNS members
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.members;
  v_waiver record;
  v_terms record;
  v_name text;
  v_minor boolean;
  v_audience text;
  v_signed_by text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_row FROM public.members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Member not found';
  END IF;
  IF v_row.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  v_name := NULLIF(btrim(coalesce(p_signed_name, '')), '');

  v_minor := v_row.date_of_birth IS NOT NULL
             AND v_row.date_of_birth > (current_date - interval '18 years');

  SELECT * INTO v_waiver
    FROM public.dojo_waivers
   WHERE dojo_id = v_row.dojo_id AND is_current
     AND audience = CASE WHEN v_minor THEN 'minor' ELSE 'adult' END
   LIMIT 1;

  IF v_waiver.id IS NULL THEN
    SELECT * INTO v_waiver
      FROM public.dojo_waivers
     WHERE dojo_id = v_row.dojo_id AND is_current AND audience = 'adult'
     LIMIT 1;
  END IF;

  v_audience := coalesce(v_waiver.audience, 'adult');
  v_signed_by := CASE WHEN v_minor THEN 'guardian' ELSE 'member' END;

  SELECT id, version, body_markdown INTO v_terms
    FROM public.dojo_terms
   WHERE dojo_id = v_row.dojo_id AND is_current
   LIMIT 1;

  PERFORM set_config('app.agreements_rpc', '1', true);

  IF p_accept_waiver AND v_waiver.id IS NOT NULL THEN
    IF v_name IS NULL THEN
      RAISE EXCEPTION 'Please type your full name to sign';
    END IF;
    INSERT INTO public.member_waivers
      (member_id, dojo_id, waiver_id, waiver_version, signed_name, signature_text, signed_at,
       waiver_audience, signed_by, guardian_name, guardian_email, guardian_phone, guardian_relationship)
    VALUES
      (v_row.id, v_row.dojo_id, v_waiver.id, v_waiver.version, v_name, v_name, now(),
       v_audience, v_signed_by,
       CASE WHEN v_signed_by = 'guardian' THEN coalesce(v_row.guardian_name, v_name) ELSE NULL END,
       CASE WHEN v_signed_by = 'guardian' THEN v_row.guardian_email ELSE NULL END,
       CASE WHEN v_signed_by = 'guardian' THEN v_row.guardian_phone ELSE NULL END,
       CASE WHEN v_signed_by = 'guardian' THEN v_row.guardian_relationship ELSE NULL END);

    UPDATE public.members
       SET waiver_version_accepted = v_waiver.version,
           waiver_audience_accepted = v_audience,
           waiver_signed_by = v_signed_by,
           waiver_signed_at = now(),
           updated_at = now()
     WHERE id = v_row.id;
  END IF;

  IF p_accept_terms AND v_terms.id IS NOT NULL AND btrim(v_terms.body_markdown) <> '' THEN
    UPDATE public.members
       SET terms_version_accepted = v_terms.version,
           terms_accepted_at = now(),
           updated_at = now()
     WHERE id = v_row.id;
  END IF;

  PERFORM set_config('app.agreements_rpc', '0', true);

  SELECT * INTO v_row FROM public.members WHERE id = p_member_id;
  RETURN v_row;
END;
$function$;

-- 6) Existing signed waivers keep their meaning; backfill accepted audience
UPDATE public.members
   SET waiver_audience_accepted = 'adult',
       waiver_signed_by = 'member'
 WHERE waiver_version_accepted IS NOT NULL
   AND waiver_audience_accepted IS NULL;

-- 7) Guardian-column edits by the member themselves must stay controlled
CREATE OR REPLACE FUNCTION public.guard_member_self_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_auth_email text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF public.is_dojo_staff(auth.uid(), NEW.dojo_id) THEN
    RETURN NEW;
  END IF;

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
    IF coalesce(current_setting('app.agreements_rpc', true), '') <> '1' AND (
         NEW.waiver_version_accepted IS DISTINCT FROM OLD.waiver_version_accepted
      OR NEW.waiver_audience_accepted IS DISTINCT FROM OLD.waiver_audience_accepted
      OR NEW.waiver_signed_by IS DISTINCT FROM OLD.waiver_signed_by
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