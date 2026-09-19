-- ============================================================================
--  Kenda — schéma Supabase
--  À coller dans : Supabase → SQL Editor → New query → Run.
--  Rejouable sans danger : rien n'est effacé si on le passe une deuxième fois.
-- ============================================================================

-- ---------- Tables ----------------------------------------------------------

-- Un bébé = un « suivi » partagé (l'équivalent du foyer de Calico ou du groupe
-- de Panache). Les réglages vivent ici pour être les mêmes sur tous les
-- appareils : unité, types de lait offerts à la saisie, alerte douce.
create table if not exists public.babies (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  join_code        text not null unique,
  unit             text not null default 'ml' check (unit in ('ml','oz')),
  kinds            text[] not null default '{maternel,formule}',
  remind_after_min int check (remind_after_min is null or remind_after_min between 30 and 720),
  photo            text check (photo is null or length(photo) < 200000),   -- petite image « data: » (256 px), réduite par l'app
  created_at       timestamptz not null default now()
);

-- (Si la table existait déjà avant l'ajout de la photo.)
alter table public.babies add column if not exists photo text check (photo is null or length(photo) < 200000);

-- Les personnes qui suivent un bébé (toi, ta conjointe, une gardienne…).
create table if not exists public.caregivers (
  id         uuid primary key default gen_random_uuid(),
  baby_id    uuid not null references public.babies(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  color      text,
  created_at timestamptz not null default now(),
  unique (baby_id, user_id)
);

-- Un boire. L'identifiant est créé sur l'appareil (saisie hors ligne, renvoi
-- sans doublon). La quantité est toujours gardée en ml ; l'app convertit en oz
-- à l'affichage. Une suppression pose `deleted_at` : l'autre appareil la reçoit
-- en temps réel comme n'importe quelle modification.
create table if not exists public.feeds (
  id           uuid primary key default gen_random_uuid(),
  baby_id      uuid not null references public.babies(id) on delete cascade,
  kind         text not null check (kind in ('maternel','formule')),
  amount_ml    numeric(6,1) not null check (amount_ml > 0 and amount_ml <= 1000),
  started_at   timestamptz not null,
  caregiver_id uuid references public.caregivers(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

-- ---------- Modules : couches, croissance, premières --------------------------
-- Réglages partagés ajoutés au bébé : sexe et date de naissance (courbes de
-- croissance de l'OMS), unités de la croissance, modules affichés sur l'accueil
-- et leur ordre — ex. [{"id":"biberon","on":true},{"id":"couches","on":false}].
alter table public.babies add column if not exists sex         text check (sex is null or sex in ('f','m'));
alter table public.babies add column if not exists birth_date  date;
alter table public.babies add column if not exists weight_unit text not null default 'kg' check (weight_unit in ('kg','lb'));
alter table public.babies add column if not exists length_unit text not null default 'cm' check (length_unit in ('cm','po'));
alter table public.babies add column if not exists modules     jsonb;

-- Une couche. Ni mouillée ni sale = sèche. Même mécanique que les boires :
-- identifiant créé sur l'appareil, suppression douce.
create table if not exists public.diapers (
  id           uuid primary key default gen_random_uuid(),
  baby_id      uuid not null references public.babies(id) on delete cascade,
  wet          boolean not null default false,
  dirty        boolean not null default false,
  rash         boolean not null default false,          -- érythème fessier
  changed_at   timestamptz not null,
  caregiver_id uuid references public.caregivers(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

-- Une prise de mesures. Toujours en métrique (grammes, centimètres) ; l'app
-- convertit. Chaque mesure est facultative. La photo est une image « data: »
-- réduite par l'app (640 px) ; `has_photo` permet de charger la liste sans elle.
create table if not exists public.growth (
  id           uuid primary key default gen_random_uuid(),
  baby_id      uuid not null references public.babies(id) on delete cascade,
  measured_on  date not null,
  weight_g     numeric(7,1) check (weight_g  is null or (weight_g  > 0 and weight_g  <= 60000)),
  height_cm    numeric(5,1) check (height_cm is null or (height_cm > 0 and height_cm <= 200)),
  head_cm      numeric(5,1) check (head_cm   is null or (head_cm   > 0 and head_cm   <= 100)),
  note         text check (note is null or length(note) <= 2000),
  photo        text check (photo is null or length(photo) < 600000),
  has_photo    boolean generated always as (photo is not null) stored,
  caregiver_id uuid references public.caregivers(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

-- Une « première » de bébé (premier sourire, première fois dans l'eau…).
create table if not exists public.firsts (
  id           uuid primary key default gen_random_uuid(),
  baby_id      uuid not null references public.babies(id) on delete cascade,
  happened_on  date not null,
  title        text not null check (length(trim(title)) between 1 and 120),
  note         text check (note is null or length(note) <= 2000),
  photo        text check (photo is null or length(photo) < 600000),
  has_photo    boolean generated always as (photo is not null) stored,
  caregiver_id uuid references public.caregivers(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

create index if not exists idx_diapers_baby_time on public.diapers(baby_id, changed_at desc);
create index if not exists idx_growth_baby_day   on public.growth(baby_id, measured_on desc);
create index if not exists idx_firsts_baby_day   on public.firsts(baby_id, happened_on desc);
create index if not exists idx_caregivers_user on public.caregivers(user_id);
create index if not exists idx_feeds_baby_time on public.feeds(baby_id, started_at desc);

-- ---------- La modification la plus récente gagne ---------------------------
-- Un appareil resté hors ligne peut renvoyer une vieille version d'un boire que
-- l'autre parent a corrigé entre-temps : on l'ignore.

create or replace function public.feeds_keep_latest()
returns trigger
language plpgsql
as $$
begin
  if new.updated_at < old.updated_at then return old; end if;
  return new;
end;
$$;

drop trigger if exists feeds_keep_latest on public.feeds;
create trigger feeds_keep_latest before update on public.feeds
  for each row execute function public.feeds_keep_latest();

-- Même règle pour les couches, la croissance et les premières.
drop trigger if exists diapers_keep_latest on public.diapers;
create trigger diapers_keep_latest before update on public.diapers
  for each row execute function public.feeds_keep_latest();
drop trigger if exists growth_keep_latest on public.growth;
create trigger growth_keep_latest before update on public.growth
  for each row execute function public.feeds_keep_latest();
drop trigger if exists firsts_keep_latest on public.firsts;
create trigger firsts_keep_latest before update on public.firsts
  for each row execute function public.feeds_keep_latest();

-- ---------- Fonction anti-récursion pour les règles RLS ---------------------

create or replace function public.user_baby_ids()
returns setof uuid
language sql
security definer
stable
set search_path = public
as $$
  select baby_id from public.caregivers where user_id = auth.uid()
$$;

-- ---------- Row Level Security ----------------------------------------------

alter table public.babies     enable row level security;
alter table public.caregivers enable row level security;
alter table public.feeds      enable row level security;
alter table public.diapers    enable row level security;
alter table public.growth     enable row level security;
alter table public.firsts     enable row level security;

drop policy if exists b_select on public.babies;
create policy b_select on public.babies for select
  using (id in (select public.user_baby_ids()));

drop policy if exists b_update on public.babies;
create policy b_update on public.babies for update
  using (id in (select public.user_baby_ids()));

drop policy if exists c_select on public.caregivers;
create policy c_select on public.caregivers for select
  using (baby_id in (select public.user_baby_ids()));

drop policy if exists c_update_self on public.caregivers;
create policy c_update_self on public.caregivers for update
  using (user_id = auth.uid());

drop policy if exists c_delete_self on public.caregivers;
create policy c_delete_self on public.caregivers for delete
  using (user_id = auth.uid());

drop policy if exists f_all on public.feeds;
create policy f_all on public.feeds for all
  using      (baby_id in (select public.user_baby_ids()))
  with check (baby_id in (select public.user_baby_ids()));

drop policy if exists d_all on public.diapers;
create policy d_all on public.diapers for all
  using      (baby_id in (select public.user_baby_ids()))
  with check (baby_id in (select public.user_baby_ids()));

drop policy if exists g_all on public.growth;
create policy g_all on public.growth for all
  using      (baby_id in (select public.user_baby_ids()))
  with check (baby_id in (select public.user_baby_ids()));

drop policy if exists p_all on public.firsts;
create policy p_all on public.firsts for all
  using      (baby_id in (select public.user_baby_ids()))
  with check (baby_id in (select public.user_baby_ids()));

-- ---------- RPC : créer un bébé / rejoindre un suivi ------------------------

create or replace function public.create_baby(
  p_baby_name      text,
  p_caregiver_name text,
  p_color          text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_b uuid; v_code text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if nullif(trim(p_baby_name), '') is null then raise exception 'baby name required'; end if;
  loop
    v_code := upper(substr(md5(gen_random_uuid()::text), 1, 5));
    exit when not exists (select 1 from public.babies where join_code = v_code);
  end loop;
  insert into public.babies (name, join_code)
    values (trim(p_baby_name), v_code)
    returning id into v_b;
  insert into public.caregivers (baby_id, user_id, name, color)
    values (v_b, auth.uid(), trim(p_caregiver_name), p_color);
  return v_b;
end;
$$;

create or replace function public.join_baby(
  p_code           text,
  p_caregiver_name text,
  p_color          text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_b uuid; v_n int;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select id into v_b from public.babies where join_code = upper(trim(p_code));
  if v_b is null then raise exception 'baby not found'; end if;
  if exists (select 1 from public.caregivers where baby_id = v_b and user_id = auth.uid()) then
    return v_b;
  end if;
  select count(*) into v_n from public.caregivers where baby_id = v_b;
  if v_n >= 6 then raise exception 'baby is full'; end if;
  -- Sans couleur imposée, chaque nouvelle personne reçoit la suivante de la palette.
  insert into public.caregivers (baby_id, user_id, name, color)
    values (v_b, auth.uid(), trim(p_caregiver_name),
            coalesce(p_color, (array['#6B5A85','#3E6B7A','#8A6D4B','#5F7F5A','#9A5F72','#7A7468'])[1 + v_n % 6]));
  return v_b;
end;
$$;

-- ---------- Total « depuis le début » ---------------------------------------
-- L'app ne charge que les 31 derniers jours ; la base additionne le reste.
-- SECURITY INVOKER : les règles RLS s'appliquent, on ne compte que ses bébés.

create or replace function public.baby_totals(p_before timestamptz)
returns table (baby_id uuid, total_ml numeric, feeds bigint, first_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select f.baby_id, sum(f.amount_ml), count(*), min(f.started_at)
  from public.feeds f
  where f.deleted_at is null and f.started_at < p_before
  group by f.baby_id
$$;

grant execute on function public.baby_totals(timestamptz) to authenticated;
grant execute on function public.user_baby_ids()                to authenticated;
grant execute on function public.create_baby(text, text, text)  to authenticated;
grant execute on function public.join_baby(text, text, text)    to authenticated;

-- ---------- Temps réel ------------------------------------------------------
-- Diffuse les changements aux autres appareils (< 1 s).

do $$
declare t text;
begin
  foreach t in array array['feeds', 'babies', 'caregivers', 'diapers', 'growth', 'firsts'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
