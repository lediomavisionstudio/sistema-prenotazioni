-- Locali e staff

create table venues (
  id                          uuid primary key default gen_random_uuid(),
  name                        text not null,
  slug                        text not null unique,               -- usato nell'URL del widget pubblico, es. /w/pizzeria-da-mario
  phone                       text,
  address                     text,
  timezone                    text not null default 'Europe/Rome',
  widget_booking_window_days  int not null default 7,              -- quanti giorni in avanti il widget mostra
  closed_weekdays             smallint[] not null default '{}',    -- chiusura settimanale ricorrente (ISO dow: 1=lun..7=dom)
  active                      boolean not null default true,       -- locale disattivato = widget e login bloccati
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

comment on table venues is 'Un locale (pizzeria/pub) cliente della piattaforma. Ogni locale ha le proprie zone, tavoli, turni e prenotazioni.';

-- Collega gli utenti Supabase Auth (auth.users) ai locali che gestiscono.
-- Un utente puo' gestire piu' locali (es. stesso gruppo con piu' sedi) e un
-- locale puo' avere piu' membri staff.
create table venue_staff (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        staff_role not null default 'staff',
  created_at  timestamptz not null default now(),
  unique (venue_id, user_id)
);

comment on table venue_staff is 'Appartenenza di un utente autenticato a un locale. Il ruolo owner puo'' configurare zone/tavoli/turni/staff, staff gestisce solo il servizio (prenotazioni).';

create index venue_staff_user_id_idx on venue_staff (user_id);
