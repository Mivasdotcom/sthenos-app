-- 1. Waiver: updated_at + version bump support
ALTER TABLE public.dojo_waivers ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
DROP TRIGGER IF EXISTS dojo_waivers_updated_at ON public.dojo_waivers;
CREATE TRIGGER dojo_waivers_updated_at BEFORE UPDATE ON public.dojo_waivers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Terms & Conditions table
CREATE TABLE IF NOT EXISTS public.dojo_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  version smallint NOT NULL DEFAULT 1,
  title text NOT NULL DEFAULT 'Membership Terms & Conditions',
  body_markdown text NOT NULL DEFAULT '',
  is_current boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS dojo_terms_current_unique
  ON public.dojo_terms (dojo_id) WHERE is_current;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.dojo_terms TO authenticated;
GRANT ALL ON public.dojo_terms TO service_role;

ALTER TABLE public.dojo_terms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dojo_terms read own dojo" ON public.dojo_terms
  FOR SELECT TO authenticated
  USING (public.user_is_in_dojo(auth.uid(), dojo_id));

CREATE POLICY "dojo_terms owner admin insert" ON public.dojo_terms
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_dojo_role(auth.uid(), dojo_id, 'owner'::public.dojo_role)
    OR public.has_dojo_role(auth.uid(), dojo_id, 'admin'::public.dojo_role)
  );

CREATE POLICY "dojo_terms owner admin update" ON public.dojo_terms
  FOR UPDATE TO authenticated
  USING (
    public.has_dojo_role(auth.uid(), dojo_id, 'owner'::public.dojo_role)
    OR public.has_dojo_role(auth.uid(), dojo_id, 'admin'::public.dojo_role)
  )
  WITH CHECK (
    public.has_dojo_role(auth.uid(), dojo_id, 'owner'::public.dojo_role)
    OR public.has_dojo_role(auth.uid(), dojo_id, 'admin'::public.dojo_role)
  );

CREATE POLICY "dojo_terms owner admin delete" ON public.dojo_terms
  FOR DELETE TO authenticated
  USING (
    public.has_dojo_role(auth.uid(), dojo_id, 'owner'::public.dojo_role)
    OR public.has_dojo_role(auth.uid(), dojo_id, 'admin'::public.dojo_role)
  );

DROP TRIGGER IF EXISTS dojo_terms_updated_at ON public.dojo_terms;
CREATE TRIGGER dojo_terms_updated_at BEFORE UPDATE ON public.dojo_terms
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. Gym-level consent collection toggle
ALTER TABLE public.dojos
  ADD COLUMN IF NOT EXISTS collect_media_consent boolean NOT NULL DEFAULT true;

-- 4. Member acceptance version tracking
ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS waiver_version_accepted smallint,
  ADD COLUMN IF NOT EXISTS terms_version_accepted smallint,
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;

-- 5. Guard: members may not self-edit accepted versions except via the RPC below
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

-- 6. Member re-acceptance RPC
CREATE OR REPLACE FUNCTION public.accept_my_agreements(
  p_member_id uuid,
  p_signed_name text DEFAULT NULL,
  p_accept_waiver boolean DEFAULT false,
  p_accept_terms boolean DEFAULT false
)
 RETURNS public.members
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.members;
  v_waiver record;
  v_terms record;
  v_name text;
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

  SELECT id, version INTO v_waiver
    FROM public.dojo_waivers
   WHERE dojo_id = v_row.dojo_id AND is_current
   LIMIT 1;

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
      (member_id, dojo_id, waiver_id, waiver_version, signed_name, signature_text, signed_at)
    VALUES
      (v_row.id, v_row.dojo_id, v_waiver.id, v_waiver.version, v_name, v_name, now());

    UPDATE public.members
       SET waiver_version_accepted = v_waiver.version,
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

REVOKE ALL ON FUNCTION public.accept_my_agreements(uuid, text, boolean, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_my_agreements(uuid, text, boolean, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.accept_my_agreements(uuid, text, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_my_agreements(uuid, text, boolean, boolean) TO service_role;

-- 7. Backfill accepted waiver versions from existing signatures
UPDATE public.members m
   SET waiver_version_accepted = sub.waiver_version
  FROM (
    SELECT DISTINCT ON (member_id) member_id, waiver_version
      FROM public.member_waivers
     ORDER BY member_id, signed_at DESC
  ) sub
 WHERE sub.member_id = m.id
   AND m.waiver_version_accepted IS NULL
   AND sub.waiver_version IS NOT NULL;

-- 8. Seed a starter Terms & Conditions for existing gyms
INSERT INTO public.dojo_terms (dojo_id, title, body_markdown, version, is_current)
SELECT d.id,
       'Membership Terms & Conditions',
       E'1. Membership and payment\nMembership fees are due at the start of each billing period. Late or failed payments may result in access being paused until the balance is cleared.\n\n2. Cancellation notice\nMemberships may be cancelled with 30 days'' written notice. Your access continues until the end of the notice period.\n\n3. Class etiquette\nArrive on time, train in clean uniform, maintain personal hygiene, and follow instructor direction at all times. Respectful behaviour towards training partners is required.\n\n4. Guests and trials\nGuests must be registered and complete a waiver before training. Trial sessions are at the discretion of the gym.\n\n5. Injuries and safety\nReport any injury or illness to a coach before training. Members train within their own limits and must tap early when required.\n\n6. Changes to these terms\nWe may update these terms from time to time. Members will be asked to review and accept the latest version.',
       1,
       true
  FROM public.dojos d
 WHERE d.archived_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.dojo_terms t WHERE t.dojo_id = d.id);