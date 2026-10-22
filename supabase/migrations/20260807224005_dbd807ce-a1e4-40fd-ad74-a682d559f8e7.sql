DELETE FROM public.email_settings
WHERE lower(coalesce(from_address, '')) IN ('onboarding@resend.dev', 'you@yourgym.com', 'notify@notify.sthenos.live')
   OR lower(coalesce(from_name, '')) IN ('your dojo', 'your gym', 'dojo connect', 'xalarosi');