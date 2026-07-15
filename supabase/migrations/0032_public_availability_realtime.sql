-- Segnale pubblico minimale per aggiornare il widget prenotazioni in realtime.
-- Non contiene dati personali: il widget riceve solo l'indicazione che deve
-- ricalcolare disponibilita/calendario per il proprio locale.

create table if not exists public_availability_events (
  id bigserial primary key,
  venue_id uuid not null references venues(id) on delete cascade,
  source_table text not null,
  event_type text not null,
  reservation_date date,
  created_at timestamptz not null default now()
);

create index if not exists public_availability_events_venue_created_idx
  on public_availability_events (venue_id, created_at desc);

alter table public_availability_events enable row level security;

drop policy if exists public_availability_events_select_public_or_staff
  on public_availability_events;

create policy public_availability_events_select_public_or_staff
  on public_availability_events for select
  to anon, authenticated
  using (
    exists (select 1 from venues v where v.id = venue_id and v.active)
    or is_staff_of(venue_id)
  );

create or replace function enqueue_public_availability_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_venue_id uuid;
  v_reservation_date date;
begin
  if TG_TABLE_NAME = 'venues' then
    if TG_OP = 'DELETE' then
      v_venue_id := old.id;
    else
      v_venue_id := new.id;
    end if;
  elsif TG_TABLE_NAME = 'venue_closures' then
    if TG_OP = 'DELETE' then
      v_venue_id := old.venue_id;
      v_reservation_date := old.closed_date;
    else
      v_venue_id := new.venue_id;
      v_reservation_date := new.closed_date;
    end if;
  elsif TG_TABLE_NAME = 'reservations' then
    if TG_OP = 'DELETE' then
      v_venue_id := old.venue_id;
      v_reservation_date := old.reservation_date;
    else
      v_venue_id := new.venue_id;
      v_reservation_date := new.reservation_date;
    end if;
  elsif TG_TABLE_NAME = 'reservation_tables' then
    select r.venue_id, r.reservation_date
      into v_venue_id, v_reservation_date
    from reservations r
    where r.id = case when TG_OP = 'DELETE' then old.reservation_id else new.reservation_id end;
  else
    if TG_OP = 'DELETE' then
      v_venue_id := old.venue_id;
    else
      v_venue_id := new.venue_id;
    end if;
  end if;

  if v_venue_id is not null then
    insert into public_availability_events (
      venue_id,
      source_table,
      event_type,
      reservation_date
    ) values (
      v_venue_id,
      TG_TABLE_NAME,
      TG_OP,
      v_reservation_date
    );
  end if;

  return null;
end;
$$;

drop trigger if exists reservations_public_availability_event on reservations;
create trigger reservations_public_availability_event
  after insert or update or delete on reservations
  for each row execute function enqueue_public_availability_event();

drop trigger if exists reservation_tables_public_availability_event on reservation_tables;
create trigger reservation_tables_public_availability_event
  after insert or update or delete on reservation_tables
  for each row execute function enqueue_public_availability_event();

drop trigger if exists restaurant_tables_public_availability_event on restaurant_tables;
create trigger restaurant_tables_public_availability_event
  after insert or update or delete on restaurant_tables
  for each row execute function enqueue_public_availability_event();

drop trigger if exists service_shifts_public_availability_event on service_shifts;
create trigger service_shifts_public_availability_event
  after insert or update or delete on service_shifts
  for each row execute function enqueue_public_availability_event();

drop trigger if exists venue_closures_public_availability_event on venue_closures;
create trigger venue_closures_public_availability_event
  after insert or update or delete on venue_closures
  for each row execute function enqueue_public_availability_event();

drop trigger if exists venues_public_availability_event on venues;
create trigger venues_public_availability_event
  after update on venues
  for each row execute function enqueue_public_availability_event();

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'public_availability_events'
  ) then
    alter publication supabase_realtime add table public_availability_events;
  end if;
end $$;

alter table public_availability_events replica identity full;
