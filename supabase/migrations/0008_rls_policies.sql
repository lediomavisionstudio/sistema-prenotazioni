-- Row Level Security
--
-- Principio generale:
--  * Le tabelle di CONFIGURAZIONE (venues, zones, restaurant_tables,
--    service_shifts, venue_closures) sono leggibili pubblicamente (widget
--    anonimo) quando il locale e' attivo, ma modificabili solo dal owner
--    del locale.
--  * La tabella RESERVATIONS non e' MAI leggibile ne' inseribile
--    direttamente da anon: contiene PII dei clienti (nome, telefono).
--    Il widget pubblico crea prenotazioni esclusivamente tramite la funzione
--    create_public_reservation() (security definer, vedi 0009_booking_functions.sql),
--    che valida i dati e nasconde i dettagli delle altre prenotazioni.
--  * Nessun DELETE su reservations: l'annullamento e' un cambio di stato
--    ('annullata'), per mantenere lo storico/audit.

alter table venues              enable row level security;
alter table venue_staff         enable row level security;
alter table zones               enable row level security;
alter table restaurant_tables   enable row level security;
alter table service_shifts      enable row level security;
alter table venue_closures      enable row level security;
alter table reservations        enable row level security;
alter table reservation_tables  enable row level security;

-- venues -----------------------------------------------------------------

create policy venues_select_public_or_staff
  on venues for select
  to anon, authenticated
  using (active or is_staff_of(id));

create policy venues_update_owner
  on venues for update
  to authenticated
  using (is_owner_of(id))
  with check (is_owner_of(id));

-- Nessuna policy insert/delete: la creazione di un nuovo locale (onboarding
-- di un cliente pilota) si fa da dashboard Supabase / service_role.

-- venue_staff --------------------------------------------------------------

create policy venue_staff_select_self_or_owner
  on venue_staff for select
  to authenticated
  using (user_id = auth.uid() or is_owner_of(venue_id));

create policy venue_staff_insert_owner
  on venue_staff for insert
  to authenticated
  with check (is_owner_of(venue_id));

create policy venue_staff_update_owner
  on venue_staff for update
  to authenticated
  using (is_owner_of(venue_id))
  with check (is_owner_of(venue_id));

create policy venue_staff_delete_owner
  on venue_staff for delete
  to authenticated
  using (is_owner_of(venue_id));

-- Nota bootstrap: il primo owner di un locale non puo' auto-inserirsi (nessuna
-- riga venue_staff esiste ancora -> is_owner_of() e' false). Va creato una
-- tantum in fase di onboarding tramite service_role.

-- zones ----------------------------------------------------------------

create policy zones_select_public_or_staff
  on zones for select
  to anon, authenticated
  using (
    active and exists (select 1 from venues v where v.id = venue_id and v.active)
    or is_staff_of(venue_id)
  );

create policy zones_write_owner
  on zones for all
  to authenticated
  using (is_owner_of(venue_id))
  with check (is_owner_of(venue_id));

-- restaurant_tables ------------------------------------------------------

create policy restaurant_tables_select_public_or_staff
  on restaurant_tables for select
  to anon, authenticated
  using (
    active and exists (select 1 from venues v where v.id = venue_id and v.active)
    or is_staff_of(venue_id)
  );

create policy restaurant_tables_write_owner
  on restaurant_tables for all
  to authenticated
  using (is_owner_of(venue_id))
  with check (is_owner_of(venue_id));

-- service_shifts -----------------------------------------------------------

create policy service_shifts_select_public_or_staff
  on service_shifts for select
  to anon, authenticated
  using (
    active and exists (select 1 from venues v where v.id = venue_id and v.active)
    or is_staff_of(venue_id)
  );

create policy service_shifts_write_owner
  on service_shifts for all
  to authenticated
  using (is_owner_of(venue_id))
  with check (is_owner_of(venue_id));

-- venue_closures -----------------------------------------------------------
-- Leggibile pubblicamente: il widget deve sapere quali date nascondere dallo
-- step di scelta data, senza dover esporre altro.

create policy venue_closures_select_public_or_staff
  on venue_closures for select
  to anon, authenticated
  using (
    exists (select 1 from venues v where v.id = venue_id and v.active)
    or is_staff_of(venue_id)
  );

create policy venue_closures_write_owner
  on venue_closures for all
  to authenticated
  using (is_owner_of(venue_id))
  with check (is_owner_of(venue_id));

-- reservations ---------------------------------------------------------

create policy reservations_select_staff
  on reservations for select
  to authenticated
  using (is_staff_of(venue_id));

-- Inserimento manuale da pannello. source deve essere 'manuale': le
-- prenotazioni 'widget' possono nascere solo tramite create_public_reservation().
create policy reservations_insert_staff
  on reservations for insert
  to authenticated
  with check (is_staff_of(venue_id) and source = 'manuale');

create policy reservations_update_staff
  on reservations for update
  to authenticated
  using (is_staff_of(venue_id))
  with check (is_staff_of(venue_id));

-- Nessuna policy delete: vedi commento in cima al file.
-- Nessuna policy insert/select per anon: il widget pubblico passa sempre
-- dalla funzione create_public_reservation().

-- reservation_tables (predisposta per fase 2, accorpamento tavoli) -------

create policy reservation_tables_select_staff
  on reservation_tables for select
  to authenticated
  using (
    exists (
      select 1 from reservations r
      where r.id = reservation_id and is_staff_of(r.venue_id)
    )
  );

create policy reservation_tables_write_staff
  on reservation_tables for all
  to authenticated
  using (
    exists (
      select 1 from reservations r
      where r.id = reservation_id and is_staff_of(r.venue_id)
    )
  )
  with check (
    exists (
      select 1 from reservations r
      where r.id = reservation_id and is_staff_of(r.venue_id)
    )
  );
