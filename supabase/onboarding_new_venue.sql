-- ============================================================================
-- ONBOARDING NUOVO LOCALE (modello condiviso)
-- Aggiunge un'attività al sistema SENZA creare un nuovo progetto/deploy.
-- Compila i <SEGNAPOSTO>, incolla nel SQL Editor ed esegui i blocchi in ordine.
-- Vedi docs/ONBOARDING.md per la procedura completa passo-passo.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- BLOCCO 1 — Crea il locale
-- closed_weekdays: giorni di chiusura fissa (ISO 1=lun..7=dom). Es. '{2}' = chiuso il martedì.
-- I campi brand_* e logo_url sono opzionali (NULL = tema di default).
-- ----------------------------------------------------------------------------
insert into venues (name, slug, phone, address, timezone, widget_booking_window_days, closed_weekdays, brand_primary, logo_url, active)
values (
  '<NOME LOCALE>',            -- es. 'Pub Da Luigi'
  '<slug-url>',              -- es. 'pub-da-luigi'  (minuscolo, senza spazi: finisce nel link ?locale=)
  '<TELEFONO>',              -- es. '+39 02 1234567'
  '<INDIRIZZO>',             -- es. 'Via Verdi 10, Milano'
  'Europe/Rome',
  7,                          -- giorni di anticipo prenotabili
  '{}',                       -- chiusure settimanali, es. '{1}' per chiuso il lunedì
  null,                       -- brand_primary, es. '#1f6f4a' (NULL = default rosso)
  null,                       -- logo_url, es. 'https://.../logo.png'
  true
);

-- ----------------------------------------------------------------------------
-- BLOCCO 2 — Collega l'utente titolare (owner)
-- PRIMA crea l'utente in Supabase: Authentication > Users > Add user (email+password).
-- Copia il suo UUID e incollalo qui sotto.
-- ----------------------------------------------------------------------------
insert into venue_staff (venue_id, user_id, role)
select v.id, '<UUID-UTENTE-AUTH>', 'owner'
from venues v
where v.slug = '<slug-url>';

-- ----------------------------------------------------------------------------
-- FATTO. Ora il titolare accede a /admin/ e configura da solo, dal pannello
-- Impostazioni: zone, tavoli, orari turni e chiusure straordinarie.
--
-- In alternativa, se preferisci precaricare la sala via SQL, usa il BLOCCO 3.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- BLOCCO 3 (opzionale) — Precarica zone / tavoli / turni via SQL
-- ----------------------------------------------------------------------------
-- Zone
-- insert into zones (venue_id, name, sort_order)
-- select id, 'Sala', 1 from venues where slug = '<slug-url>';
-- insert into zones (venue_id, name, sort_order)
-- select id, 'Dehors', 2 from venues where slug = '<slug-url>';

-- Tavoli (ripeti la riga per ogni tavolo; code univoco per locale)
-- insert into restaurant_tables (venue_id, zone_id, code, seats_min, seats_max)
-- select z.venue_id, z.id, 'S1', 1, 2
-- from zones z join venues v on v.id = z.venue_id
-- where v.slug = '<slug-url>' and z.name = 'Sala';

-- Turni
-- insert into service_shifts (venue_id, code, name, start_time, end_time, sort_order)
-- select id, 'turno_1', 'Turno I', '19:00', '21:00', 1 from venues where slug = '<slug-url>';
-- insert into service_shifts (venue_id, code, name, start_time, end_time, sort_order)
-- select id, 'turno_2', 'Turno II', '21:00', '23:00', 2 from venues where slug = '<slug-url>';
