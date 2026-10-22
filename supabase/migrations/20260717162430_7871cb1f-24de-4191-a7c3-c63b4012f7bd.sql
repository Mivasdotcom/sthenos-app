
REVOKE ALL ON FUNCTION public.enforce_overdue_grace() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_overdue_grace() TO service_role;
