-- Personalizzazione per locale (branding) — modello multi-attività condiviso.
--
-- Finora colori e logo del widget erano fissi nel codice (uguali per tutti). Con
-- questi campi ogni locale può avere il proprio aspetto SENZA toccare il codice:
-- il widget, caricato il locale, applica colore accento e logo presi da qui.
--
-- Tutti nullable: un locale con valori NULL usa il tema di default (nessuna
-- regressione sui locali esistenti).

alter table venues
  add column brand_primary      text,   -- colore accento (hex, es. '#c8402a')
  add column brand_primary_dark text,   -- variante scura per hover (hex); se NULL il widget la deriva dal primario
  add column logo_url           text;   -- URL logo mostrato in cima al widget

comment on column venues.brand_primary is 'Colore accento del widget (hex). NULL = tema di default.';
comment on column venues.brand_primary_dark is 'Variante scura dell''accento (hex) per hover/testi. NULL = derivata dal primario.';
comment on column venues.logo_url is 'URL del logo del locale, mostrato in cima al widget. NULL = solo nome testuale.';
