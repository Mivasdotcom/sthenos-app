-- Trigger-only helper: nothing should call it directly.
REVOKE EXECUTE ON FUNCTION public.track_member_departure() FROM PUBLIC, anon, authenticated;