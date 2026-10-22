-- Enum additions (must not be used within this same transaction)
ALTER TYPE public.invoice_status ADD VALUE IF NOT EXISTS 'partially_refunded';
ALTER TYPE public.invoice_status ADD VALUE IF NOT EXISTS 'refunded';
ALTER TYPE public.member_payment_status ADD VALUE IF NOT EXISTS 'disputed';

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS refunded_amount_cents integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  member_id uuid REFERENCES public.members(id) ON DELETE SET NULL,
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  stripe_refund_id text NOT NULL UNIQUE,
  stripe_charge_id text,
  stripe_payment_intent_id text,
  amount_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  reason text,
  status text NOT NULL DEFAULT 'succeeded',
  source text NOT NULL DEFAULT 'app',
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.refunds TO authenticated;
GRANT ALL ON public.refunds TO service_role;
ALTER TABLE public.refunds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view dojo refunds"
  ON public.refunds FOR SELECT TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE INDEX IF NOT EXISTS idx_refunds_dojo ON public.refunds(dojo_id);
CREATE INDEX IF NOT EXISTS idx_refunds_invoice ON public.refunds(invoice_id);
CREATE INDEX IF NOT EXISTS idx_refunds_member ON public.refunds(member_id);

CREATE TRIGGER update_refunds_updated_at
  BEFORE UPDATE ON public.refunds
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  member_id uuid REFERENCES public.members(id) ON DELETE SET NULL,
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  stripe_dispute_id text NOT NULL UNIQUE,
  stripe_charge_id text,
  stripe_payment_intent_id text,
  amount_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  reason text,
  status text NOT NULL,
  evidence_due_by timestamptz,
  outcome text,
  closed_at timestamptz,
  last_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.disputes TO authenticated;
GRANT ALL ON public.disputes TO service_role;
ALTER TABLE public.disputes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view dojo disputes"
  ON public.disputes FOR SELECT TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE INDEX IF NOT EXISTS idx_disputes_dojo ON public.disputes(dojo_id);
CREATE INDEX IF NOT EXISTS idx_disputes_member ON public.disputes(member_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON public.disputes(dojo_id, status);

CREATE TRIGGER update_disputes_updated_at
  BEFORE UPDATE ON public.disputes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();