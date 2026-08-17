-- Correctif post-migration : le trigger générique ne doit pas résoudre des
-- colonnes propres aux codes d'activation lorsqu'il s'exécute sur une autre table.
begin;

create or replace function public.enforce_establishment_business_write()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare v_org uuid; v_establishment uuid; v_old jsonb;
begin
  v_org := case when tg_op='DELETE' then old.organization_id else new.organization_id end;
  v_establishment := case when tg_op='DELETE' then old.establishment_id else new.establishment_id end;
  -- La purge interne des codes expirés reste possible sans rouvrir le magasin.
  if tg_table_name='time_clock_device_activation_codes' and tg_op='DELETE' then
    v_old := to_jsonb(old);
    if v_old->>'used_at' is null
       and (v_old->>'expires_at')::timestamptz < statement_timestamp() - interval '1 day' then
      return old;
    end if;
  end if;
  perform public.assert_establishment_business_access(v_org,v_establishment);
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.enforce_establishment_business_write()
  from public,anon,authenticated;

commit;
