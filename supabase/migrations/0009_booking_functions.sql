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
    and p_party_size between t.seats_min and t.seats_max
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
