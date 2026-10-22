-- Prevent owners/admins from being auto-created as members going forward.
-- The function ensure_owner_member_row exists but currently has no active
-- trigger; drop it entirely so future changes can't re-attach it.
DROP FUNCTION IF EXISTS public.ensure_owner_member_row() CASCADE;

-- One-off cleanup: remove members rows that correspond to a dojo owner/admin
-- for the same dojo, UNLESS they have genuine training activity.
DELETE FROM public.members m
WHERE EXISTS (
  SELECT 1 FROM public.dojo_memberships dm
  WHERE dm.user_id = m.user_id
    AND dm.dojo_id = m.dojo_id
    AND dm.role IN ('owner','admin')
)
AND NOT EXISTS (SELECT 1 FROM public.attendances a WHERE a.member_id = m.id)
AND NOT EXISTS (SELECT 1 FROM public.promotions p WHERE p.member_id = m.id)
AND NOT EXISTS (
  SELECT 1 FROM public.member_subscriptions s
  WHERE s.member_id = m.id
    AND s.status IN ('active','trialing','past_due','unpaid')
);