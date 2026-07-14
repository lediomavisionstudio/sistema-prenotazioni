-- Assegnazione multipla tavoli.
-- Mantiene compatibilita' con reservations.table_id usando il primo tavolo
-- selezionato come riferimento legacy, mentre la lista completa vive in
-- reservation_tables.

alter type reservation_status add value if not exists 'terminata';

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
  v_table_ids uuid[] := coalesce(p_table_ids, array[]::uuid[]);
  v_first_table_id uuid;
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

  select coalesce(array_agg(distinct selected.table_id), array[]::uuid[])
    into v_table_ids
  from unnest(v_table_ids) selected(table_id)
  where selected.table_id is not null;

  if cardinality(v_table_ids) = 0 then
    delete from reservation_tables where reservation_id = v_res.id;
    update reservations set table_id = null where id = v_res.id;
    return;
  end if;

  if exists (
    select 1
    from unnest(v_table_ids) selected(table_id)
    left join restaurant_tables t
      on t.id = selected.table_id
      and t.venue_id = v_res.venue_id
      and t.active
    where t.id is null
  ) then
    raise exception 'TAVOLO_NON_VALIDO' using errcode = 'P0001';
  end if;

  select coalesce(sum(t.seats_max), 0)
    into v_capacity
  from restaurant_tables t
  where t.id = any(v_table_ids)
    and t.venue_id = v_res.venue_id
    and t.active;

  if v_res.party_size > v_capacity then
    raise exception 'TAVOLO_NON_COMPATIBILE' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from reservations r
    where r.id <> v_res.id
      and r.reservation_date = v_res.reservation_date
      and r.shift_id = v_res.shift_id
      and r.status not in ('annullata', 'no_show')
      and (
        r.table_id = any(v_table_ids)
        or exists (
          select 1
          from reservation_tables rt
          where rt.reservation_id = r.id
            and rt.table_id = any(v_table_ids)
        )
      )
  ) then
    raise exception 'TAVOLO_GIA_ASSEGNATO' using errcode = 'P0001';
  end if;

  select t.id into v_first_table_id
  from restaurant_tables t
  where t.id = any(v_table_ids)
  order by t.code asc
  limit 1;

  delete from reservation_tables where reservation_id = v_res.id;

  insert into reservation_tables (reservation_id, table_id)
  select v_res.id, selected.table_id
  from unnest(v_table_ids) selected(table_id);

  update reservations
    set table_id = v_first_table_id
    where id = v_res.id;

  return query
  select t.id, t.code
  from restaurant_tables t
  where t.id = any(v_table_ids)
  order by t.code asc;
end;
$$;

revoke execute on function assign_reservation_tables(uuid, uuid[]) from public;
grant execute on function assign_reservation_tables(uuid, uuid[]) to authenticated;

create or replace function assign_reservation_table(
  p_reservation_id uuid,
  p_table_id       uuid
) returns table (
  table_id   uuid,
  table_code text
)
language sql
security definer
set search_path = public
as $$
  select *
  from assign_reservation_tables(
    p_reservation_id,
    case
      when p_table_id is null then array[]::uuid[]
      else array[p_table_id]::uuid[]
    end
  );
$$;

revoke execute on function assign_reservation_table(uuid, uuid) from public;
grant execute on function assign_reservation_table(uuid, uuid) to authenticated;

create or replace function reservations_release_tables_on_terminal_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status
    and new.status::text in ('annullata', 'no_show', 'terminata')
  then
    delete from reservation_tables where reservation_id = new.id;
    new.table_id = null;
  end if;

  return new;
end;
$$;

drop trigger if exists reservations_release_tables_on_terminal_status
  on reservations;

create trigger reservations_release_tables_on_terminal_status
  before update of status on reservations
  for each row
  execute function reservations_release_tables_on_terminal_status();

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'reservation_tables'
  ) then
    alter publication supabase_realtime add table reservation_tables;
  end if;
end $$;

alter table reservation_tables replica identity full;
