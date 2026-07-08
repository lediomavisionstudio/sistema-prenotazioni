-- Prenotazioni

create table reservations (
  id                    uuid primary key default gen_random_uuid(),
  venue_id              uuid not null references venues(id) on delete cascade,
  reservation_date      date not null,
  shift_id              uuid not null references service_shifts(id) on delete restrict,
  -- Il limite di 12 coperti e' imposto solo al widget pubblico (dentro
  -- create_public_reservation), non qui: lo staff deve poter registrare
  -- manualmente anche gruppi/eventi piu' grandi.
  party_size            int not null check (party_size > 0),

  customer_first_name   text not null,
  customer_last_name    text not null,
  customer_phone        text not null,
  notes                 text,                 -- seggiolone, allergie, preferenza dehors...

  status                reservation_status not null default 'in_attesa',
  source                reservation_source not null default 'manuale',

  -- Tavolo suggerito/assegnato. Popolato dalla funzione di assegnazione
  -- automatica al momento della richiesta (suggerimento), ma resta
  -- modificabile dallo staff finche' la prenotazione non e' confermata.
  -- Vedi docs/DATABASE.md per la semantica esatta.
  table_id              uuid references restaurant_tables(id) on delete set null,

  created_by            uuid references auth.users(id),   -- valorizzato solo per source='manuale'

  confirmed_at          timestamptz,
  arrived_at            timestamptz,
  cancelled_at          timestamptz,
  cancellation_reason   text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table reservations is 'Ogni prenotazione nasce in stato in_attesa, sia che arrivi dal widget pubblico sia che venga inserita manualmente dallo staff. Il gestore la accetta o rifiuta dal pannello.';

create index reservations_venue_date_shift_idx on reservations (venue_id, reservation_date, shift_id);
create index reservations_table_idx on reservations (table_id);
create index reservations_status_idx on reservations (venue_id, status);

-- Predisposta per fase 2 (accorpamento di piu' tavoli su una stessa
-- prenotazione per party numerosi). Non ancora utilizzata dalla logica
-- applicativa attuale: in questa fase ogni prenotazione usa un solo tavolo
-- (colonna reservations.table_id) e se non c'e' un tavolo abbastanza grande
-- il widget segnala assenza di disponibilita'.
create table reservation_tables (
  reservation_id  uuid not null references reservations(id) on delete cascade,
  table_id        uuid not null references restaurant_tables(id) on delete restrict,
  primary key (reservation_id, table_id)
);
