-- Funzioni della lista d'attesa.
--
-- join_waitlist()        : ingresso pubblico (widget), come create_public_reservation
--                          ma inserisce in waitlist e restituisce la posizione.
-- _promote_waitlist_entry: logica interna di promozione (crea la prenotazione).
-- promote_from_waitlist(): promozione manuale di una voce dal pannello.
-- promote_next_waitlist(): promuove il primo in coda (dopo annullamento/no-show).

-- join_waitlist(): unico punto d'ingresso pubblico per mettersi in coda quando
-- un turno e' pieno. Stessa validazione lato server di create_public_reservation
-- (non ci si fida del client). Non consuma tavoli: la coda non blocca posti.
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

-- _promote_waitlist_entry(): logica condivisa di promozione. Crea una
-- prenotazione 'in_attesa' dalla voce di coda, le assegna il tavolo suggerito
-- (se ce n'e' uno libero adatto, altrimenti resta senza tavolo: lo staff lo
-- assegnera' a mano) e porta la voce a 'promossa'. Restituisce i dati per la
-- notifica al gestore.
--
-- security definer: crea una reservation con source='widget', che le policy
-- vietano allo staff (reservations_insert_staff richiede source='manuale'); il
-- definer possiede la tabella e bypassa la RLS, come create_public_reservation.
-- Non ha grant a nessun ruolo: e' chiamabile solo dalle funzioni promote_*.
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

-- promote_from_waitlist(): promozione manuale di una voce specifica dal
-- pannello. security definer + controllo esplicito di appartenenza allo staff
-- (necessario perche' il definer bypassa la RLS).
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

-- promote_next_waitlist(): promuove il primo in coda per venue/data/turno.
-- Usata dopo un annullamento o un no-show per far scorrere la lista. Restituisce
-- 0 righe se la coda e' vuota. skip locked evita che due annullamenti in
-- parallelo promuovano la stessa voce.
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
