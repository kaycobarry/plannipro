-- Diagnostic PlanniPro en lecture seule. Ce fichier ne modifie aucune donnée.

select 'organizations' as table_name, count(*)::bigint as row_count from public.organizations
union all select 'establishments', count(*) from public.establishments
union all select 'employees', count(*) from public.employees
union all select 'organization_members', count(*) from public.organization_members
union all select 'business_records', count(*) from public.business_records where deleted_at is null
union all select 'time_clock_devices', count(*) from public.time_clock_devices
union all select 'time_clock_events', count(*) from public.time_clock_events
union all select 'documents', count(*) from public.documents
union all select 'document_versions', count(*) from public.document_versions
union all select 'planning_publications', count(*) from public.planning_publications
order by table_name;

select 'member_missing_organization' as check_name, count(*)::bigint as failures
from public.organization_members m left join public.organizations o on o.id = m.organization_id where o.id is null
union all select 'member_missing_employee', count(*)
from public.organization_members m left join public.employees e on e.id = m.employee_id
where m.employee_id is not null and e.id is null
union all select 'employee_missing_organization', count(*)
from public.employees e left join public.organizations o on o.id = e.organization_id where o.id is null
union all select 'employee_cross_tenant_establishment', count(*)
from public.employees e join public.establishments s on s.id = e.establishment_id
where e.organization_id <> s.organization_id
union all select 'business_record_duplicate_key', count(*)
from (
  select organization_id, record_type, legacy_id
  from public.business_records where deleted_at is null
  group by organization_id, record_type, legacy_id having count(*) > 1
) duplicates
union all select 'document_version_missing_document', count(*)
from public.document_versions v left join public.documents d on d.id = v.document_id where d.id is null
union all select 'clock_event_missing_device_or_employee', count(*)
from public.time_clock_events e
left join public.time_clock_devices d on d.id = e.device_id
left join public.employees p on p.id = e.employee_id
where d.id is null or p.id is null
order by check_name;
