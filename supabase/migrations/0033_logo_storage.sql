-- Bucket pubblico per i loghi dei locali.
-- Additivo: non modifica dati o tabelle applicative esistenti.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'logos',
  'logos',
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
      and policyname = 'logos_select_public'
  ) then
    create policy logos_select_public
      on storage.objects for select
      using (bucket_id = 'logos');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'logos_insert_owner'
  ) then
    create policy logos_insert_owner
      on storage.objects for insert
      with check (
        bucket_id = 'logos'
        and name ~ '^[0-9a-fA-F-]{36}/'
        and public.is_owner_of(((storage.foldername(name))[1])::uuid)
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'logos_update_owner'
  ) then
    create policy logos_update_owner
      on storage.objects for update
      using (
        bucket_id = 'logos'
        and name ~ '^[0-9a-fA-F-]{36}/'
        and public.is_owner_of(((storage.foldername(name))[1])::uuid)
      )
      with check (
        bucket_id = 'logos'
        and name ~ '^[0-9a-fA-F-]{36}/'
        and public.is_owner_of(((storage.foldername(name))[1])::uuid)
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'logos_delete_owner'
  ) then
    create policy logos_delete_owner
      on storage.objects for delete
      using (
        bucket_id = 'logos'
        and name ~ '^[0-9a-fA-F-]{36}/'
        and public.is_owner_of(((storage.foldername(name))[1])::uuid)
      );
  end if;
end $$;
