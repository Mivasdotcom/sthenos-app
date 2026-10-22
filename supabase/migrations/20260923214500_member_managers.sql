-- Who a login may act for.
--
-- A member reaches their own record through members.user_id. A parent needs to
-- act for their children, who are separate records their login is not on, so
-- the link is recorded here: one row per (member, login).
--
-- Applied to production before this file was written; every statement is
-- idempotent so re-running changes nothing.

create table if not exists public.member_managers (
  id uuid primary key default gen_random_uuid(),
  dojo_id uuid not null references public.dojos(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  user_id uuid not null,
  relationship text,
  created_at timestamptz not null default now(),
  unique (member_id, user_id)
);

create index if not exists member_managers_user_dojo_idx on public.member_managers (user_id, dojo_id);
create index if not exists member_managers_member_idx on public.member_managers (member_id);

alter table public.member_managers enable row level security;

-- A login sees its own links. Writes happen in server functions on the service
-- role, after an explicit check, so no write policy is granted here.
drop policy if exists "member_managers read own" on public.member_managers;
create policy "member_managers read own"
  on public.member_managers for select
  using (auth.uid() = user_id);

drop policy if exists "member_managers staff in dojo" on public.member_managers;
create policy "member_managers staff in dojo"
  on public.member_managers for all
  using (is_dojo_staff(auth.uid(), dojo_id));

-- Children whose login is held by the parent who signed them up.
insert into public.member_managers (dojo_id, member_id, user_id, relationship)
select m.dojo_id, m.id, m.user_id, m.guardian_relationship
from public.members m
where m.user_id is not null
  and m.guardian_name is not null
  and m.date_of_birth > current_date - interval '18 years'
on conflict (member_id, user_id) do nothing;

-- Siblings in one family group whose parent signed each child up on a
-- different address -- the plus-addressing workaround. Either login now acts
-- for both children.
insert into public.member_managers (dojo_id, member_id, user_id, relationship)
select a.dojo_id, a.id, b.user_id, a.guardian_relationship
from public.members a
join public.members b
  on b.family_group_id = a.family_group_id
 and b.dojo_id = a.dojo_id
 and b.id <> a.id
where a.family_group_id is not null
  and b.user_id is not null
  and a.guardian_name is not null
  and b.guardian_name is not null
  and lower(a.guardian_name) = lower(b.guardian_name)
  and a.date_of_birth > current_date - interval '18 years'
on conflict (member_id, user_id) do nothing;
