-- Additivo: permette al gestionale di configurare il link pubblico del menu.
-- Non modifica prenotazioni, tavoli, RPC o dati esistenti.

alter table venues
  add column if not exists menu_url text;

comment on column venues.menu_url is 'URL pubblico del menu digitale del locale, usato dal widget pubblico.';
