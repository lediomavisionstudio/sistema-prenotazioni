-- ============================================================================
-- APPLICA BRANDING + CONTATTI PER LOCALE — Sistema Prenotazioni
-- Incolla nel SQL Editor di Supabase ed esegui (RUN).
-- Riunisce le migration 0016 (branding) e 0017 (contatti/retention).
-- ADDITIVO e SICURO: aggiunge solo colonne a venues (IF NOT EXISTS, quindi si
-- può rieseguire senza errori), non tocca dati esistenti. I locali attuali
-- restano col tema di default e i placeholder privacy da compilare.
-- ============================================================================

-- 0016 — Branding
alter table venues
  add column if not exists brand_primary      text,
  add column if not exists brand_primary_dark text,
  add column if not exists logo_url           text;

comment on column venues.brand_primary is 'Colore accento del widget (hex). NULL = tema di default.';
comment on column venues.brand_primary_dark is 'Variante scura dell''accento (hex) per hover/testi. NULL = derivata dal primario.';
comment on column venues.logo_url is 'URL del logo del locale, mostrato in cima al widget. NULL = solo nome testuale.';

-- 0017 — Contatti / conservazione dati (per l'informativa privacy)
alter table venues
  add column if not exists contact_email         text,
  add column if not exists data_retention_months int not null default 24;

comment on column venues.contact_email is 'Email di contatto del locale per le richieste privacy. NULL = placeholder da compilare.';
comment on column venues.data_retention_months is 'Mesi di conservazione dei dati prenotazione, mostrati nell''informativa (default 24).';

-- Esempio (opzionale) per personalizzare un locale:
-- update venues set
--   brand_primary = '#1f6f4a',
--   logo_url      = 'https://.../logo.png',
--   contact_email = 'info@dalluigi.it'
--   where slug = 'pizzeria-da-mario';
