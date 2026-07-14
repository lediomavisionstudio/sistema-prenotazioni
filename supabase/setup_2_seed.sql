-- ============================================================================
-- PARTE 2 di 2 — DATI DEMO (locale, zone, tavoli, turni)
-- Esegui SOLO dopo che la Parte 1 e' andata a buon fine.
-- Controlla che l'ULTIMA riga sia "-- FINE PARTE 2", poi RUN.
-- ============================================================================

-- Dati di esempio per sviluppo locale (supabase start / db reset).
-- NON eseguire su un progetto di produzione: crea un locale demo con zone,
-- tavoli e turni gia' configurati per poter testare subito widget e pannello.

insert into venues (id, name, slug, phone, address, timezone, widget_booking_window_days, active)
values (
  '00000000-0000-0000-0000-000000000001',
  'Pizzeria Da Mario',
  'pizzeria-da-mario',
  '+39 000 0000000',
  'Via Roma 1, Milano',
  'Europe/Rome',
  7,
  true
);

insert into zones (id, venue_id, name, sort_order) values
  ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', 'Sala',   1),
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 'Dehors', 2);

insert into restaurant_tables (venue_id, zone_id, code, seats_min, seats_max) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'S1', 1, 2),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'S2', 1, 2),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'S3', 3, 4),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'S4', 3, 4),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'S5', 5, 6),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'S6', 7, 8),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000011', 'D1', 1, 2),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000011', 'D2', 3, 4),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000011', 'D3', 5, 6);

insert into service_shifts (venue_id, code, name, start_time, end_time, sort_order) values
  ('00000000-0000-0000-0000-000000000001', 'turno_1', 'Turno I',  '19:00', '21:00', 1),
  ('00000000-0000-0000-0000-000000000001', 'turno_2', 'Turno II', '21:00', '23:00', 2);

-- Per collegare un utente staff al locale demo dopo averlo creato in
-- Supabase Auth (dashboard > Authentication > Users), esegui a mano:
--
-- insert into venue_staff (venue_id, user_id, role)
-- values ('00000000-0000-0000-0000-000000000001', '<uuid-utente-auth>', 'owner');

-- FINE PARTE 2
