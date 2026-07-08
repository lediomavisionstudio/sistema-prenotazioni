-- GDPR pubblico: dati legali locale e consensi raccolti dal widget.
--
-- Additivo: non modifica l'area admin e non espone nuove policy pubbliche.
-- I consensi sono popolati solo dalle funzioni security definer del widget.

alter table venues
  add column if not exists legal_name text,
  add column if not exists vat_number text;

comment on column venues.legal_name is 'Ragione sociale del titolare, mostrata nelle pagine legali. NULL = usa venues.name o placeholder.';
comment on column venues.vat_number is 'Partita IVA o codice fiscale del titolare, mostrata nelle pagine legali.';

alter table reservations
  add column if not exists privacy_policy_accepted_at timestamptz,
  add column if not exists marketing_consent_at timestamptz;

comment on column reservations.privacy_policy_accepted_at is 'Timestamp di accettazione Privacy Policy nel widget pubblico.';
comment on column reservations.marketing_consent_at is 'Timestamp presente solo se il cliente ha espresso consenso marketing.';

alter table waitlist
  add column if not exists privacy_policy_accepted_at timestamptz,
  add column if not exists marketing_consent_at timestamptz;

comment on column waitlist.privacy_policy_accepted_at is 'Timestamp di accettazione Privacy Policy nel widget pubblico.';
comment on column waitlist.marketing_consent_at is 'Timestamp presente solo se il cliente ha espresso consenso marketing.';

create or replace function create_public_reservation(
  p_venue_slug               text,
  p_reservation_date         date,
  p_shift_id                 uuid,
  p_party_size               int,
  p_first_name               text,
  p_last_name                text,
  p_phone                    text,
  p_notes                    text default null,
  p_privacy_policy_accepted  boolean default false,
  p_marketing_consent        boolean default false
) returns table (
  reservation_id    uuid,
  status            reservation_status,
  reservation_date  date,
  shift_name        text,
  party_size        int,
  table_code        text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_venue   venues%rowtype;
  v_shift   service_shifts%rowtype;
  v_table   uuid;
  v_res     reservations%rowtype;
begin
  select * into v_venue from venues v where v.slug = p_venue_slug and v.active limit 1;
  if not found then
    raise exception 'LOCALE_NON_TROVATO' using errcode = 'P0001';
  end if;

  select * into v_shift
  from service_shifts s
  where s.id = p_shift_id and s.venue_id = v_venue.id and s.active
  limit 1;
  if not found then
    raise exception 'TURNO_NON_VALIDO' using errcode = 'P0001';
  end if;

  if p_reservation_date < current_date then
    raise exception 'DATA_FUORI_FINESTRA' using errcode = 'P0001';
  end if;

  if not (extract(isodow from p_reservation_date)::smallint = any (v_shift.days_of_week)) then
    raise exception 'TURNO_NON_DISPONIBILE_IN_QUESTO_GIORNO' using errcode = 'P0001';
  end if;

  if extract(isodow from p_reservation_date)::smallint = any (v_venue.closed_weekdays) then
    raise exception 'LOCALE_CHIUSO' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from venue_closures c
    where c.venue_id = v_venue.id and c.closed_date = p_reservation_date
  ) then
    raise exception 'LOCALE_CHIUSO' using errcode = 'P0001';
  end if;

  if p_party_size is null or p_party_size < 1 or p_party_size > 12 then
    raise exception 'COPERTI_NON_VALIDI' using errcode = 'P0001';
  end if;

  if coalesce(trim(p_first_name), '') = '' or coalesce(trim(p_last_name), '') = '' or coalesce(trim(p_phone), '') = '' then
    raise exception 'DATI_CLIENTE_INCOMPLETI' using errcode = 'P0001';
  end if;

  if coalesce(p_privacy_policy_accepted, false) is not true then
    raise exception 'PRIVACY_NON_ACCETTATA' using errcode = 'P0001';
  end if;

  v_table := suggest_table(v_venue.id, p_reservation_date, p_shift_id, p_party_size);
  if v_table is null then
    raise exception 'NESSUNA_DISPONIBILITA' using errcode = 'P0001';
  end if;

  insert into reservations (
    venue_id, reservation_date, shift_id, party_size,
    customer_first_name, customer_last_name, customer_phone, notes,
    status, source, table_id, privacy_policy_accepted_at, marketing_consent_at
  ) values (
    v_venue.id, p_reservation_date, p_shift_id, p_party_size,
    trim(p_first_name), trim(p_last_name), trim(p_phone), nullif(trim(p_notes), ''),
    'in_attesa', 'widget', v_table, now(),
    case when coalesce(p_marketing_consent, false) then now() else null end
  )
  returning * into v_res;

  return query
  select
    v_res.id,
    v_res.status,
    v_res.reservation_date,
    v_shift.name,
    v_res.party_size,
    (select t.code from restaurant_tables t where t.id = v_table);
end;
$$;

grant execute on function create_public_reservation(text, date, uuid, int, text, text, text, text, boolean, boolean) to anon, authenticated;

create or replace function join_waitlist(
  p_venue_slug               text,
  p_reservation_date         date,
  p_shift_id                 uuid,
  p_party_size               int,
  p_first_name               text,
  p_last_name                text,
  p_phone                    text,
  p_notes                    text default null,
  p_privacy_policy_accepted  boolean default false,
  p_marketing_consent        boolean default false
) returns table (
  waitlist_id      uuid,
  reservation_date date,
  shift_name       text,
  party_size       int,
  queue_position   int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_venue venues%rowtype;
  v_shift service_shifts%rowtype;
  v_wl    waitlist%rowtype;
begin
  select * into v_venue from venues v where v.slug = p_venue_slug and v.active limit 1;
  if not found then
    raise exception 'LOCALE_NON_TROVATO' using errcode = 'P0001';
  end if;

  select * into v_shift
  from service_shifts s
  where s.id = p_shift_id and s.venue_id = v_venue.id and s.active
  limit 1;
  if not found then
    raise exception 'TURNO_NON_VALIDO' using errcode = 'P0001';
  end if;

  if p_reservation_date < current_date then
    raise exception 'DATA_FUORI_FINESTRA' using errcode = 'P0001';
  end if;

  if not (extract(isodow from p_reservation_date)::smallint = any (v_shift.days_of_week)) then
    raise exception 'TURNO_NON_DISPONIBILE_IN_QUESTO_GIORNO' using errcode = 'P0001';
  end if;

  if extract(isodow from p_reservation_date)::smallint = any (v_venue.closed_weekdays) then
    raise exception 'LOCALE_CHIUSO' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from venue_closures c
    where c.venue_id = v_venue.id and c.closed_date = p_reservation_date
  ) then
    raise exception 'LOCALE_CHIUSO' using errcode = 'P0001';
  end if;

  if p_party_size is null or p_party_size < 1 or p_party_size > 12 then
    raise exception 'COPERTI_NON_VALIDI' using errcode = 'P0001';
  end if;

  if coalesce(trim(p_first_name), '') = '' or coalesce(trim(p_last_name), '') = '' or coalesce(trim(p_phone), '') = '' then
    raise exception 'DATI_CLIENTE_INCOMPLETI' using errcode = 'P0001';
  end if;

  if coalesce(p_privacy_policy_accepted, false) is not true then
    raise exception 'PRIVACY_NON_ACCETTATA' using errcode = 'P0001';
  end if;

  insert into waitlist (
    venue_id, reservation_date, shift_id, party_size,
    customer_first_name, customer_last_name, customer_phone, notes, status,
    privacy_policy_accepted_at, marketing_consent_at
  ) values (
    v_venue.id, p_reservation_date, p_shift_id, p_party_size,
    trim(p_first_name), trim(p_last_name), trim(p_phone), nullif(trim(p_notes), ''), 'in_coda',
    now(), case when coalesce(p_marketing_consent, false) then now() else null end
  )
  returning * into v_wl;

  return query
  select
    v_wl.id,
    v_wl.reservation_date,
    v_shift.name,
    v_wl.party_size,
    (
      select count(*)::int
      from waitlist w
      where w.venue_id = v_wl.venue_id
        and w.reservation_date = v_wl.reservation_date
        and w.shift_id = v_wl.shift_id
        and w.status = 'in_coda'
        and w.created_at <= v_wl.created_at
    );
end;
$$;

grant execute on function join_waitlist(text, date, uuid, int, text, text, text, text, boolean, boolean) to anon, authenticated;

create or replace function _promote_waitlist_entry(p_waitlist_id uuid)
returns table (
  reservation_id uuid,
  first_name     text,
  last_name      text,
  party_size     int,
  table_code     text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wl    waitlist%rowtype;
  v_table uuid;
  v_res   reservations%rowtype;
begin
  select * into v_wl from waitlist where id = p_waitlist_id for update;
  if not found then
    raise exception 'VOCE_NON_TROVATA' using errcode = 'P0001';
  end if;
  if v_wl.status <> 'in_coda' then
    raise exception 'VOCE_NON_IN_CODA' using errcode = 'P0001';
  end if;

  v_table := suggest_table(v_wl.venue_id, v_wl.reservation_date, v_wl.shift_id, v_wl.party_size);

  insert into reservations (
    venue_id, reservation_date, shift_id, party_size,
    customer_first_name, customer_last_name, customer_phone, notes,
    status, source, table_id, privacy_policy_accepted_at, marketing_consent_at
  ) values (
    v_wl.venue_id, v_wl.reservation_date, v_wl.shift_id, v_wl.party_size,
    v_wl.customer_first_name, v_wl.customer_last_name, v_wl.customer_phone, v_wl.notes,
    'in_attesa', 'widget', v_table, v_wl.privacy_policy_accepted_at, v_wl.marketing_consent_at
  )
  returning * into v_res;

  update waitlist
    set status = 'promossa', promoted_reservation_id = v_res.id
    where id = v_wl.id;

  return query
  select
    v_res.id,
    v_wl.customer_first_name,
    v_wl.customer_last_name,
    v_wl.party_size,
    (select t.code from restaurant_tables t where t.id = v_table);
end;
$$;

revoke execute on function _promote_waitlist_entry(uuid) from public;
