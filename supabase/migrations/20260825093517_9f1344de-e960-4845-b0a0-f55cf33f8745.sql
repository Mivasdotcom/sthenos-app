CREATE TABLE public.dunning_notices (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  stripe_invoice_id text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('first','reminder','final','recovered')),
  amount_cents integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'usd',
  payment_method text,
  hosted_invoice_url text,
  first_failed_at timestamp with time zone NOT NULL DEFAULT now(),
  resolved_at timestamp with time zone,
  emailed boolean NOT NULL DEFAULT false,
  send_error text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (stripe_invoice_id, stage)
);

CREATE INDEX dunning_notices_open_idx
  ON public.dunning_notices (dojo_id, member_id)
  WHERE resolved_at IS NULL;

GRANT SELECT, UPDATE ON public.dunning_notices TO authenticated;
GRANT ALL ON public.dunning_notices TO service_role;

ALTER TABLE public.dunning_notices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view dunning notices for their dojo"
  ON public.dunning_notices FOR SELECT TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE POLICY "Members can view their own dunning notices"
  ON public.dunning_notices FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.members m
    WHERE m.id = dunning_notices.member_id AND m.user_id = auth.uid()
  ));

CREATE POLICY "Staff can update dunning notices for their dojo"
  ON public.dunning_notices FOR UPDATE TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE TRIGGER update_dunning_notices_updated_at
  BEFORE UPDATE ON public.dunning_notices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();