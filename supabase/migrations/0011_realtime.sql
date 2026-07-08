-- Abilita Supabase Realtime sulle prenotazioni: il pannello gestionale riceve
-- in tempo reale gli insert/update (es. prenotazione arrivata dal widget) senza
-- refresh. La consegna degli eventi rispetta comunque la RLS: solo lo staff del
-- locale (policy reservations_select_staff) riceve le righe del proprio venue.
--
-- Nota: la publication supabase_realtime è creata dal progetto Supabase. Il
-- guard evita errori se la tabella è già inclusa.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'reservations'
  ) then
    alter publication supabase_realtime add table reservations;
  end if;
end $$;

-- REPLICA IDENTITY FULL così i payload di UPDATE/DELETE includono i valori
-- vecchi delle colonne usate nei filtri realtime (es. venue_id, reservation_date).
alter table reservations replica identity full;
