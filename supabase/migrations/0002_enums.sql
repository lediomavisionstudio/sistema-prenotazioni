-- Tipi enumerati

create type staff_role as enum ('owner', 'staff');

-- Stato del ciclo di vita di una prenotazione.
-- Ogni prenotazione (sia da widget pubblico che manuale) nasce sempre
-- 'in_attesa': l'assegnazione del tavolo e' solo un suggerimento del sistema,
-- e' il gestore del locale che deve confermare o rifiutare dal pannello.
create type reservation_status as enum (
  'in_attesa',
  'confermata',
  'arrivato',
  'no_show',
  'annullata'
);

create type reservation_source as enum ('widget', 'manuale');
