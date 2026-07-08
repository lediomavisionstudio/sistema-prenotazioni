-- Funzioni helper per le policy RLS.
-- Sono SQL "stable" e girano con i permessi di chi le chiama (non security
-- definer): la riga di venue_staff che leggono e' comunque visibile perche'
-- la policy su venue_staff permette a ciascun utente di leggere le proprie
-- righe (vedi 0008_rls_policies.sql).

create or replace function is_staff_of(p_venue_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from venue_staff vs
    where vs.venue_id = p_venue_id
      and vs.user_id = auth.uid()
  );
$$;

create or replace function is_owner_of(p_venue_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from venue_staff vs
    where vs.venue_id = p_venue_id
      and vs.user_id = auth.uid()
      and vs.role = 'owner'
  );
$$;
