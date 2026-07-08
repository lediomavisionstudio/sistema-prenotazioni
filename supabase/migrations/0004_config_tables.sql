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
  seats_min   int not null default 1,
  seats_max   int not null,
  active      boolean not null default true,  -- tavolo temporaneamente fuori uso
  created_at  timestamptz not null default now(),
  unique (venue_id, code),
  check (seats_min > 0 and seats_max >= seats_min)
);

comment on table restaurant_tables is 'Tavolo fisico di un locale. seats_min/seats_max definiscono per quali coperti il tavolo e'' adatto (usati dal suggerimento automatico di assegnazione).';

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
