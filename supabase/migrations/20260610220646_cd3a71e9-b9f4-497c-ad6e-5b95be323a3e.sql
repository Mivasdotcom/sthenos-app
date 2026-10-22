
-- =========================================================
-- PRODUCTION-READINESS PASS (idempotent against existing FKs)
-- =========================================================

-- ---------- 1. Tighten nullability ----------
UPDATE public.invoices i
SET dojo_id = m.dojo_id
FROM public.members m
WHERE i.dojo_id IS NULL AND m.id = i.member_id;
ALTER TABLE public.invoices ALTER COLUMN dojo_id SET NOT NULL;

DELETE FROM public.classes WHERE dojo_id IS NULL;
ALTER TABLE public.classes ALTER COLUMN dojo_id SET NOT NULL;
DELETE FROM public.marketing_broadcasts WHERE dojo_id IS NULL;
ALTER TABLE public.marketing_broadcasts ALTER COLUMN dojo_id SET NOT NULL;
DELETE FROM public.workflows WHERE dojo_id IS NULL;
ALTER TABLE public.workflows ALTER COLUMN dojo_id SET NOT NULL;
DELETE FROM public.workflow_runs WHERE dojo_id IS NULL;
ALTER TABLE public.workflow_runs ALTER COLUMN dojo_id SET NOT NULL;
DELETE FROM public.segments WHERE dojo_id IS NULL;
ALTER TABLE public.segments ALTER COLUMN dojo_id SET NOT NULL;
DELETE FROM public.promotions WHERE dojo_id IS NULL;
ALTER TABLE public.promotions ALTER COLUMN dojo_id SET NOT NULL;
DELETE FROM public.attendances WHERE dojo_id IS NULL;
ALTER TABLE public.attendances ALTER COLUMN dojo_id SET NOT NULL;
DELETE FROM public.email_settings WHERE dojo_id IS NULL;
ALTER TABLE public.email_settings ALTER COLUMN dojo_id SET NOT NULL;
DELETE FROM public.internal_tasks WHERE dojo_id IS NULL;
ALTER TABLE public.internal_tasks ALTER COLUMN dojo_id SET NOT NULL;

-- ---------- 2. Missing foreign keys ----------
ALTER TABLE public.dojos
  ADD CONSTRAINT dojos_owner_user_id_fkey
    FOREIGN KEY (owner_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

ALTER TABLE public.dojo_memberships
  ADD CONSTRAINT dojo_memberships_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.dojo_waivers
  ADD CONSTRAINT dojo_waivers_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.email_settings
  ADD CONSTRAINT email_settings_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.segments
  ADD CONSTRAINT segments_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.marketing_broadcasts
  ADD CONSTRAINT marketing_broadcasts_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.workflows
  ADD CONSTRAINT workflows_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.internal_tasks
  ADD CONSTRAINT internal_tasks_member_id_fkey
    FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE CASCADE,
  ADD CONSTRAINT internal_tasks_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.view_switch_audit_log
  ADD CONSTRAINT view_switch_audit_log_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- Fix member_waivers.waiver_id from NO ACTION to SET NULL
ALTER TABLE public.member_waivers
  DROP CONSTRAINT member_waivers_waiver_id_fkey,
  ADD  CONSTRAINT member_waivers_waiver_id_fkey
    FOREIGN KEY (waiver_id) REFERENCES public.dojo_waivers(id) ON DELETE SET NULL;

-- ---------- 3. Integrity constraints ----------
ALTER TABLE public.dojo_overheads
  ADD CONSTRAINT dojo_overheads_amount_nonneg CHECK (amount_cents >= 0),
  ADD CONSTRAINT dojo_overheads_dates_valid   CHECK (ends_on IS NULL OR ends_on >= starts_on);

ALTER TABLE public.manual_revenue
  ADD CONSTRAINT manual_revenue_amount_nonneg CHECK (amount_cents >= 0);

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_amount_nonneg CHECK (amount_cents >= 0);

-- ---------- 4. Indexes ----------
CREATE INDEX IF NOT EXISTS idx_members_dojo_id          ON public.members(dojo_id);
CREATE INDEX IF NOT EXISTS idx_members_user_id          ON public.members(user_id);
CREATE INDEX IF NOT EXISTS idx_members_selected_plan_id ON public.members(selected_plan_id);
CREATE INDEX IF NOT EXISTS idx_classes_dojo_id          ON public.classes(dojo_id);
CREATE INDEX IF NOT EXISTS idx_attendances_dojo_id      ON public.attendances(dojo_id);
CREATE INDEX IF NOT EXISTS idx_attendances_member_id    ON public.attendances(member_id);
CREATE INDEX IF NOT EXISTS idx_attendances_class_id     ON public.attendances(class_id);
CREATE INDEX IF NOT EXISTS idx_attendances_checked_in_at ON public.attendances(checked_in_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_dojo_id         ON public.invoices(dojo_id);
CREATE INDEX IF NOT EXISTS idx_invoices_member_id       ON public.invoices(member_id);
CREATE INDEX IF NOT EXISTS idx_invoices_paid_at         ON public.invoices(paid_at);
CREATE INDEX IF NOT EXISTS idx_invoices_status          ON public.invoices(status);
CREATE INDEX IF NOT EXISTS idx_overheads_dojo_id        ON public.dojo_overheads(dojo_id);
CREATE INDEX IF NOT EXISTS idx_manual_revenue_dojo_id   ON public.manual_revenue(dojo_id);
CREATE INDEX IF NOT EXISTS idx_manual_revenue_received_on ON public.manual_revenue(received_on);
CREATE INDEX IF NOT EXISTS idx_dojo_plans_dojo_id       ON public.dojo_plans(dojo_id);
CREATE INDEX IF NOT EXISTS idx_promotions_member_id     ON public.promotions(member_id);
CREATE INDEX IF NOT EXISTS idx_promotions_dojo_id       ON public.promotions(dojo_id);
CREATE INDEX IF NOT EXISTS idx_member_waivers_member_id ON public.member_waivers(member_id);
CREATE INDEX IF NOT EXISTS idx_member_waivers_dojo_id   ON public.member_waivers(dojo_id);
CREATE INDEX IF NOT EXISTS idx_mpm_member_id            ON public.member_payment_methods(member_id);
CREATE INDEX IF NOT EXISTS idx_workflows_dojo_id        ON public.workflows(dojo_id);
CREATE INDEX IF NOT EXISTS idx_wfr_workflow_id          ON public.workflow_runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_wfr_dojo_id              ON public.workflow_runs(dojo_id);
CREATE INDEX IF NOT EXISTS idx_it_dojo_id               ON public.internal_tasks(dojo_id);
CREATE INDEX IF NOT EXISTS idx_it_member_id             ON public.internal_tasks(member_id);
CREATE INDEX IF NOT EXISTS idx_dojo_memberships_user_id ON public.dojo_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_dojo_memberships_dojo_id ON public.dojo_memberships(dojo_id);
CREATE INDEX IF NOT EXISTS idx_segments_dojo_id         ON public.segments(dojo_id);

-- ---------- 5. BILLING MODEL ----------

CREATE TYPE public.subscription_status AS ENUM (
  'trialing', 'active', 'past_due', 'paused', 'canceled', 'unpaid', 'incomplete'
);

CREATE TABLE public.member_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES public.dojo_plans(id) ON DELETE RESTRICT,
  status public.subscription_status NOT NULL DEFAULT 'active',
  current_period_start timestamptz,
  current_period_end timestamptz,
  trial_end timestamptz,
  cancel_at timestamptz,
  canceled_at timestamptz,
  stripe_subscription_id text UNIQUE,
  stripe_customer_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.member_subscriptions TO authenticated;
GRANT ALL ON public.member_subscriptions TO service_role;
ALTER TABLE public.member_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subscriptions staff manage" ON public.member_subscriptions
  FOR ALL TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE POLICY "subscriptions read own" ON public.member_subscriptions
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.members m
    WHERE m.id = member_subscriptions.member_id AND m.user_id = auth.uid()
  ));

CREATE INDEX idx_subs_dojo_id   ON public.member_subscriptions(dojo_id);
CREATE INDEX idx_subs_member_id ON public.member_subscriptions(member_id);
CREATE INDEX idx_subs_plan_id   ON public.member_subscriptions(plan_id);
CREATE INDEX idx_subs_status    ON public.member_subscriptions(status);

CREATE TRIGGER trg_subs_updated_at
  BEFORE UPDATE ON public.member_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Augment invoices
ALTER TABLE public.invoices
  ADD COLUMN subscription_id   uuid REFERENCES public.member_subscriptions(id) ON DELETE SET NULL,
  ADD COLUMN currency          text NOT NULL DEFAULT 'usd',
  ADD COLUMN invoice_number    text,
  ADD COLUMN period_start      timestamptz,
  ADD COLUMN period_end        timestamptz,
  ADD COLUMN stripe_invoice_id text UNIQUE,
  ADD COLUMN hosted_invoice_url text,
  ADD COLUMN voided_at         timestamptz;
CREATE INDEX idx_invoices_subscription_id ON public.invoices(subscription_id);

-- Invoice line items
CREATE TABLE public.invoice_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES public.dojo_plans(id) ON DELETE SET NULL,
  description text NOT NULL,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_amount_cents integer NOT NULL CHECK (unit_amount_cents >= 0),
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoice_line_items TO authenticated;
GRANT ALL ON public.invoice_line_items TO service_role;
ALTER TABLE public.invoice_line_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "line items staff manage" ON public.invoice_line_items
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.invoices i
                 WHERE i.id = invoice_line_items.invoice_id
                   AND public.is_dojo_staff(auth.uid(), i.dojo_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.invoices i
                      WHERE i.id = invoice_line_items.invoice_id
                        AND public.is_dojo_staff(auth.uid(), i.dojo_id)));

CREATE POLICY "line items read own" ON public.invoice_line_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.invoices i
    JOIN public.members m ON m.id = i.member_id
    WHERE i.id = invoice_line_items.invoice_id AND m.user_id = auth.uid()
  ));

CREATE INDEX idx_lineitems_invoice_id ON public.invoice_line_items(invoice_id);
CREATE INDEX idx_lineitems_plan_id    ON public.invoice_line_items(plan_id);

-- Payments
CREATE TYPE public.payment_status AS ENUM (
  'pending', 'succeeded', 'failed', 'refunded', 'partially_refunded', 'canceled'
);
CREATE TYPE public.payment_method AS ENUM (
  'card', 'bank_transfer', 'cash', 'check', 'other'
);

CREATE TABLE public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  currency text NOT NULL DEFAULT 'usd',
  status public.payment_status NOT NULL DEFAULT 'pending',
  method public.payment_method NOT NULL DEFAULT 'card',
  stripe_payment_intent_id text UNIQUE,
  stripe_charge_id text,
  failure_reason text,
  refunded_amount_cents integer NOT NULL DEFAULT 0 CHECK (refunded_amount_cents >= 0),
  processed_at timestamptz,
  notes text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payments TO authenticated;
GRANT ALL ON public.payments TO service_role;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payments staff manage" ON public.payments
  FOR ALL TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE POLICY "payments read own" ON public.payments
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.members m
    WHERE m.id = payments.member_id AND m.user_id = auth.uid()
  ));

CREATE INDEX idx_payments_dojo_id      ON public.payments(dojo_id);
CREATE INDEX idx_payments_member_id    ON public.payments(member_id);
CREATE INDEX idx_payments_invoice_id   ON public.payments(invoice_id);
CREATE INDEX idx_payments_processed_at ON public.payments(processed_at DESC);
CREATE INDEX idx_payments_status       ON public.payments(status);

CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- members.stripe_customer_id
ALTER TABLE public.members ADD COLUMN stripe_customer_id text UNIQUE;

-- ---------- 6. MEMBER STATUS HISTORY ----------
CREATE TABLE public.member_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  dojo_id uuid NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  from_status public.member_status,
  to_status public.member_status NOT NULL,
  from_payment_status public.member_payment_status,
  to_payment_status public.member_payment_status,
  changed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reason text,
  changed_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.member_status_history TO authenticated;
GRANT ALL ON public.member_status_history TO service_role;
ALTER TABLE public.member_status_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "status history staff read" ON public.member_status_history
  FOR SELECT TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE POLICY "status history staff insert" ON public.member_status_history
  FOR INSERT TO authenticated
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE INDEX idx_msh_member_id  ON public.member_status_history(member_id);
CREATE INDEX idx_msh_dojo_id    ON public.member_status_history(dojo_id);
CREATE INDEX idx_msh_changed_at ON public.member_status_history(changed_at DESC);

CREATE OR REPLACE FUNCTION public.record_member_status_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (NEW.status IS DISTINCT FROM OLD.status)
     OR (NEW.payment_status IS DISTINCT FROM OLD.payment_status) THEN
    INSERT INTO public.member_status_history
      (member_id, dojo_id, from_status, to_status, from_payment_status, to_payment_status, changed_by)
    VALUES
      (NEW.id, NEW.dojo_id, OLD.status, NEW.status, OLD.payment_status, NEW.payment_status, auth.uid());
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_member_status_history
  AFTER UPDATE ON public.members
  FOR EACH ROW EXECUTE FUNCTION public.record_member_status_change();
