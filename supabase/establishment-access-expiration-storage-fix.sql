-- Ferme l'accès Supabase Storage dès qu'un établissement est expiré,
-- suspendu ou pas encore actif. Cette politique est restrictive : elle ne
-- remplace pas les autorisations existantes du Coffre-fort RH, elle ajoute une
-- barrière obligatoire indépendante.
begin;

create schema if not exists plannipro_private;

drop policy if exists plannipro_documents_establishment_access_gate on storage.objects;

create or replace function plannipro_private.storage_object_establishment_access_allowed(p_path text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
  v_establishment_id uuid;
begin
  if p_path is null or array_length(string_to_array(p_path, '/'), 1) < 2 then
    return false;
  end if;

  v_organization_id := split_part(p_path, '/', 1)::uuid;
  v_establishment_id := split_part(p_path, '/', 2)::uuid;

  return public.establishment_business_access_allowed(
    v_organization_id,
    v_establishment_id
  );
exception
  when invalid_text_representation then return false;
end;
$$;

revoke all on function plannipro_private.storage_object_establishment_access_allowed(text)
from public, anon, authenticated;
grant usage on schema plannipro_private to authenticated;
grant execute on function plannipro_private.storage_object_establishment_access_allowed(text)
to authenticated;

create policy plannipro_documents_establishment_access_gate
on storage.objects
as restrictive
for all
to authenticated
using (
  bucket_id <> 'plannipro-documents'
  or plannipro_private.storage_object_establishment_access_allowed(name)
)
with check (
  bucket_id <> 'plannipro-documents'
  or plannipro_private.storage_object_establishment_access_allowed(name)
);

drop function if exists public.storage_object_establishment_access_allowed(text);

commit;
