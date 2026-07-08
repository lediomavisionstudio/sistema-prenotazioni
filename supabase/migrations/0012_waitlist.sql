-- Lista d'attesa (waitlist)
--
-- Quando tutti i tavoli adatti di un turno sono gia' occupati, il widget offre
-- al cliente di mettersi in lista d'attesa invece di prenotare. La posizione in
-- coda e' data dall'ordine di inserimento (created_at) tra le voci ancora
-- 'in_coda' dello stesso locale/data/turno.
--
-- Ciclo di vita di una voce:
--   in_coda   -> appena inserita dal widget, in attesa che si liberi un tavolo
--   promossa  -> convertita in una prenotazione 'in_attesa' (vedi
--                0014_waitlist_functions.sql); promoted_reservation_id la collega
--   rimossa   -> tolta manualmente dallo staff (non si cancella la riga, come
--                per reservations: si conserva lo storico)

create type waitlist_status as enum ('in_coda', 'promossa', 'rimossa');

create table waitlist (
  id                      uuid primary key default gen_random_uuid(),
  venue_id                uuid not null references venues(id) on delete cascade,
  reservation_date        date not null,
  shift_id                uuid not null references service_shifts(id) on delete restrict,
  -- Il widget pubblico limita i coperti a 1..12 (dentro join_waitlist), come per
  -- le prenotazioni.
  party_size              int not null check (party_size > 0),

  customer_first_name     text not null,
  customer_last_name      text not null,
  customer_phone          text not null,
  notes                   text,

  status                  waitlist_status not null default 'in_coda',
  -- Prenotazione generata al momento della promozione (tracciabilita').
  promoted_reservation_id uuid references reservations(id) on delete set null,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on table waitlist is 'Coda di attesa per turni pieni. La posizione e'' l''ordine di created_at tra le voci in_coda dello stesso venue/data/turno. La promozione crea una prenotazione in_attesa e porta la voce a promossa.';

-- Ordinamento della coda per venue/data/turno (created_at nell'indice per
-- servire "il primo in coda" senza sort aggiuntivo).
create index waitlist_venue_date_shift_idx on waitlist (venue_id, reservation_date, shift_id, created_at);
create index waitlist_status_idx on waitlist (venue_id, status);

create trigger waitlist_set_updated_at
  before update on waitlist
  for each row execute function set_updated_at();
