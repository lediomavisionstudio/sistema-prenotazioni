-- ============================================================================
-- SEED DI TEST — Lista d'attesa
-- Incolla nel SQL Editor di Supabase ed esegui (RUN).
--
-- SOLO PER TEST, NON per produzione: crea prenotazioni finte 'confermata' su
-- TUTTI i tavoli attivi del locale per il PRIMO turno di OGGI, così quel turno
-- risulta "Completo" nel widget e si può provare la coda.
--
-- I dati di test hanno cognome che inizia con 'ZZTEST ' per ritrovarli e
-- cancellarli (vedi blocco PULIZIA in fondo).
-- ============================================================================

insert into reservations (
  venue_id, reservation_date, shift_id, party_size,
  customer_first_name, customer_last_name, customer_phone,
  status, source, table_id
)
select
  v.id, current_date, s.id, t.seats_max,
  'Test', 'ZZTEST ' || t.code, '+390000000000',
  'confermata', 'manuale', t.id
from venues v
join service_shifts s
  on s.venue_id = v.id and s.active
  and extract(isodow from current_date)::smallint = any (s.days_of_week)
join restaurant_tables t
  on t.venue_id = v.id and t.active
where v.slug = 'pizzeria-da-mario'
  and s.sort_order = (
    select min(s2.sort_order)
    from service_shifts s2
    where s2.venue_id = v.id and s2.active
      and extract(isodow from current_date)::smallint = any (s2.days_of_week)
  );

-- Quante prenotazioni di test ho inserito (= numero di tavoli attivi):
select count(*) as tavoli_occupati_test
from reservations
where customer_last_name like 'ZZTEST %'
  and reservation_date = current_date;


-- ============================================================================
-- PULIZIA — esegui questo blocco (da solo) quando hai finito di testare, per
-- rimuovere le prenotazioni finte. Le voci di coda create dal widget con nomi
-- veri NON sono ZZTEST: cancellale dal pannello (Rimuovi) o a mano.
-- ============================================================================
-- delete from reservations where customer_last_name like 'ZZTEST %';
-- delete from waitlist     where customer_last_name like 'ZZTEST %';
