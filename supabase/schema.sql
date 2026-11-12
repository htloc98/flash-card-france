create table if not exists public.vocabularies (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  word text not null,
  pronunciation text not null default '',
  part_of_speech text not null default '',
  meaning text not null,
  example text not null default '',
  read_text text not null default '',
  language text not null default 'fr-FR',
  created_at timestamptz not null default now()
);

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  unique (owner_id, name)
);

create table if not exists public.vocabulary_categories (
  vocabulary_id uuid not null references public.vocabularies(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  primary key (vocabulary_id, category_id)
);

create table if not exists public.user_settings (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  front_delay integer not null default 4 check (front_delay between 1 and 10),
  back_delay integer not null default 4 check (back_delay between 1 and 10),
  auto_speak boolean not null default false
);

create index if not exists vocabularies_owner_created_idx
  on public.vocabularies (owner_id, created_at);
create index if not exists categories_owner_name_idx
  on public.categories (owner_id, name);

alter table public.vocabularies enable row level security;
alter table public.categories enable row level security;
alter table public.vocabulary_categories enable row level security;
alter table public.user_settings enable row level security;

drop policy if exists "Owners manage vocabulary" on public.vocabularies;
create policy "Owners manage vocabulary" on public.vocabularies
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists "Owners manage categories" on public.categories;
create policy "Owners manage categories" on public.categories
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists "Owners read vocabulary categories" on public.vocabulary_categories;
create policy "Owners read vocabulary categories" on public.vocabulary_categories
  for select to authenticated
  using (exists (
    select 1 from public.vocabularies v
    where v.id = vocabulary_id and v.owner_id = (select auth.uid())
  ));

drop policy if exists "Owners assign vocabulary categories" on public.vocabulary_categories;
create policy "Owners assign vocabulary categories" on public.vocabulary_categories
  for insert to authenticated
  with check (
    exists (
      select 1 from public.vocabularies v
      where v.id = vocabulary_id and v.owner_id = (select auth.uid())
    )
    and exists (
      select 1 from public.categories c
      where c.id = category_id and c.owner_id = (select auth.uid())
    )
  );

drop policy if exists "Owners remove vocabulary categories" on public.vocabulary_categories;
create policy "Owners remove vocabulary categories" on public.vocabulary_categories
  for delete to authenticated
  using (exists (
    select 1 from public.vocabularies v
    where v.id = vocabulary_id and v.owner_id = (select auth.uid())
  ));

drop policy if exists "Owners manage settings" on public.user_settings;
create policy "Owners manage settings" on public.user_settings
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

grant select, insert, update, delete on public.vocabularies to authenticated;
grant select, insert, update, delete on public.categories to authenticated;
grant select, insert, delete on public.vocabulary_categories to authenticated;
grant select, insert, update, delete on public.user_settings to authenticated;
