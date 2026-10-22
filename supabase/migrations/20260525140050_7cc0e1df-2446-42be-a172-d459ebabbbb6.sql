-- Add 'pending' to app_role enum
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'pending';

-- Update handle_new_user: first user = owner, all others = pending (must be approved)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_is_first BOOLEAN;
BEGIN
  INSERT INTO public.profiles (user_id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', split_part(NEW.email,'@',1))
  );

  SELECT NOT EXISTS (SELECT 1 FROM public.user_roles) INTO v_is_first;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (
    NEW.id,
    CASE WHEN v_is_first THEN 'owner'::public.app_role ELSE 'pending'::public.app_role END
  );

  RETURN NEW;
END;
$function$;