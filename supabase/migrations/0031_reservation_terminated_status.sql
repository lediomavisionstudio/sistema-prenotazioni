-- Supporto stato "terminato" per il flusso operativo admin.
-- Additiva: non modifica dati esistenti e non cambia il flusso pubblico.

alter type reservation_status add value if not exists 'terminato' after 'arrivato';

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
  v_res reservations%rowtype;
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
      and r.status not in ('annullata', 'no_show', 'terminato')
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

create or replace function assign_reservation_tables(
  p_reservation_id uuid,
  p_table_ids      uuid[]
) returns table (
  table_id   uuid,
  table_code text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res reservations%rowtype;
  v_ids uuid[];
  v_capacity int;
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

  select coalesce(array_agg(distinct id), '{}'::uuid[]) into v_ids
  from unnest(coalesce(p_table_ids, '{}'::uuid[])) as selected(id)
  where id is not null;

  delete from reservation_tables
  where reservation_id = v_res.id;

  if coalesce(array_length(v_ids, 1), 0) = 0 then
    update reservations set table_id = null where id = v_res.id;
    return;
  end if;

  if exists (
    select 1
    from unnest(v_ids) selected(id)
    left join restaurant_tables t
      on t.id = selected.id
      and t.venue_id = v_res.venue_id
      and t.active
    where t.id is null
  ) then
    raise exception 'TAVOLO_NON_VALIDO' using errcode = 'P0001';
  end if;

  select coalesce(sum(t.seats_max), 0) into v_capacity
  from restaurant_tables t
  where t.id = any(v_ids)
    and t.venue_id = v_res.venue_id
    and t.active;

  if v_capacity < v_res.party_size then
    raise exception 'CAPIENZA_INSUFFICIENTE' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from reservations r
    left join reservation_tables rt on rt.reservation_id = r.id
    where r.id <> v_res.id
      and r.reservation_date = v_res.reservation_date
      and r.shift_id = v_res.shift_id
      and r.status not in ('annullata', 'no_show', 'terminato')
      and coalesce(rt.table_id, r.table_id) = any(v_ids)
  ) then
    raise exception 'TAVOLO_GIA_ASSEGNATO' using errcode = 'P0001';
  end if;

  insert into reservation_tables (reservation_id, table_id)
  select v_res.id, id
  from unnest(v_ids) as id;

  update reservations
    set table_id = v_ids[1]
    where id = v_res.id;

  return query
    select t.id, t.code
    from restaurant_tables t
    where t.id = any(v_ids)
    order by array_position(v_ids, t.id);
end;
$$;

revoke execute on function assign_reservation_tables(uuid, uuid[]) from public;
grant execute on function assign_reservation_tables(uuid, uuid[]) to authenticated;
