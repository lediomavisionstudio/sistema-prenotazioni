-- Menu Digitale
-- Additivo: crea solo nuove tabelle, policy RLS e bucket Storage dedicato.
-- Non modifica tabelle esistenti, RPC, prenotazioni o dati gia' presenti.

-- ---------------------------------------------------------------------------
-- Tabelle
-- ---------------------------------------------------------------------------

create table if not exists menu_categories (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues(id) on delete cascade,
  sort_order  int not null default 0,
  is_visible  boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists menu_category_translations (
  id           uuid primary key default gen_random_uuid(),
  category_id  uuid not null references menu_categories(id) on delete cascade,
  language     text not null,
  name         text not null,
  unique (category_id, language),
  constraint menu_category_translations_language_check
    check (language ~ '^[a-z]{2}(-[A-Z]{2})?$')
);

create table if not exists menu_items (
  id          uuid primary key default gen_random_uuid(),
  category_id uuid not null references menu_categories(id) on delete cascade,
  price       numeric(10, 2),
  image_url   text,
  sort_order  int not null default 0,
  available   boolean not null default true,
  featured    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint menu_items_price_check check (price is null or price >= 0)
);

create table if not exists menu_item_translations (
  id           uuid primary key default gen_random_uuid(),
  item_id      uuid not null references menu_items(id) on delete cascade,
  language     text not null,
  name         text not null,
  description  text,
  unique (item_id, language),
  constraint menu_item_translations_language_check
    check (language ~ '^[a-z]{2}(-[A-Z]{2})?$')
);

create table if not exists menu_options (
  id       uuid primary key default gen_random_uuid(),
  item_id  uuid not null references menu_items(id) on delete cascade,
  name     text not null,
  price    numeric(10, 2),
  constraint menu_options_price_check check (price is null or price >= 0)
);

create table if not exists menu_settings (
  venue_id             uuid primary key references venues(id) on delete cascade,
  default_language     text not null default 'it',
  secondary_language   text default 'en',
  show_prices          boolean not null default true,
  show_images          boolean not null default true,
  currency             text not null default 'EUR',
  cover_image          text,
  updated_at           timestamptz not null default now(),
  constraint menu_settings_default_language_check
    check (default_language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  constraint menu_settings_secondary_language_check
    check (secondary_language is null or secondary_language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  constraint menu_settings_currency_check
    check (currency ~ '^[A-Z]{3}$')
);

comment on table menu_categories is 'Categorie del menu digitale di un locale.';
comment on table menu_category_translations is 'Traduzioni delle categorie del menu digitale.';
comment on table menu_items is 'Piatti/prodotti del menu digitale.';
comment on table menu_item_translations is 'Traduzioni di nome e descrizione dei piatti/prodotti.';
comment on table menu_options is 'Opzioni o supplementi collegati a un elemento del menu.';
comment on table menu_settings is 'Impostazioni pubbliche del menu digitale di un locale.';

-- ---------------------------------------------------------------------------
-- Compatibilita' con bozze precedenti del modulo Menu
-- ---------------------------------------------------------------------------
-- Se il database remoto contiene gia' le tabelle Menu create da una bozza
-- incompleta, create table if not exists le salta. Allineiamo quindi in modo
-- additivo le sole colonne/vincoli necessari prima di creare indici e policy.

alter table menu_category_translations
  add column if not exists id uuid default gen_random_uuid();

update menu_category_translations
set id = gen_random_uuid()
where id is null;

alter table menu_category_translations
  alter column id set default gen_random_uuid(),
  alter column id set not null;

alter table menu_category_translations
  add column if not exists language text;

update menu_category_translations
set language = 'it'
where language is null;

alter table menu_category_translations
  alter column language set not null;

with ranked_category_translations as (
  select
    id,
    row_number() over (
      partition by category_id, language
      order by id
    ) as duplicate_rank
  from menu_category_translations
)
delete from menu_category_translations t
using ranked_category_translations r
where t.id = r.id
  and r.duplicate_rank > 1;

alter table menu_item_translations
  add column if not exists id uuid default gen_random_uuid();

update menu_item_translations
set id = gen_random_uuid()
where id is null;

alter table menu_item_translations
  alter column id set default gen_random_uuid(),
  alter column id set not null;

alter table menu_item_translations
  add column if not exists language text;

update menu_item_translations
set language = 'it'
where language is null;

alter table menu_item_translations
  alter column language set not null;

with ranked_item_translations as (
  select
    id,
    row_number() over (
      partition by item_id, language
      order by id
    ) as duplicate_rank
  from menu_item_translations
)
delete from menu_item_translations t
using ranked_item_translations r
where t.id = r.id
  and r.duplicate_rank > 1;

alter table menu_options
  add column if not exists id uuid default gen_random_uuid();

update menu_options
set id = gen_random_uuid()
where id is null;

alter table menu_options
  alter column id set default gen_random_uuid(),
  alter column id set not null;

alter table menu_settings
  add column if not exists default_language text not null default 'it',
  add column if not exists secondary_language text default 'en',
  add column if not exists show_prices boolean not null default true,
  add column if not exists show_images boolean not null default true,
  add column if not exists currency text not null default 'EUR',
  add column if not exists cover_image text,
  add column if not exists updated_at timestamptz not null default now();

alter table menu_category_translations
  drop constraint if exists menu_category_translations_category_id_key;

alter table menu_item_translations
  drop constraint if exists menu_item_translations_item_id_key;

do $$
begin
  if not exists (
    select 1
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    where c.oid = 'menu_category_translations'::regclass
      and i.indisprimary
  ) then
    alter table menu_category_translations
      add constraint menu_category_translations_pkey
      primary key (id);
  end if;

  if not exists (
    select 1
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    where c.oid = 'menu_item_translations'::regclass
      and i.indisprimary
  ) then
    alter table menu_item_translations
      add constraint menu_item_translations_pkey
      primary key (id);
  end if;

  if not exists (
    select 1
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    where c.oid = 'menu_options'::regclass
      and i.indisprimary
  ) then
    alter table menu_options
      add constraint menu_options_pkey
      primary key (id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'menu_category_translations_category_id_language_key'
      and conrelid = 'menu_category_translations'::regclass
  ) then
    alter table menu_category_translations
      add constraint menu_category_translations_category_id_language_key
      unique (category_id, language);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'menu_item_translations_item_id_language_key'
      and conrelid = 'menu_item_translations'::regclass
  ) then
    alter table menu_item_translations
      add constraint menu_item_translations_item_id_language_key
      unique (item_id, language);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'menu_category_translations_language_check'
      and conrelid = 'menu_category_translations'::regclass
  ) then
    alter table menu_category_translations
      add constraint menu_category_translations_language_check
      check (language ~ '^[a-z]{2}(-[A-Z]{2})?$');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'menu_item_translations_language_check'
      and conrelid = 'menu_item_translations'::regclass
  ) then
    alter table menu_item_translations
      add constraint menu_item_translations_language_check
      check (language ~ '^[a-z]{2}(-[A-Z]{2})?$');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'menu_settings_default_language_check'
      and conrelid = 'menu_settings'::regclass
  ) then
    alter table menu_settings
      add constraint menu_settings_default_language_check
      check (default_language ~ '^[a-z]{2}(-[A-Z]{2})?$');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'menu_settings_secondary_language_check'
      and conrelid = 'menu_settings'::regclass
  ) then
    alter table menu_settings
      add constraint menu_settings_secondary_language_check
      check (secondary_language is null or secondary_language ~ '^[a-z]{2}(-[A-Z]{2})?$');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'menu_settings_currency_check'
      and conrelid = 'menu_settings'::regclass
  ) then
    alter table menu_settings
      add constraint menu_settings_currency_check
      check (currency ~ '^[A-Z]{3}$');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Indici
-- ---------------------------------------------------------------------------

create index if not exists menu_categories_venue_sort_idx
  on menu_categories (venue_id, sort_order, created_at);

create index if not exists menu_category_translations_category_language_idx
  on menu_category_translations (category_id, language);

create index if not exists menu_items_category_sort_idx
  on menu_items (category_id, sort_order, created_at);

create index if not exists menu_item_translations_item_language_idx
  on menu_item_translations (item_id, language);

create index if not exists menu_options_item_idx
  on menu_options (item_id);

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

drop trigger if exists menu_categories_set_updated_at on menu_categories;
create trigger menu_categories_set_updated_at
  before update on menu_categories
  for each row execute function set_updated_at();

drop trigger if exists menu_items_set_updated_at on menu_items;
create trigger menu_items_set_updated_at
  before update on menu_items
  for each row execute function set_updated_at();

drop trigger if exists menu_settings_set_updated_at on menu_settings;
create trigger menu_settings_set_updated_at
  before update on menu_settings
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table menu_categories enable row level security;
alter table menu_category_translations enable row level security;
alter table menu_items enable row level security;
alter table menu_item_translations enable row level security;
alter table menu_options enable row level security;
alter table menu_settings enable row level security;

create policy menu_categories_select_public_or_staff
  on menu_categories for select
  to anon, authenticated
  using (
    (
      is_visible
      and exists (select 1 from venues v where v.id = venue_id and v.active)
    )
    or is_staff_of(venue_id)
  );

create policy menu_categories_write_owner
  on menu_categories for all
  to authenticated
  using (is_owner_of(venue_id))
  with check (is_owner_of(venue_id));

create policy menu_category_translations_select_public_or_staff
  on menu_category_translations for select
  to anon, authenticated
  using (
    exists (
      select 1
      from menu_categories c
      join venues v on v.id = c.venue_id
      where c.id = category_id
        and ((c.is_visible and v.active) or is_staff_of(c.venue_id))
    )
  );

create policy menu_category_translations_write_owner
  on menu_category_translations for all
  to authenticated
  using (
    exists (
      select 1 from menu_categories c
      where c.id = category_id and is_owner_of(c.venue_id)
    )
  )
  with check (
    exists (
      select 1 from menu_categories c
      where c.id = category_id and is_owner_of(c.venue_id)
    )
  );

create policy menu_items_select_public_or_staff
  on menu_items for select
  to anon, authenticated
  using (
    exists (
      select 1
      from menu_categories c
      join venues v on v.id = c.venue_id
      where c.id = category_id
        and (((available and c.is_visible) and v.active) or is_staff_of(c.venue_id))
    )
  );

create policy menu_items_write_owner
  on menu_items for all
  to authenticated
  using (
    exists (
      select 1 from menu_categories c
      where c.id = category_id and is_owner_of(c.venue_id)
    )
  )
  with check (
    exists (
      select 1 from menu_categories c
      where c.id = category_id and is_owner_of(c.venue_id)
    )
  );

create policy menu_item_translations_select_public_or_staff
  on menu_item_translations for select
  to anon, authenticated
  using (
    exists (
      select 1
      from menu_items i
      join menu_categories c on c.id = i.category_id
      join venues v on v.id = c.venue_id
      where i.id = item_id
        and (((i.available and c.is_visible) and v.active) or is_staff_of(c.venue_id))
    )
  );

create policy menu_item_translations_write_owner
  on menu_item_translations for all
  to authenticated
  using (
    exists (
      select 1
      from menu_items i
      join menu_categories c on c.id = i.category_id
      where i.id = item_id and is_owner_of(c.venue_id)
    )
  )
  with check (
    exists (
      select 1
      from menu_items i
      join menu_categories c on c.id = i.category_id
      where i.id = item_id and is_owner_of(c.venue_id)
    )
  );

create policy menu_options_select_public_or_staff
  on menu_options for select
  to anon, authenticated
  using (
    exists (
      select 1
      from menu_items i
      join menu_categories c on c.id = i.category_id
      join venues v on v.id = c.venue_id
      where i.id = item_id
        and (((i.available and c.is_visible) and v.active) or is_staff_of(c.venue_id))
    )
  );

create policy menu_options_write_owner
  on menu_options for all
  to authenticated
  using (
    exists (
      select 1
      from menu_items i
      join menu_categories c on c.id = i.category_id
      where i.id = item_id and is_owner_of(c.venue_id)
    )
  )
  with check (
    exists (
      select 1
      from menu_items i
      join menu_categories c on c.id = i.category_id
      where i.id = item_id and is_owner_of(c.venue_id)
    )
  );

create policy menu_settings_select_public_or_staff
  on menu_settings for select
  to anon, authenticated
  using (
    exists (select 1 from venues v where v.id = venue_id and v.active)
    or is_staff_of(venue_id)
  );

create policy menu_settings_write_owner
  on menu_settings for all
  to authenticated
  using (is_owner_of(venue_id))
  with check (is_owner_of(venue_id));

-- Data API: nei progetti Supabase recenti le nuove tabelle potrebbero non
-- essere esposte automaticamente. I GRANT rendono le tabelle raggiungibili;
-- RLS continua a governare le righe accessibili.
grant select on
  menu_categories,
  menu_category_translations,
  menu_items,
  menu_item_translations,
  menu_options,
  menu_settings
to anon, authenticated;

grant insert, update, delete on
  menu_categories,
  menu_category_translations,
  menu_items,
  menu_item_translations,
  menu_options,
  menu_settings
to authenticated;

-- ---------------------------------------------------------------------------
-- Storage immagini menu
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'menu-images',
  'menu-images',
  true,
  5242880,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'menu_images_select_public'
  ) then
    create policy menu_images_select_public
      on storage.objects for select
      using (bucket_id = 'menu-images');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'menu_images_insert_owner'
  ) then
    create policy menu_images_insert_owner
      on storage.objects for insert
      with check (
        bucket_id = 'menu-images'
        and name ~ '^[0-9a-fA-F-]{36}/'
        and public.is_owner_of(((storage.foldername(name))[1])::uuid)
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'menu_images_update_owner'
  ) then
    create policy menu_images_update_owner
      on storage.objects for update
      using (
        bucket_id = 'menu-images'
        and name ~ '^[0-9a-fA-F-]{36}/'
        and public.is_owner_of(((storage.foldername(name))[1])::uuid)
      )
      with check (
        bucket_id = 'menu-images'
        and name ~ '^[0-9a-fA-F-]{36}/'
        and public.is_owner_of(((storage.foldername(name))[1])::uuid)
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'menu_images_delete_owner'
  ) then
    create policy menu_images_delete_owner
      on storage.objects for delete
      using (
        bucket_id = 'menu-images'
        and name ~ '^[0-9a-fA-F-]{36}/'
        and public.is_owner_of(((storage.foldername(name))[1])::uuid)
      );
  end if;
end $$;
