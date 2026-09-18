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
  created_at       timestamptz not null default now()
);

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

grant execute on function public.user_baby_ids()                to authenticated;
grant execute on function public.create_baby(text, text, text)  to authenticated;
grant execute on function public.join_baby(text, text, text)    to authenticated;

-- ---------- Temps réel ------------------------------------------------------
-- Diffuse les changements aux autres appareils (< 1 s).

do $$
declare t text;
begin
  foreach t in array array['feeds', 'babies', 'caregivers'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
