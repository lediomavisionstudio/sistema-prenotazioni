-- Lettura pubblica minimale dello stato per la schermata finale del widget.
-- Espone solo lo status della prenotazione, senza dati personali.

create or replace function get_public_reservation_status(
  p_reservation_id uuid
)
returns text
language sql
security definer
set search_path = public
as $$
  select r.status::text
  from reservations r
  where r.id = p_reservation_id
  limit 1;
$$;

grant execute on function get_public_reservation_status(uuid) to anon, authenticated;
