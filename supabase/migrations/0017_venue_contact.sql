-- Contatti e conservazione dati per locale — usati dall'informativa privacy.
--
-- La pagina privacy-policy.html si compila da sola leggendo questi campi (più
-- name/address già presenti su venues), così non serve modificare l'HTML per
-- ogni locale nel modello condiviso.

alter table venues
  add column contact_email        text,              -- email di contatto per i diritti privacy
  add column data_retention_months int not null default 24;  -- mesi di conservazione dati

comment on column venues.contact_email is 'Email di contatto del locale per le richieste privacy (mostrata nell''informativa). NULL = placeholder da compilare.';
comment on column venues.data_retention_months is 'Mesi di conservazione dei dati prenotazione, mostrati nell''informativa privacy (default 24).';
