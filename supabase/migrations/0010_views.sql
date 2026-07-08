-- Vista di supporto per la dashboard KPI del pannello gestionale.
-- security_invoker = true: la vista NON bypassa la RLS di reservations,
-- quindi ogni utente vede solo i dati dei locali di cui e' staff, esattamente
-- come se interrogasse reservations direttamente.

create view venue_shift_occupancy
with (security_invoker = true) as
select
  r.venue_id,
  r.reservation_date,
  r.shift_id,
  count(*) filter (where r.status in ('confermata', 'arrivato'))            as prenotazioni_confermate,
  count(*) filter (where r.status = 'in_attesa')                            as prenotazioni_in_attesa,
  count(*) filter (where r.status = 'no_show')                              as prenotazioni_no_show,
  count(*) filter (where r.status = 'annullata')                            as prenotazioni_annullate,
  coalesce(sum(r.party_size) filter (where r.status in ('confermata', 'arrivato')), 0) as coperti_confermati
from reservations r
group by r.venue_id, r.reservation_date, r.shift_id;

comment on view venue_shift_occupancy is 'Aggregati per KPI dashboard (coperti totali, n. prenotazioni per stato). La % di occupazione va calcolata lato client dividendo coperti_confermati per la capienza totale del locale (somma seats_max di restaurant_tables attivi), perche'' quella dipende dalla configurazione tavoli, non dalle prenotazioni.';
