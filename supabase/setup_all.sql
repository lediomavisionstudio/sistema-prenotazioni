-- ============================================================================
-- SETUP COMPLETO — Sistema Prenotazioni
-- Incolla TUTTO questo file nel SQL Editor di Supabase ed esegui (RUN).
-- Riunisce le migration 0001-0011 + i dati demo (seed).
-- Puo' essere ri-eseguito: il blocco iniziale azzera lo schema public.
-- (Sicuro su un progetto nuovo: 'public' contiene solo i nostri oggetti.)
-- ============================================================================

-- --- Azzeramento pulito dello schema public ---------------------------------
drop schema if exists public cascade;
create schema public;

-- Ripristina i privilegi standard di Supabase sullo schema public
grant usage on schema public to postgres, anon, authenticated, service_role;
grant all on schema public to postgres, service_role;
alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;

-- ============================================================================
-- migrations/0001_extensions.sql
-- ============================================================================
-- Estensioni necessarie
create extension if not exists "pgcrypto";   -- gen_random_uuid()


-- ============================================================================
-- migrations/0002_enums.sql
-- ============================================================================
-- Tipi enumerati

create type staff_role as enum ('owner', 'staff');

-- Stato del ciclo di vita di una prenotazione.
-- Ogni prenotazione (sia da widget pubblico che manuale) nasce sempre
-- 'in_attesa': l'assegnazione del tavolo e' solo un suggerimento del sistema,
-- e' il gestore del locale che deve confermare o rifiutare dal pannello.
create type reservation_status as enum (
  'in_attesa',
  'confermata',
  'arrivato',
  'no_show',
  'annullata'
);

create type reservation_source as enum ('widget', 'manuale');


-- ============================================================================
-- migrations/0003_core_tables.sql
-- ============================================================================
-- Locali e staff

create table venues (
  id                          uuid primary key default gen_random_uuid(),
  name                        text not null,
  slug                        text not null unique,               -- usato nell'URL del widget pubblico, es. /w/pizzeria-da-mario
  phone                       text,
  address                     text,
  timezone                    text not null default 'Europe/Rome',
  widget_booking_window_days  int not null default 7,              -- quanti giorni in avanti il widget mostra
  closed_weekdays             smallint[] not null default '{}',    -- chiusura settimanale ricorrente (ISO dow: 1=lun..7=dom)
  active                      boolean not null default true,       -- locale disattivato = widget e login bloccati
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

comment on table venues is 'Un locale (pizzeria/pub) cliente della piattaforma. Ogni locale ha le proprie zone, tavoli, turni e prenotazioni.';

-- Collega gli utenti Supabase Auth (auth.users) ai locali che gestiscono.
-- Un utente puo' gestire piu' locali (es. stesso gruppo con piu' sedi) e un
-- locale puo' avere piu' membri staff.
create table venue_staff (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        staff_role not null default 'staff',
  created_at  timestamptz not null default now(),
  unique (venue_id, user_id)
);

comment on table venue_staff is 'Appartenenza di un utente autenticato a un locale. Il ruolo owner puo'' configurare zone/tavoli/turni/staff, staff gestisce solo il servizio (prenotazioni).';

create index venue_staff_user_id_idx on venue_staff (user_id);


-- ============================================================================
-- migrations/0004_config_tables.sql
-- ============================================================================
-- Configurazione sala: zone, tavoli, turni, chiusure straordinarie.
-- Queste tabelle sono "quasi statiche": cambiano quando il gestore
-- riorganizza la sala, non ad ogni prenotazione.

create table zones (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues(id) on delete cascade,
  name        text not null,              -- es. 'Sala', 'Dehors'
  sort_order  int not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (venue_id, name)
);

create table restaurant_tables (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues(id) on delete cascade,
  zone_id     uuid not null references zones(id) on delete restrict,
  code        text not null,                 -- es. 'T1', 'D3' - mostrato nella mappa
  seats_max   int not null,
  active      boolean not null default true,  -- tavolo temporaneamente fuori uso
  created_at  timestamptz not null default now(),
  unique (venue_id, code),
  check (seats_max > 0)
);

comment on table restaurant_tables is 'Tavolo fisico di un locale. seats_max definisce il numero massimo di coperti.';

create index restaurant_tables_zone_id_idx on restaurant_tables (zone_id);
create index restaurant_tables_venue_capacity_idx on restaurant_tables (venue_id, seats_max);

-- Turni di servizio configurabili per locale (di norma Turno I 19-21, Turno II 21-23,
-- ma restano configurabili perche' pub e pizzerie hanno orari diversi).
create table service_shifts (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues(id) on delete cascade,
  code          text not null,                -- es. 'turno_1'
  name          text not null,                -- es. 'Turno I'
  start_time    time not null,
  end_time      time not null,
  days_of_week  smallint[] not null default '{1,2,3,4,5,6,7}', -- ISO dow: 1=lun .. 7=dom
  sort_order    int not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (venue_id, code),
  check (end_time > start_time)
);

-- Giorni di chiusura straordinaria (ferie, eventi privati) in cui il widget
-- non deve mostrare disponibilita' per quella data.
create table venue_closures (
  id           uuid primary key default gen_random_uuid(),
  venue_id     uuid not null references venues(id) on delete cascade,
  closed_date  date not null,
  reason       text,
  created_at   timestamptz not null default now(),
  unique (venue_id, closed_date)
);


-- ============================================================================
-- migrations/0005_reservations.sql
-- ============================================================================
-- Prenotazioni

create table reservations (
  id                    uuid primary key default gen_random_uuid(),
  venue_id              uuid not null references venues(id) on delete cascade,
  reservation_date      date not null,
  shift_id              uuid not null references service_shifts(id) on delete restrict,
  -- Il limite di 12 coperti e' imposto solo al widget pubblico (dentro
  -- create_public_reservation), non qui: lo staff deve poter registrare
  -- manualmente anche gruppi/eventi piu' grandi.
  party_size            int not null check (party_size > 0),

  customer_first_name   text not null,
  customer_last_name    text not null,
  customer_phone        text not null,
  notes                 text,                 -- seggiolone, allergie, preferenza dehors...

  status                reservation_status not null default 'in_attesa',
  source                reservation_source not null default 'manuale',

  -- Tavolo suggerito/assegnato. Popolato dalla funzione di assegnazione
  -- automatica al momento della richiesta (suggerimento), ma resta
  -- modificabile dallo staff finche' la prenotazione non e' confermata.
  -- Vedi docs/DATABASE.md per la semantica esatta.
  table_id              uuid references restaurant_tables(id) on delete set null,

  created_by            uuid references auth.users(id),   -- valorizzato solo per source='manuale'

  confirmed_at          timestamptz,
  arrived_at            timestamptz,
  cancelled_at          timestamptz,
  cancellation_reason   text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table reservations is 'Ogni prenotazione nasce in stato in_attesa, sia che arrivi dal widget pubblico sia che venga inserita manualmente dallo staff. Il gestore la accetta o rifiuta dal pannello.';

create index reservations_venue_date_shift_idx on reservations (venue_id, reservation_date, shift_id);
create index reservations_table_idx on reservations (table_id);
create index reservations_status_idx on reservations (venue_id, status);

-- Predisposta per fase 2 (accorpamento di piu' tavoli su una stessa
-- prenotazione per party numerosi). Non ancora utilizzata dalla logica
-- applicativa attuale: in questa fase ogni prenotazione usa un solo tavolo
-- (colonna reservations.table_id) e se non c'e' un tavolo abbastanza grande
-- il widget segnala assenza di disponibilita'.
create table reservation_tables (
  reservation_id  uuid not null references reservations(id) on delete cascade,
  table_id        uuid not null references restaurant_tables(id) on delete restrict,
  primary key (reservation_id, table_id)
);


-- ============================================================================
-- migrations/0006_triggers.sql
-- ============================================================================
-- Trigger generico per aggiornare updated_at

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger venues_set_updated_at
  before update on venues
  for each row execute function set_updated_at();

create trigger reservations_set_updated_at
  before update on reservations
  for each row execute function set_updated_at();

-- Quando lo stato di una prenotazione cambia, registra automaticamente il
-- timestamp corrispondente (evita che il client debba impostarlo a mano e
-- garantisce coerenza indipendentemente da dove arriva l'update).
create or replace function reservations_set_status_timestamps()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    case new.status
      when 'confermata' then
        new.confirmed_at = coalesce(new.confirmed_at, now());
      when 'arrivato' then
        new.arrived_at = coalesce(new.arrived_at, now());
      when 'annullata' then
        new.cancelled_at = coalesce(new.cancelled_at, now());
      else
        -- no_show e in_attesa non hanno un timestamp dedicato oltre updated_at
        null;
    end case;
  end if;
  return new;
end;
$$;

create trigger reservations_status_timestamps
  before update on reservations
  for each row execute function reservations_set_status_timestamps();


-- ============================================================================
-- migrations/0007_rls_helpers.sql
-- ============================================================================
-- Funzioni helper per le policy RLS.
-- Sono SQL "stable" e girano con i permessi di chi le chiama (non security
-- definer): la riga di venue_staff che leggono e' comunque visibile perche'
-- la policy su venue_staff permette a ciascun utente di leggere le proprie
-- righe (vedi 0008_rls_policies.sql).

create or replace function is_staff_of(p_venue_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from venue_staff vs
    where vs.venue_id = p_venue_id
      and vs.user_id = auth.uid()
  );
$$;

create or replace function is_owner_of(p_venue_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from venue_staff vs
    where vs.venue_id = p_venue_id
      and vs.user_id = auth.uid()
      and vs.role = 'owner'
  );
$$;


-- ============================================================================
-- migrations/0008_rls_policies.sql
-- ============================================================================
-- Row Level Security
--
-- Principio generale:
--  * Le tabelle di CONFIGURAZIONE (venues, zones, restaurant_tables,
--    service_shifts, venue_closures) sono leggibili pubblicamente (widget
--    anonimo) quando il locale e' attivo, ma modificabili solo dal owner
--    del locale.
--  * La tabella RESERVATIONS non e' MAI leggibile ne' inseribile
--    direttamente da anon: contiene PII dei clienti (nome, telefono).
--    Il widget pubblico crea prenotazioni esclusivamente tramite la funzione
--    create_public_reservation() (security definer, vedi 0009_booking_functions.sql),
--    che valida i dati e nasconde i dettagli delle altre prenotazioni.
--  * Nessun DELETE su reservations: l'annullamento e' un cambio di stato
--    ('annullata'), per mantenere lo storico/audit.

alter table venues              enable row level security;
alter table venue_staff         enable row level security;
alter table zones               enable row level security;
alter table restaurant_tables   enable row level security;
alter table service_shifts      enable row level security;
alter table venue_closures      enable row level security;
alter table reservations        enable row level security;
alter table reservation_tables  enable row level security;

-- venues -----------------------------------------------------------------

create policy venues_select_public_or_staff
  on venues for select
  to anon, authenticated
  using (active or is_staff_of(id));

create policy venues_update_owner
  on venues for update
  to authenticated
  using (is_owner_of(id))
  with check (is_owner_of(id));

-- Nessuna policy insert/delete: la creazione di un nuovo locale (onboarding
-- di un cliente pilota) si fa da dashboard Supabase / service_role.

-- venue_staff --------------------------------------------------------------

create policy venue_staff_select_self_or_owner
  on venue_staff for select
  to authenticated
  using (user_id = auth.uid() or is_owner_of(venue_id));

create policy venue_staff_insert_owner
  on venue_staff for insert
  to authenticated
  with check (is_owner_of(venue_id));

create policy venue_staff_update_owner
  on venue_staff for update
  to authenticated
  using (is_owner_of(venue_id))
  with check (is_owner_of(venue_id));

create policy venue_staff_delete_owner
  on venue_staff for delete
  to authenticated
  using (is_owner_of(venue_id));

-- Nota bootstrap: il primo owner di un locale non puo' auto-inserirsi (nessuna
-- riga venue_staff esiste ancora -> is_owner_of() e' false). Va creato una
-- tantum in fase di onboarding tramite service_role.

-- zones ----------------------------------------------------------------

create policy zones_select_public_or_staff
  on zones for select
  to anon, authenticated
  using (
    active and exists (select 1 from venues v where v.id = venue_id and v.active)
    or is_staff_of(venue_id)
  );

create policy zones_write_owner
  on zones for all
  to authenticated
  using (is_owner_of(venue_id))
  with check (is_owner_of(venue_id));

-- restaurant_tables ------------------------------------------------------

create policy restaurant_tables_select_public_or_staff
  on restaurant_tables for select
  to anon, authenticated
  using (
    active and exists (select 1 from venues v where v.id = venue_id and v.active)
    or is_staff_of(venue_id)
  );

create policy restaurant_tables_write_owner
  on restaurant_tables for all
  to authenticated
  using (is_owner_of(venue_id))
  with check (is_owner_of(venue_id));

-- service_shifts -----------------------------------------------------------

create policy service_shifts_select_public_or_staff
  on service_shifts for select
  to anon, authenticated
  using (
    active and exists (select 1 from venues v where v.id = venue_id and v.active)
    or is_staff_of(venue_id)
  );

create policy service_shifts_write_owner
  on service_shifts for all
  to authenticated
  using (is_owner_of(venue_id))
  with check (is_owner_of(venue_id));

-- venue_closures -----------------------------------------------------------
-- Leggibile pubblicamente: il widget deve sapere quali date nascondere dallo
-- step di scelta data, senza dover esporre altro.

create policy venue_closures_select_public_or_staff
  on venue_closures for select
  to anon, authenticated
  using (
    exists (select 1 from venues v where v.id = venue_id and v.active)
    or is_staff_of(venue_id)
  );

create policy venue_closures_write_owner
  on venue_closures for all
  to authenticated
  using (is_owner_of(venue_id))
  with check (is_owner_of(venue_id));

-- reservations ---------------------------------------------------------

create policy reservations_select_staff
  on reservations for select
  to authenticated
  using (is_staff_of(venue_id));

-- Inserimento manuale da pannello. source deve essere 'manuale': le
-- prenotazioni 'widget' possono nascere solo tramite create_public_reservation().
create policy reservations_insert_staff
  on reservations for insert
  to authenticated
  with check (is_staff_of(venue_id) and source = 'manuale');

create policy reservations_update_staff
  on reservations for update
  to authenticated
  using (is_staff_of(venue_id))
  with check (is_staff_of(venue_id));

-- Nessuna policy delete: vedi commento in cima al file.
-- Nessuna policy insert/select per anon: il widget pubblico passa sempre
-- dalla funzione create_public_reservation().

-- reservation_tables (predisposta per fase 2, accorpamento tavoli) -------

create policy reservation_tables_select_staff
  on reservation_tables for select
  to authenticated
  using (
    exists (
      select 1 from reservations r
      where r.id = reservation_id and is_staff_of(r.venue_id)
    )
  );

create policy reservation_tables_write_staff
  on reservation_tables for all
  to authenticated
  using (
    exists (
      select 1 from reservations r
      where r.id = reservation_id and is_staff_of(r.venue_id)
    )
  )
  with check (
    exists (
      select 1 from reservations r
      where r.id = reservation_id and is_staff_of(r.venue_id)
    )
  );


-- ============================================================================
-- migrations/0009_booking_functions.sql
-- ============================================================================
-- Funzioni di prenotazione.
--
-- suggest_table(): trova il miglior tavolo libero per coperti/data/turno.
-- E' un SUGGERIMENTO, non un blocco: considera "occupato" un tavolo solo se
-- gia' legato a una prenotazione 'confermata' o 'arrivato' per quello stesso
-- giorno/turno. Le prenotazioni 'in_attesa' non escludono un tavolo dai
-- suggerimenti successivi, perche' la decisione finale (accettare/rifiutare,
-- eventualmente cambiando tavolo) spetta sempre al gestore dal pannello.
--
-- E' security definer perche' deve poter "vedere" le prenotazioni esistenti
-- per calcolare l'occupazione anche quando viene chiamata indirettamente dal
-- widget pubblico (che non ha alcun permesso di lettura su reservations).
-- Non restituisce mai dati dei clienti, solo un id di tavolo.

create or replace function suggest_table(
  p_venue_id   uuid,
  p_date       date,
  p_shift_id   uuid,
  p_party_size int
) returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select t.id
  from restaurant_tables t
  where t.venue_id = p_venue_id
    and t.active
    and p_party_size <= t.seats_max
    and not exists (
      select 1
      from reservations r
      where r.table_id = t.id
        and r.reservation_date = p_date
        and r.shift_id = p_shift_id
        and r.status in ('confermata', 'arrivato')
    )
  order by t.seats_max asc, t.code asc
  limit 1;
$$;

revoke execute on function suggest_table(uuid, date, uuid, int) from public;
grant execute on function suggest_table(uuid, date, uuid, int) to authenticated;

-- get_widget_availability(): per il widget pubblico, dati locale (slug) e
-- coperti richiesti, restituisce per ogni giorno della finestra configurata
-- (default 7) e per ogni turno attivo se risulta plausibilmente prenotabile
-- (locale non chiuso quel giorno, turno attivo in quel giorno della
-- settimana, esiste un tavolo suggeribile). Non espone alcun dettaglio di
-- prenotazioni esistenti.

create or replace function get_widget_availability(
  p_venue_slug text,
  p_party_size int
) returns table (
  reservation_date date,
  shift_id         uuid,
  shift_code       text,
  shift_name       text,
  start_time       time,
  end_time         time,
  available        boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_venue venues%rowtype;
begin
  if p_party_size is null or p_party_size < 1 or p_party_size > 12 then
    raise exception 'COPERTI_NON_VALIDI' using errcode = 'P0001';
  end if;

  select * into v_venue from venues v where v.slug = p_venue_slug and v.active limit 1;
  if not found then
    raise exception 'LOCALE_NON_TROVATO' using errcode = 'P0001';
  end if;

  return query
  select
    d.reservation_date,
    s.id,
    s.code,
    s.name,
    s.start_time,
    s.end_time,
    (
      not exists (
        select 1 from venue_closures c
        where c.venue_id = v_venue.id and c.closed_date = d.reservation_date
      )
      and suggest_table(v_venue.id, d.reservation_date, s.id, p_party_size) is not null
    ) as available
  from (
    select (current_date + gs.day_offset)::date as reservation_date
    from generate_series(0, v_venue.widget_booking_window_days - 1) as gs(day_offset)
  ) as d
  cross join service_shifts s
  where s.venue_id = v_venue.id
    and s.active
    and extract(isodow from d.reservation_date)::smallint = any (s.days_of_week)
    and not (extract(isodow from d.reservation_date)::smallint = any (v_venue.closed_weekdays))
  order by d.reservation_date, s.sort_order;
end;
$$;

grant execute on function get_widget_availability(text, int) to anon, authenticated;

-- create_public_reservation(): unico punto di ingresso per il widget
-- pubblico. Valida tutto lato server (non fidarsi del client), suggerisce un
-- tavolo e inserisce la prenotazione sempre in stato 'in_attesa'. Non
-- restituisce mai altro che il riepilogo della prenotazione appena creata.

create or replace function create_public_reservation(
  p_venue_slug         text,
  p_reservation_date   date,
  p_shift_id           uuid,
  p_party_size         int,
  p_first_name         text,
  p_last_name          text,
  p_phone              text,
  p_notes              text default null
) returns table (
  reservation_id    uuid,
  status            reservation_status,
  reservation_date  date,
  shift_name        text,
  party_size        int,
  table_code        text   -- tavolo suggerito/assegnato, mostrato nel riepilogo cliente
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_venue   venues%rowtype;
  v_shift   service_shifts%rowtype;
  v_table   uuid;
  v_res     reservations%rowtype;
begin
  select * into v_venue from venues v where v.slug = p_venue_slug and v.active limit 1;
  if not found then
    raise exception 'LOCALE_NON_TROVATO' using errcode = 'P0001';
  end if;

  select * into v_shift
  from service_shifts s
  where s.id = p_shift_id and s.venue_id = v_venue.id and s.active
  limit 1;
  if not found then
    raise exception 'TURNO_NON_VALIDO' using errcode = 'P0001';
  end if;

  if p_reservation_date < current_date
     or p_reservation_date > current_date + (v_venue.widget_booking_window_days - 1) then
    raise exception 'DATA_FUORI_FINESTRA' using errcode = 'P0001';
  end if;

  if not (extract(isodow from p_reservation_date)::smallint = any (v_shift.days_of_week)) then
    raise exception 'TURNO_NON_DISPONIBILE_IN_QUESTO_GIORNO' using errcode = 'P0001';
  end if;

  if extract(isodow from p_reservation_date)::smallint = any (v_venue.closed_weekdays) then
    raise exception 'LOCALE_CHIUSO' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from venue_closures c
    where c.venue_id = v_venue.id and c.closed_date = p_reservation_date
  ) then
    raise exception 'LOCALE_CHIUSO' using errcode = 'P0001';
  end if;

  if p_party_size is null or p_party_size < 1 or p_party_size > 12 then
    raise exception 'COPERTI_NON_VALIDI' using errcode = 'P0001';
  end if;

  if coalesce(trim(p_first_name), '') = '' or coalesce(trim(p_last_name), '') = '' or coalesce(trim(p_phone), '') = '' then
    raise exception 'DATI_CLIENTE_INCOMPLETI' using errcode = 'P0001';
  end if;

  v_table := suggest_table(v_venue.id, p_reservation_date, p_shift_id, p_party_size);
  if v_table is null then
    raise exception 'NESSUNA_DISPONIBILITA' using errcode = 'P0001';
  end if;

  insert into reservations (
    venue_id, reservation_date, shift_id, party_size,
    customer_first_name, customer_last_name, customer_phone, notes,
    status, source, table_id
  ) values (
    v_venue.id, p_reservation_date, p_shift_id, p_party_size,
    trim(p_first_name), trim(p_last_name), trim(p_phone), nullif(trim(p_notes), ''),
    'in_attesa', 'widget', v_table
  )
  returning * into v_res;

  return query
  select
    v_res.id,
    v_res.status,
    v_res.reservation_date,
    v_shift.name,
    v_res.party_size,
    (select t.code from restaurant_tables t where t.id = v_table);
end;
$$;

grant execute on function create_public_reservation(text, date, uuid, int, text, text, text, text) to anon, authenticated;


-- ============================================================================
-- migrations/0010_views.sql
-- ============================================================================
-- Vista di supporto per la dashboard KPI del pannello gestionale.
-- security_invoker = true: la vista NON bypassa la RLS di reservations,
-- quindi ogni utente vede solo i dati dei locali di cui e' staff, esattamente
-- come se interrogasse reservations direttamente.

create view venue_shift_occupancy
with (security_invoker = true) as
select
  r.venue_id,
  r.reservation_date,
  r.shift_id,
  count(*) filter (where r.status in ('confermata', 'arrivato'))            as prenotazioni_confermate,
  count(*) filter (where r.status = 'in_attesa')                            as prenotazioni_in_attesa,
  count(*) filter (where r.status = 'no_show')                              as prenotazioni_no_show,
  count(*) filter (where r.status = 'annullata')                            as prenotazioni_annullate,
  coalesce(sum(r.party_size) filter (where r.status in ('confermata', 'arrivato')), 0) as coperti_confermati
from reservations r
group by r.venue_id, r.reservation_date, r.shift_id;

comment on view venue_shift_occupancy is 'Aggregati per KPI dashboard (coperti totali, n. prenotazioni per stato). La % di occupazione va calcolata lato client dividendo coperti_confermati per la capienza totale del locale (somma seats_max di restaurant_tables attivi), perche'' quella dipende dalla configurazione tavoli, non dalle prenotazioni.';


-- ============================================================================
-- migrations/0011_realtime.sql
-- ============================================================================
-- Abilita Supabase Realtime sulle prenotazioni: il pannello gestionale riceve
-- in tempo reale gli insert/update (es. prenotazione arrivata dal widget) senza
-- refresh. La consegna degli eventi rispetta comunque la RLS: solo lo staff del
-- locale (policy reservations_select_staff) riceve le righe del proprio venue.
--
-- Nota: la publication supabase_realtime è creata dal progetto Supabase. Il
-- guard evita errori se la tabella è già inclusa.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'reservations'
  ) then
    alter publication supabase_realtime add table reservations;
  end if;
end $$;

-- REPLICA IDENTITY FULL così i payload di UPDATE/DELETE includono i valori
-- vecchi delle colonne usate nei filtri realtime (es. venue_id, reservation_date).
alter table reservations replica identity full;


-- ============================================================================
-- seed.sql
-- ============================================================================
-- Dati di esempio per sviluppo locale (supabase start / db reset).
-- NON eseguire su un progetto di produzione: crea un locale demo con zone,
-- tavoli e turni gia' configurati per poter testare subito widget e pannello.

insert into venues (id, name, slug, phone, address, timezone, widget_booking_window_days, active)
values (
  '00000000-0000-0000-0000-000000000001',
  'Pizzeria Da Mario',
  'pizzeria-da-mario',
  '+39 000 0000000',
  'Via Roma 1, Milano',
  'Europe/Rome',
  7,
  true
);

insert into zones (id, venue_id, name, sort_order) values
  ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', 'Sala',   1),
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 'Dehors', 2);

insert into restaurant_tables (venue_id, zone_id, code, seats_max) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'S1', 2),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'S2', 2),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'S3', 4),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'S4', 4),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'S5', 6),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'S6', 8),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000011', 'D1', 2),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000011', 'D2', 4),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000011', 'D3', 6);

insert into service_shifts (venue_id, code, name, start_time, end_time, sort_order) values
  ('00000000-0000-0000-0000-000000000001', 'turno_1', 'Turno I',  '19:00', '21:00', 1),
  ('00000000-0000-0000-0000-000000000001', 'turno_2', 'Turno II', '21:00', '23:00', 2);

-- Per collegare un utente staff al locale demo dopo averlo creato in
-- Supabase Auth (dashboard > Authentication > Users), esegui a mano:
--
-- insert into venue_staff (venue_id, user_id, role)
-- values ('00000000-0000-0000-0000-000000000001', '<uuid-utente-auth>', 'owner');
