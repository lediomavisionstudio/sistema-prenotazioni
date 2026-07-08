-- =====================================================================
-- Calendario mensile + prenotazioni senza limite di finestra
-- =====================================================================
-- Additivo e idempotente: incollalo nel SQL Editor di Supabase.
-- Non tocca dati esistenti, ridefinisce solo delle funzioni.
--
--   1) get_widget_day_availability(): disponibilità dei turni per UNA data.
--      Serve al nuovo calendario del widget, che calcola i posti liberi solo
--      per il giorno effettivamente scelto (leggero anche con orizzonte ampio).
--   2) create_public_reservation(): rimosso il limite superiore della finestra
--      (widget_booking_window_days). Ora è prenotabile qualunque data futura;
--      resta il divieto sulle date passate.
--   3) join_waitlist(): stessa modifica sulla finestra.
-- =====================================================================

-- 1) Disponibilità per singola data --------------------------------------
create or replace function get_widget_day_availability(
  p_venue_slug text,
  p_party_size int,
  p_date       date
) returns table (
  shift_id   uuid,
  shift_code text,
  shift_name text,
  start_time time,
  end_time   time,
  available  boolean
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

  -- Niente disponibilità per date nulle o passate.
  if p_date is null or p_date < current_date then
    return;
  end if;

  return query
  select
    s.id,
    s.code,
    s.name,
    s.start_time,
    s.end_time,
    (
      not exists (
        select 1 from venue_closures c
        where c.venue_id = v_venue.id and c.closed_date = p_date
      )
      and not (extract(isodow from p_date)::smallint = any (v_venue.closed_weekdays))
      and suggest_table(v_venue.id, p_date, s.id, p_party_size) is not null
    ) as available
  from service_shifts s
  where s.venue_id = v_venue.id
    and s.active
    and extract(isodow from p_date)::smallint = any (s.days_of_week)
  order by s.sort_order;
end;
$$;

grant execute on function get_widget_day_availability(text, int, date) to anon, authenticated;

-- 2) Prenotazione pubblica senza limite superiore di finestra ------------
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
  table_code        text
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

  -- Nessun limite in avanti: si può prenotare qualunque data futura.
  if p_reservation_date < current_date then
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

-- 3) Lista d'attesa senza limite superiore di finestra -------------------
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

  -- Nessun limite in avanti: si può entrare in coda per qualunque data futura.
  if p_reservation_date < current_date then
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
