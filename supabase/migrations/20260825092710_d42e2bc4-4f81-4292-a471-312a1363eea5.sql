ALTER TABLE public.members DROP CONSTRAINT IF EXISTS members_user_id_key;
DROP INDEX IF EXISTS public.members_user_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS members_dojo_user_unique ON public.members (dojo_id, user_id) WHERE user_id IS NOT NULL;