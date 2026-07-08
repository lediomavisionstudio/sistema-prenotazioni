-- Trigger generico per aggiornare updated_at

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger venues_set_updated_at
  before update on venues
  for each row execute function set_updated_at();

create trigger reservations_set_updated_at
  before update on reservations
  for each row execute function set_updated_at();

-- Quando lo stato di una prenotazione cambia, registra automaticamente il
-- timestamp corrispondente (evita che il client debba impostarlo a mano e
-- garantisce coerenza indipendentemente da dove arriva l'update).
create or replace function reservations_set_status_timestamps()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    case new.status
      when 'confermata' then
        new.confirmed_at = coalesce(new.confirmed_at, now());
      when 'arrivato' then
        new.arrived_at = coalesce(new.arrived_at, now());
      when 'annullata' then
        new.cancelled_at = coalesce(new.cancelled_at, now());
      else
        -- no_show e in_attesa non hanno un timestamp dedicato oltre updated_at
        null;
    end case;
  end if;
  return new;
end;
$$;

create trigger reservations_status_timestamps
  before update on reservations
  for each row execute function reservations_set_status_timestamps();
