-- Sistema notifiche prenotazioni.
--
-- Nessun token provider viene salvato nel database. Le API key restano nei
-- Supabase Secrets usati dalle Edge Functions.

alter table venues
  add column if not exists notification_admin_email text,
  add column if not exists admin_booking_email_enabled boolean not null default true,
  add column if not exists customer_email_enabled boolean not null default false,
  add column if not exists whatsapp_reminder_enabled boolean not null default false,
  add column if not exists email_provider text not null default 'resend'
    check (email_provider in ('resend')),
  add column if not exists whatsapp_provider text not null default 'none'
    check (whatsapp_provider in ('none', 'meta', 'twilio'));

comment on column venues.notification_admin_email is 'Email destinataria notifiche admin. NULL = primo utente staff/owner del gestionale.';
comment on column venues.admin_booking_email_enabled is 'Abilita email automatica admin per nuove prenotazioni pubbliche.';
comment on column venues.customer_email_enabled is 'Predisposizione email cliente; disattiva in questa versione.';
comment on column venues.whatsapp_reminder_enabled is 'Predisposizione reminder WhatsApp; disattiva finche provider ufficiale non configurato.';

alter table reservations
  add column if not exists customer_email text,
  add column if not exists admin_notification_sent_at timestamptz,
  add column if not exists admin_notification_error text,
  add column if not exists customer_email_sent_at timestamptz,
  add column if not exists customer_email_error text,
  add column if not exists whatsapp_reminder_scheduled_at timestamptz,
  add column if not exists whatsapp_reminder_sent_at timestamptz,
  add column if not exists whatsapp_reminder_error text;

create table if not exists notification_logs (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid references venues(id) on delete cascade,
  reservation_id uuid references reservations(id) on delete cascade,
  waitlist_id    uuid references waitlist(id) on delete cascade,
  channel        text not null check (channel in ('email', 'whatsapp')),
  kind           text not null,
  recipient      text,
  provider       text,
  status         text not null check (status in ('pending', 'sent', 'skipped', 'failed')),
  error_message  text,
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists notification_logs_venue_created_idx
  on notification_logs (venue_id, created_at desc);

create index if not exists notification_logs_reservation_idx
  on notification_logs (reservation_id, kind, created_at desc);

alter table notification_logs enable row level security;

create policy notification_logs_select_staff
  on notification_logs for select
  to authenticated
  using (venue_id is not null and is_staff_of(venue_id));

-- Nessuna policy insert/update/delete: i log sono scritti dalle Edge Functions
-- con service role, cosi il frontend pubblico non puo' falsificarli.
