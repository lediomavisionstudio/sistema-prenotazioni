-- Email OTP opzionale per il widget pubblico.
-- Migration puramente additiva:
-- - crea una tabella dedicata;
-- - crea indici dedicati;
-- - abilita RLS e una policy di lettura staff sulla nuova tabella.
--
-- Non modifica, non elimina e non ricrea RPC esistenti.
-- Non aggiunge trigger su tabelle esistenti.
-- Non altera reservations, waitlist, venues o altre tabelle gia' in uso.

create table if not exists email_verification_codes (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  client_request_id text not null,
  email text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  verified_at timestamptz,
  used_at timestamptz,
  attempt_count int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists email_verification_codes_lookup_idx
  on email_verification_codes (client_request_id, lower(email), created_at desc);

create index if not exists email_verification_codes_staff_idx
  on email_verification_codes (venue_id, client_request_id, lower(email))
  where verified_at is not null;

alter table email_verification_codes enable row level security;

drop policy if exists email_verification_codes_select_staff on email_verification_codes;
create policy email_verification_codes_select_staff
  on email_verification_codes for select
  to authenticated
  using (is_staff_of(venue_id));
