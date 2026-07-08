-- Row Level Security per la lista d'attesa.
--
-- Come reservations, la tabella waitlist contiene PII dei clienti (nome,
-- telefono) e NON e' mai leggibile ne' inseribile direttamente da anon: il
-- widget pubblico crea voci solo tramite join_waitlist() (security definer,
-- vedi 0014_waitlist_functions.sql).
--
--  * Lo staff del locale legge e aggiorna la propria coda.
--  * La rimozione manuale e' un cambio di stato (status='rimossa'), non un
--    DELETE, per conservare lo storico.
--  * La promozione passa dalle funzioni promote_* (security definer): quelle
--    verificano l'appartenenza allo staff.

alter table waitlist enable row level security;

create policy waitlist_select_staff
  on waitlist for select
  to authenticated
  using (is_staff_of(venue_id));

create policy waitlist_update_staff
  on waitlist for update
  to authenticated
  using (is_staff_of(venue_id))
  with check (is_staff_of(venue_id));

-- Nessuna policy insert: le voci nascono solo da join_waitlist().
-- Nessuna policy delete: si usa status 'rimossa'.
