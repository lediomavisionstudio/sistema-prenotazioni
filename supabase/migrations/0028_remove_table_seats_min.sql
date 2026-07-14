-- Rimuove la capacita' minima dei tavoli.
-- Da ora un tavolo e' compatibile se i coperti richiesti sono <= seats_max.

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

create or replace function assign_reservation_table(
  p_reservation_id uuid,
  p_table_id       uuid
) returns table (
  table_id   uuid,
  table_code text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res   reservations%rowtype;
  v_table restaurant_tables%rowtype;
begin
  select * into v_res
  from reservations
  where id = p_reservation_id
  for update;

  if not found then
    raise exception 'PRENOTAZIONE_NON_TROVATA' using errcode = 'P0001';
  end if;

  if not is_staff_of(v_res.venue_id) then
    raise exception 'NON_AUTORIZZATO' using errcode = 'P0001';
  end if;

  if p_table_id is null then
    update reservations set table_id = null where id = v_res.id;
    return query select null::uuid, null::text;
    return;
  end if;

  select * into v_table
  from restaurant_tables t
  where t.id = p_table_id
    and t.venue_id = v_res.venue_id
    and t.active
  for update;

  if not found then
    raise exception 'TAVOLO_NON_VALIDO' using errcode = 'P0001';
  end if;

  if v_res.party_size > v_table.seats_max then
    raise exception 'TAVOLO_NON_COMPATIBILE' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from reservations r
    where r.id <> v_res.id
      and r.table_id = v_table.id
      and r.reservation_date = v_res.reservation_date
      and r.shift_id = v_res.shift_id
      and r.status not in ('annullata', 'no_show')
  ) then
    raise exception 'TAVOLO_GIA_ASSEGNATO' using errcode = 'P0001';
  end if;

  update reservations
    set table_id = v_table.id
    where id = v_res.id;

  return query select v_table.id, v_table.code;
end;
$$;

revoke execute on function assign_reservation_table(uuid, uuid) from public;
grant execute on function assign_reservation_table(uuid, uuid) to authenticated;

alter table restaurant_tables
  drop column if exists seats_min;

comment on table restaurant_tables is 'Tavolo fisico di un locale. seats_max definisce il numero massimo di coperti.';
