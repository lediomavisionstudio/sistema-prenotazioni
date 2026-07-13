-- Stato operativo sala per la mappa live del gestionale.
-- Additiva: non modifica RPC, prenotazioni o regole di assegnazione.

alter table restaurant_tables
  add column if not exists operational_status text,
  add column if not exists service_group_id uuid,
  add column if not exists operational_updated_at timestamptz;

alter table restaurant_tables
  drop constraint if exists restaurant_tables_operational_status_check;

alter table restaurant_tables
  add constraint restaurant_tables_operational_status_check
  check (
    operational_status is null
    or operational_status in ('seated', 'paying', 'dirty')
  );

create index if not exists restaurant_tables_service_group_idx
  on restaurant_tables (venue_id, service_group_id)
  where service_group_id is not null;

do $$
begin
  if exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'restaurant_tables'
  ) then
    alter publication supabase_realtime add table restaurant_tables;
  end if;
end $$;

alter table restaurant_tables replica identity full;

comment on column restaurant_tables.operational_status is 'Stato operativo sala: seated, paying, dirty. Libero/prenotato/fuori servizio sono derivati da prenotazioni e active.';
comment on column restaurant_tables.service_group_id is 'Identificatore visuale per tavoli uniti in sala operativa.';
comment on column restaurant_tables.operational_updated_at is 'Timestamp ultimo cambio stato operativo sala.';
