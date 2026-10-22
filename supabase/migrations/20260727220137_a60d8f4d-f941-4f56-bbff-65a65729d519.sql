ALTER TABLE public.members DISABLE TRIGGER members_guard_self_update;

UPDATE public.members m
   SET user_id = u.id, updated_at = now()
  FROM auth.users u
 WHERE m.user_id IS NULL
   AND m.email IS NOT NULL
   AND lower(m.email) = lower(u.email);

INSERT INTO public.dojo_memberships (user_id, dojo_id, role)
SELECT DISTINCT m.user_id, m.dojo_id, 'member'::public.dojo_role
  FROM public.members m
 WHERE m.user_id IS NOT NULL
   AND coalesce(m.signup_source, '') LIKE 'public_signup%'
   AND NOT EXISTS (
     SELECT 1 FROM public.dojo_memberships dm
      WHERE dm.user_id = m.user_id AND dm.dojo_id = m.dojo_id
   );

UPDATE public.dojo_memberships dm
   SET role = 'member'::public.dojo_role
 WHERE dm.role = 'pending'
   AND EXISTS (
     SELECT 1 FROM public.members m
      WHERE m.user_id = dm.user_id AND m.dojo_id = dm.dojo_id
        AND coalesce(m.signup_source, '') LIKE 'public_signup%'
   );

UPDATE public.members
   SET status = 'active'::public.member_status, updated_at = now()
 WHERE status = 'pending'
   AND coalesce(signup_source, '') LIKE 'public_signup%';

ALTER TABLE public.members ENABLE TRIGGER members_guard_self_update;