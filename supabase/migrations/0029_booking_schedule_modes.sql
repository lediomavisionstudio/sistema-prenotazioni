-- Configurazione ufficiale della modalita' di prenotazione del locale.
-- Additiva e compatibile: non modifica reservations, waitlist, RPC o dati esistenti.

alter table venues
  add column if not exists booking_same_mode_all_days boolean not null default true,
  add column if not exists booking_mode text not null default 'shifts',
  add column if not exists booking_mode_by_weekday jsonb not null default
    '{"1":"shifts","2":"shifts","3":"shifts","4":"shifts","5":"shifts","6":"shifts","7":"shifts"}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'venues_booking_mode_check'
  ) then
    alter table venues
      add constraint venues_booking_mode_check
      check (booking_mode in ('shifts', 'free'));
  end if;
end $$;

comment on column venues.booking_same_mode_all_days is
  'TRUE = usa booking_mode per tutti i giorni; FALSE = usa booking_mode_by_weekday.';

comment on column venues.booking_mode is
  'Modalita prenotazione globale: shifts = turni, free = orari liberi.';

comment on column venues.booking_mode_by_weekday is
  'Modalita per giorno ISO 1-7 quando booking_same_mode_all_days e FALSE.';
