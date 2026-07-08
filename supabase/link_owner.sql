-- ============================================================================
-- COLLEGA IL TUO UTENTE COME TITOLARE DEL LOCALE DEMO
-- Eseguilo DOPO aver creato l'utente in Supabase → Authentication → Users.
-- Sostituisci l'email con quella dell'utente che hai creato.
-- ============================================================================

insert into venue_staff (venue_id, user_id, role)
select
  '00000000-0000-0000-0000-000000000001',           -- locale demo (Pizzeria Da Mario)
  u.id,
  'owner'
from auth.users u
where u.email = 'TUA_EMAIL_QUI@esempio.com'          -- <-- CAMBIA QUESTA EMAIL
on conflict (venue_id, user_id) do update set role = 'owner';

-- Verifica: deve restituire una riga con la tua email e role = owner.
select vs.role, u.email, v.name as locale
from venue_staff vs
join auth.users u on u.id = vs.user_id
join venues v on v.id = vs.venue_id;
