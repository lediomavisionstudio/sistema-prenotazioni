-- ============================================================================
-- APPLICA LA LISTA D'ATTESA — Sistema Prenotazioni
-- Incolla TUTTO questo file nel SQL Editor di Supabase ed esegui (RUN).
-- Riunisce le migration 0012-0015 (lista d'attesa).
--
-- ADDITIVO e SICURO su un DB esistente: NON azzera lo schema, NON tocca le
-- tabelle o i dati esistenti. Aggiunge solo la tabella waitlist, le sue policy,
-- le funzioni e il realtime.
--
-- Idempotenza: se lo esegui una seconda volta darà errore su "type/table already
-- exists" (create type/table non sono "or replace"). In tal caso è già applicato:
-- va eseguito una sola volta.
-- ============================================================================

-- ============================================================================
-- migrations/0012_waitlist.sql
-- ============================================================================
create type waitlist_status as enum ('in_coda', 'promossa', 'rimossa');

create table waitlist (
  id                      uuid primary key default gen_random_uuid(),
  venue_id                uuid not null references venues(id) on delete cascade,
  reservation_date        date not null,
  shift_id                uuid not null references service_shifts(id) on delete restrict,
  party_size              int not null check (party_size > 0),

  customer_first_name     text not null,
  customer_last_name      text not null,
  customer_phone          text not null,
  notes                   text,

  status                  waitlist_status not null default 'in_coda',
  promoted_reservation_id uuid references reservations(id) on delete set null,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on table waitlist is 'Coda di attesa per turni pieni. La posizione e'' l''ordine di created_at tra le voci in_coda dello stesso venue/data/turno. La promozione crea una prenotazione in_attesa e porta la voce a promossa.';

create index waitlist_venue_date_shift_idx on waitlist (venue_id, reservation_date, shift_id, created_at);
create index waitlist_status_idx on waitlist (venue_id, status);

create trigger waitlist_set_updated_at
  before update on waitlist
  for each row execute function set_updated_at();


-- ============================================================================
-- migrations/0013_waitlist_rls.sql
-- ============================================================================
alter table waitlist enable row level security;

create policy waitlist_select_staff
  on waitlist for select
  to authenticated
  using (is_staff_of(venue_id));

create policy waitlist_update_staff
  on waitlist for update
  to authenticated
  using (is_staff_of(venue_id))
  with check (is_staff_of(venue_id));


-- ============================================================================
-- migrations/0014_waitlist_functions.sql
-- ============================================================================
create or replace function join_waitlist(
  p_venue_slug       text,
  p_reservation_date date,
  p_shift_id         uuid,
  p_party_size       int,
  p_first_name       text,
  p_last_name        text,
  p_phone            text,
  p_notes            text default null
) returns table (
  waitlist_id      uuid,
  reservation_date date,
  shift_name       text,
  party_size       int,
  queue_position   int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_venue venues%rowtype;
  v_shift service_shifts%rowtype;
  v_wl    waitlist%rowtype;
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

  insert into waitlist (
    venue_id, reservation_date, shift_id, party_size,
    customer_first_name, customer_last_name, customer_phone, notes, status
  ) values (
    v_venue.id, p_reservation_date, p_shift_id, p_party_size,
    trim(p_first_name), trim(p_last_name), trim(p_phone), nullif(trim(p_notes), ''), 'in_coda'
  )
  returning * into v_wl;

  return query
  select
    v_wl.id,
    v_wl.reservation_date,
    v_shift.name,
    v_wl.party_size,
    (
      select count(*)::int
      from waitlist w
      where w.venue_id = v_wl.venue_id
        and w.reservation_date = v_wl.reservation_date
        and w.shift_id = v_wl.shift_id
        and w.status = 'in_coda'
        and w.created_at <= v_wl.created_at
    );
end;
$$;

grant execute on function join_waitlist(text, date, uuid, int, text, text, text, text) to anon, authenticated;

create or replace function _promote_waitlist_entry(p_waitlist_id uuid)
returns table (
  reservation_id uuid,
  first_name     text,
  last_name      text,
  party_size     int,
  table_code     text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wl    waitlist%rowtype;
  v_table uuid;
  v_res   reservations%rowtype;
begin
  select * into v_wl from waitlist where id = p_waitlist_id for update;
  if not found then
    raise exception 'VOCE_NON_TROVATA' using errcode = 'P0001';
  end if;
  if v_wl.status <> 'in_coda' then
    raise exception 'VOCE_NON_IN_CODA' using errcode = 'P0001';
  end if;

  v_table := suggest_table(v_wl.venue_id, v_wl.reservation_date, v_wl.shift_id, v_wl.party_size);

  insert into reservations (
    venue_id, reservation_date, shift_id, party_size,
    customer_first_name, customer_last_name, customer_phone, notes,
    status, source, table_id
  ) values (
    v_wl.venue_id, v_wl.reservation_date, v_wl.shift_id, v_wl.party_size,
    v_wl.customer_first_name, v_wl.customer_last_name, v_wl.customer_phone, v_wl.notes,
    'in_attesa', 'widget', v_table
  )
  returning * into v_res;

  update waitlist
    set status = 'promossa', promoted_reservation_id = v_res.id
    where id = v_wl.id;

  return query
  select
    v_res.id,
    v_wl.customer_first_name,
    v_wl.customer_last_name,
    v_wl.party_size,
    (select t.code from restaurant_tables t where t.id = v_table);
end;
$$;

revoke execute on function _promote_waitlist_entry(uuid) from public;

create or replace function promote_from_waitlist(p_waitlist_id uuid)
returns table (
  reservation_id uuid,
  first_name     text,
  last_name      text,
  party_size     int,
  table_code     text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_venue uuid;
begin
  select venue_id into v_venue from waitlist where id = p_waitlist_id;
  if v_venue is null then
    raise exception 'VOCE_NON_TROVATA' using errcode = 'P0001';
  end if;
  if not is_staff_of(v_venue) then
    raise exception 'NON_AUTORIZZATO' using errcode = 'P0001';
  end if;
  return query select * from _promote_waitlist_entry(p_waitlist_id);
end;
$$;

revoke execute on function promote_from_waitlist(uuid) from public;
grant execute on function promote_from_waitlist(uuid) to authenticated;

create or replace function promote_next_waitlist(
  p_venue_id uuid,
  p_date     date,
  p_shift_id uuid
) returns table (
  reservation_id uuid,
  first_name     text,
  last_name      text,
  party_size     int,
  table_code     text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next uuid;
begin
  if not is_staff_of(p_venue_id) then
    raise exception 'NON_AUTORIZZATO' using errcode = 'P0001';
  end if;

  select id into v_next
  from waitlist
  where venue_id = p_venue_id
    and reservation_date = p_date
    and shift_id = p_shift_id
    and status = 'in_coda'
  order by created_at asc
  limit 1
  for update skip locked;

  if v_next is null then
    return;
  end if;

  return query select * from _promote_waitlist_entry(v_next);
end;
$$;

revoke execute on function promote_next_waitlist(uuid, date, uuid) from public;
grant execute on function promote_next_waitlist(uuid, date, uuid) to authenticated;


-- ============================================================================
-- migrations/0015_waitlist_realtime.sql
-- ============================================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'waitlist'
  ) then
    alter publication supabase_realtime add table waitlist;
  end if;
end $$;

alter table waitlist replica identity full;
