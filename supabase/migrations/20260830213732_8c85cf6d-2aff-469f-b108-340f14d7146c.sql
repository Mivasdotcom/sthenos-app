ALTER TABLE public.dojos ADD COLUMN IF NOT EXISTS privacy_contact_email text;
GRANT SELECT (privacy_contact_email) ON public.dojos TO authenticated;

CREATE TABLE public.dojo_privacy_notices (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1,
  title text NOT NULL DEFAULT 'Privacy notice',
  body_markdown text NOT NULL DEFAULT '',
  is_current boolean NOT NULL DEFAULT false,
  published_at timestamp with time zone,
  published_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX dojo_privacy_notices_current_idx
  ON public.dojo_privacy_notices (dojo_id) WHERE is_current;
CREATE UNIQUE INDEX dojo_privacy_notices_version_idx
  ON public.dojo_privacy_notices (dojo_id, version);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.dojo_privacy_notices TO authenticated;
GRANT ALL ON public.dojo_privacy_notices TO service_role;

ALTER TABLE public.dojo_privacy_notices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view their dojo privacy notices"
  ON public.dojo_privacy_notices FOR SELECT TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE POLICY "Owners and admins can create privacy notices"
  ON public.dojo_privacy_notices FOR INSERT TO authenticated
  WITH CHECK (
    public.has_dojo_role(auth.uid(), dojo_id, 'owner')
    OR public.has_dojo_role(auth.uid(), dojo_id, 'admin')
  );

CREATE POLICY "Owners and admins can update privacy notices"
  ON public.dojo_privacy_notices FOR UPDATE TO authenticated
  USING (
    public.has_dojo_role(auth.uid(), dojo_id, 'owner')
    OR public.has_dojo_role(auth.uid(), dojo_id, 'admin')
  )
  WITH CHECK (
    public.has_dojo_role(auth.uid(), dojo_id, 'owner')
    OR public.has_dojo_role(auth.uid(), dojo_id, 'admin')
  );

CREATE POLICY "Owners can delete privacy notice drafts"
  ON public.dojo_privacy_notices FOR DELETE TO authenticated
  USING (public.has_dojo_role(auth.uid(), dojo_id, 'owner'));

CREATE TRIGGER update_dojo_privacy_notices_updated_at
  BEFORE UPDATE ON public.dojo_privacy_notices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();