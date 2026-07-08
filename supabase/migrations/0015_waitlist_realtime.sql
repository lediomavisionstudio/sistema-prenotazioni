-- Abilita Supabase Realtime sulla lista d'attesa: la sezione "Lista d'attesa"
-- del pannello riceve in tempo reale le nuove richieste dal widget e le
-- promozioni/rimozioni, senza refresh. La consegna rispetta la RLS
-- (waitlist_select_staff): ogni utente riceve solo la coda dei propri locali.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'waitlist'
  ) then
    alter publication supabase_realtime add table waitlist;
  end if;
end $$;

-- REPLICA IDENTITY FULL così i payload di UPDATE/DELETE includono i valori
-- vecchi delle colonne usate nei filtri realtime (es. venue_id, reservation_date).
alter table waitlist replica identity full;
