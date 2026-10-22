
-- Convert discipline enum columns to text for flexibility
ALTER TABLE public.members ALTER COLUMN discipline TYPE text USING discipline::text;
ALTER TABLE public.classes ALTER COLUMN discipline TYPE text USING discipline::text;
ALTER TABLE public.promotions ALTER COLUMN discipline TYPE text USING discipline::text;
ALTER TABLE public.dojo_class_types ALTER COLUMN discipline TYPE text USING discipline::text;

-- Update function that references the discipline enum so we can drop the type
CREATE OR REPLACE FUNCTION public.ensure_owner_member_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_email text;
  v_name text;
BEGIN
  IF NEW.role <> 'manager' THEN RETURN NEW; END IF;

  IF EXISTS (SELECT 1 FROM public.members
             WHERE dojo_id = NEW.dojo_id AND user_id = NEW.user_id) THEN
    RETURN NEW;
  END IF;

  SELECT email, display_name INTO v_email, v_name
  FROM public.profiles WHERE user_id = NEW.user_id;

  INSERT INTO public.members
    (dojo_id, user_id, name, email, discipline, plan, status, payment_status)
  VALUES
    (NEW.dojo_id,
     NEW.user_id,
     COALESCE(v_name, split_part(COALESCE(v_email,'manager'),'@',1)),
     v_email,
     'BJJ',
     'Monthly'::public.plan_type,
     'active'::public.member_status,
     'current'::public.member_payment_status);
  RETURN NEW;
END;
$function$;

-- Drop the now-unused enum type
DROP TYPE public.discipline;

-- Prevent empty discipline strings on dojo_class_types
ALTER TABLE public.dojo_class_types
  ADD CONSTRAINT dojo_class_types_discipline_not_empty CHECK (discipline <> '');
