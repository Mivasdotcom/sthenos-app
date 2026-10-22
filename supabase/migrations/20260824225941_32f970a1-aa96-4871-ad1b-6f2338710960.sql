ALTER TABLE public.members DROP CONSTRAINT IF EXISTS members_payment_method_check;
ALTER TABLE public.members ADD CONSTRAINT members_payment_method_check
  CHECK (payment_method IN ('card','cash','sepa_debit','bacs_debit','direct_debit'));