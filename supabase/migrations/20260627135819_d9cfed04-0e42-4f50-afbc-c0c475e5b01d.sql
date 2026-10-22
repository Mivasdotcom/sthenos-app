CREATE TABLE public.cancellation_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('requested','confirmed','dismissed')),
  reason text,
  actor_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.cancellation_audit_log TO authenticated;
GRANT ALL ON public.cancellation_audit_log TO service_role;

ALTER TABLE public.cancellation_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "staff read dojo cancellation log"
  ON public.cancellation_audit_log FOR SELECT TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE POLICY "member read own cancellation log"
  ON public.cancellation_audit_log FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.members m WHERE m.id = member_id AND m.user_id = auth.uid()));

CREATE POLICY "authenticated insert cancellation log"
  ON public.cancellation_audit_log FOR INSERT TO authenticated
  WITH CHECK (
    public.is_dojo_staff(auth.uid(), dojo_id)
    OR EXISTS (SELECT 1 FROM public.members m WHERE m.id = member_id AND m.user_id = auth.uid())
  );

CREATE INDEX idx_cancellation_audit_log_member ON public.cancellation_audit_log(member_id, created_at DESC);
CREATE INDEX idx_cancellation_audit_log_dojo ON public.cancellation_audit_log(dojo_id, created_at DESC);