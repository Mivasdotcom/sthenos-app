ALTER TABLE public.family_groups
  ADD COLUMN IF NOT EXISTS payer_member_id uuid NULL REFERENCES public.members(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS family_groups_payer_member_id_idx
  ON public.family_groups (payer_member_id);

-- Backfill: the current payer is the group member on a family plan, or the only
-- member with a plan while everyone else is marked covered.
UPDATE public.family_groups g
   SET payer_member_id = sub.id
  FROM (
    SELECT DISTINCT ON (m.family_group_id) m.family_group_id, m.id
      FROM public.members m
      LEFT JOIN public.dojo_plans p ON p.id = m.selected_plan_id
     WHERE m.family_group_id IS NOT NULL
       AND m.selected_plan_id IS NOT NULL
       AND m.plan_covered_by IS NULL
     ORDER BY m.family_group_id,
              (CASE WHEN p.plan_type = 'family' THEN 0 ELSE 1 END),
              m.created_at
  ) sub
 WHERE g.id = sub.family_group_id
   AND g.payer_member_id IS NULL;