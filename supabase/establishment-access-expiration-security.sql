-- Correctif post-migration : les fonctions de trigger ne sont jamais des RPC.
-- Les triggers PostgreSQL continuent de les exécuter avec ces privilèges retirés.
begin;

revoke all on function public.guard_establishment_access_fields()
  from public,anon,authenticated;
revoke all on function public.audit_establishment_access_change()
  from public,anon,authenticated;
revoke all on function public.enforce_establishment_business_write()
  from public,anon,authenticated;

commit;
