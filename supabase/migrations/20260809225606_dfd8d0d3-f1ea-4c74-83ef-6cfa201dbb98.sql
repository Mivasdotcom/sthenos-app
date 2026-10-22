ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS media_consent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS media_consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS date_of_birth date;

COMMENT ON COLUMN public.members.media_consent IS 'Optional consent to use photos/training footage for marketing. Never bundled with the waiver.';
COMMENT ON COLUMN public.members.media_consent_at IS 'Timestamp the current media_consent value was recorded.';
COMMENT ON COLUMN public.members.date_of_birth IS 'Optional. Used to flag under-18 members (media consent needs parent/guardian agreement).';