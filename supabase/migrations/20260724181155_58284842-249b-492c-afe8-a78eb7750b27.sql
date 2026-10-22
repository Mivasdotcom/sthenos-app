
CREATE TABLE public.member_deletion_audit_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  member_id uuid,
  member_name text NOT NULL,
  member_email text,
  actor_user_id uuid,
  reason text,
  stripe_subscription_canceled boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.member_deletion_audit_log TO authenticated;
GRANT ALL ON public.member_deletion_audit_log TO service_role;

ALTER TABLE public.member_deletion_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Dojo owners/admins can read deletion audit"
  ON public.member_deletion_audit_log
  FOR SELECT
  TO authenticated
  USING (
    public.has_dojo_role(auth.uid(), dojo_id, 'owner'::public.dojo_role)
    OR public.has_dojo_role(auth.uid(), dojo_id, 'admin'::public.dojo_role)
  );

CREATE INDEX idx_member_deletion_audit_dojo ON public.member_deletion_audit_log(dojo_id, deleted_at DESC);

-- Allow invoices to survive member deletion by nulling the link.
ALTER TABLE public.invoices ALTER COLUMN member_id DROP NOT NULL;
