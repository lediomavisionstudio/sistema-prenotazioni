-- Mini CRM clienti per il gestionale.
-- Additiva: non modifica il flusso prenotazioni o le RPC esistenti.

create table if not exists customer_profiles (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  identity_type text not null check (identity_type in ('email', 'phone')),
  identity_key text not null,
  first_name text,
  last_name text,
  email text,
  phone text,
  is_vip boolean not null default false,
  allergies text,
  notes text,
  birthday date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (venue_id, identity_type, identity_key)
);

create index if not exists customer_profiles_venue_name_idx
  on customer_profiles (venue_id, last_name, first_name);

alter table customer_profiles enable row level security;

drop policy if exists customer_profiles_select_staff on customer_profiles;
create policy customer_profiles_select_staff
  on customer_profiles for select
  to authenticated
  using (is_staff_of(venue_id));

drop policy if exists customer_profiles_write_staff on customer_profiles;
create policy customer_profiles_write_staff
  on customer_profiles for all
  to authenticated
  using (is_staff_of(venue_id))
  with check (is_staff_of(venue_id));

create or replace function set_customer_profiles_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists customer_profiles_updated_at_trg on customer_profiles;
create trigger customer_profiles_updated_at_trg
before update on customer_profiles
for each row execute function set_customer_profiles_updated_at();

comment on table customer_profiles is 'Profilo cliente CRM del gestionale, collegato a email o telefono e separato dal flusso prenotazioni.';
