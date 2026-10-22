ALTER TABLE public.membership_pauses DROP CONSTRAINT IF EXISTS membership_pauses_reason_check;
ALTER TABLE public.members DROP CONSTRAINT IF EXISTS members_pause_reason_check;
UPDATE public.membership_pauses SET reason = 'personal' WHERE reason = 'injury';
UPDATE public.members SET pause_reason = 'personal' WHERE pause_reason = 'injury';
ALTER TABLE public.membership_pauses ADD CONSTRAINT membership_pauses_reason_check CHECK (reason IS NULL OR reason IN ('travel','personal','other'));