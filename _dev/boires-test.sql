-- ============================================================================
--  Kenda — boires de TEST pour Léonie (7 derniers jours + aujourd'hui).
--  À coller dans : Supabase → SQL Editor → New query → Run.
--
--  Les boires de test ont tous un identifiant qui commence par « 7e57da7a- »
--  (« test data »), pour pouvoir les retirer d'un coup sans toucher aux vrais :
--
--      delete from public.feeds where id::text like '7e57da7a-%';
--
--  Rejouable : relancer le script remplace les boires de test par de nouveaux.
-- ============================================================================

delete from public.feeds where id::text like '7e57da7a-%';

with bebe as (
  select b.id as baby_id,
         (select c.id from public.caregivers c where c.baby_id = b.id order by c.created_at limit 1) as caregiver_id
  from public.babies b
  where lower(b.name) = 'léonie'
  order by b.created_at
  limit 1
),
-- Horaire théorique d'une journée (heures décimales, heure de Montréal).
horaire(h) as (values (2.9), (7.4), (9.4), (12.4), (14.6), (16.7), (18.4), (20.3)),
creneaux as (
  select row_number() over () as n,
         (date_trunc('day', now() at time zone 'America/Toronto') - j * interval '1 day'
           + h * interval '1 hour'
           + (random() - 0.5) * interval '80 minutes') at time zone 'America/Toronto' as debut,
         random() as tirage
  from generate_series(0, 7) as j, horaire
)
insert into public.feeds (id, baby_id, kind, amount_ml, started_at, caregiver_id, created_at, updated_at)
select ('7e57da7a-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       bebe.baby_id,
       'formule',
       (round((80 + random() * 70) / 10) * 10)::numeric,    -- 80 à 150 ml, par bonds de 10
       date_trunc('minute', debut),
       bebe.caregiver_id,
       debut, debut
from creneaux, bebe
where debut <= now() - interval '20 minutes'     -- rien dans le futur
  and tirage > 0.12;                             -- un boire sauté de temps en temps

-- Vérification : nombre de boires de test par jour.
select (started_at at time zone 'America/Toronto')::date as jour, count(*) as boires, sum(amount_ml) as ml
from public.feeds where id::text like '7e57da7a-%'
group by 1 order by 1;
