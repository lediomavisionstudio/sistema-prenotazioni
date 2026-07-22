-- OneSignal Push Notifications
-- Additiva: nuove tabelle per subscription, campagne e log notifiche.
-- Non modifica prenotazioni, tavoli, menu o flussi esistenti.

create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  reservation_id uuid references reservations(id) on delete set null,
  waitlist_id uuid references waitlist(id) on delete set null,
  audience text not null default 'customer' check (audience in ('admin', 'customer')),
  external_id text,
  onesignal_id text,
  subscription_id text not null,
  customer_email text,
  customer_phone text,
  marketing_consent boolean not null default false,
  notification_permission text,
  browser text,
  device_label text,
  pwa_installed boolean not null default false,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (venue_id, subscription_id)
);

create index if not exists push_subscriptions_venue_audience_idx
  on push_subscriptions (venue_id, audience, last_seen_at desc);

create index if not exists push_subscriptions_reservation_idx
  on push_subscriptions (reservation_id)
  where reservation_id is not null;

create index if not exists push_subscriptions_waitlist_idx
  on push_subscriptions (waitlist_id)
  where waitlist_id is not null;

create table if not exists push_campaigns (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  title text not null,
  message text not null,
  image_url text,
  link_url text,
  audience text not null default 'all'
    check (audience in ('all', 'marketing', 'loyal', 'waitlist', 'admin')),
  scheduled_for timestamptz,
  sent_at timestamptz,
  status text not null default 'draft'
    check (status in ('draft', 'scheduled', 'sending', 'sent', 'failed')),
  delivered_count int not null default 0,
  opened_count int not null default 0,
  click_count int not null default 0,
  provider_response jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_campaigns_venue_created_idx
  on push_campaigns (venue_id, created_at desc);

create index if not exists push_campaigns_scheduled_idx
  on push_campaigns (status, scheduled_for)
  where scheduled_for is not null;

create table if not exists push_notification_logs (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  campaign_id uuid references push_campaigns(id) on delete set null,
  reservation_id uuid references reservations(id) on delete set null,
  waitlist_id uuid references waitlist(id) on delete set null,
  subscription_id text,
  kind text not null,
  title text not null,
  message text not null,
  audience text,
  provider text not null default 'onesignal',
  provider_notification_id text,
  status text not null default 'queued'
    check (status in ('queued', 'sent', 'failed', 'skipped')),
  delivered_count int not null default 0,
  opened_count int not null default 0,
  click_count int not null default 0,
  error text,
  provider_response jsonb,
  created_at timestamptz not null default now()
);

create index if not exists push_notification_logs_venue_created_idx
  on push_notification_logs (venue_id, created_at desc);

create or replace function set_push_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists push_subscriptions_updated_at_trg on push_subscriptions;
create trigger push_subscriptions_updated_at_trg
before update on push_subscriptions
for each row execute function set_push_updated_at();

drop trigger if exists push_campaigns_updated_at_trg on push_campaigns;
create trigger push_campaigns_updated_at_trg
before update on push_campaigns
for each row execute function set_push_updated_at();

alter table push_subscriptions enable row level security;
alter table push_campaigns enable row level security;
alter table push_notification_logs enable row level security;

drop policy if exists push_subscriptions_select_staff on push_subscriptions;
create policy push_subscriptions_select_staff
  on push_subscriptions for select
  to authenticated
  using (is_staff_of(venue_id));

drop policy if exists push_subscriptions_write_staff on push_subscriptions;
create policy push_subscriptions_write_staff
  on push_subscriptions for all
  to authenticated
  using (is_staff_of(venue_id))
  with check (is_staff_of(venue_id));

drop policy if exists push_campaigns_select_staff on push_campaigns;
create policy push_campaigns_select_staff
  on push_campaigns for select
  to authenticated
  using (is_staff_of(venue_id));

drop policy if exists push_campaigns_write_staff on push_campaigns;
create policy push_campaigns_write_staff
  on push_campaigns for all
  to authenticated
  using (is_staff_of(venue_id))
  with check (is_staff_of(venue_id));

drop policy if exists push_notification_logs_select_staff on push_notification_logs;
create policy push_notification_logs_select_staff
  on push_notification_logs for select
  to authenticated
  using (is_staff_of(venue_id));

drop policy if exists push_notification_logs_write_staff on push_notification_logs;
create policy push_notification_logs_write_staff
  on push_notification_logs for all
  to authenticated
  using (is_staff_of(venue_id))
  with check (is_staff_of(venue_id));

grant select, insert, update, delete on
  push_subscriptions,
  push_campaigns,
  push_notification_logs
to authenticated;

comment on table push_subscriptions is 'Associa browser/device OneSignal a locale, admin o cliente/prenotazione.';
comment on table push_campaigns is 'Campagne push manuali o programmate dal gestionale.';
comment on table push_notification_logs is 'Log invii push OneSignal automatici e manuali.';
