begin;

-- A badge is a normal Pointeuse action, not a manual attendance correction.
-- The summary builder is not exposed to browser roles. It marks only its own
-- upsert so the generic correction trigger can distinguish this trusted write.
create or replace function public.rebuild_time_clock_day_summary(
  p_organization_id uuid,
  p_establishment_id uuid,
  p_employee_id uuid,
  p_work_date date,
  p_timezone text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee public.employees%rowtype;
  v_event record;
  v_in timestamptz;
  v_out timestamptz;
  v_break_started timestamptz;
  v_pause_seconds numeric := 0;
  v_pause_minutes integer := 0;
  v_duration numeric := 0;
  v_event_count integer := 0;
  v_legacy_id text;
  v_existing_payload jsonb;
  v_payload jsonb;
begin
  select * into v_employee
  from public.employees
  where id = p_employee_id and organization_id = p_organization_id;
  if not found then raise exception 'Employee not found'; end if;

  for v_event in
    select event_type, occurred_at
    from public.time_clock_events
    where organization_id = p_organization_id
      and establishment_id = p_establishment_id
      and employee_id = p_employee_id
      and (occurred_at at time zone p_timezone)::date = p_work_date
    order by occurred_at, received_at, id
  loop
    v_event_count := v_event_count + 1;
    if v_event.event_type = 'clock_in' and v_in is null then
      v_in := v_event.occurred_at;
    elsif v_event.event_type = 'break_start' and v_in is not null and v_break_started is null then
      v_break_started := v_event.occurred_at;
    elsif v_event.event_type = 'break_end' and v_break_started is not null then
      v_pause_seconds := v_pause_seconds + greatest(0, extract(epoch from v_event.occurred_at - v_break_started));
      v_break_started := null;
    elsif v_event.event_type = 'clock_out' and v_in is not null then
      if v_break_started is not null then
        v_pause_seconds := v_pause_seconds + greatest(0, extract(epoch from v_event.occurred_at - v_break_started));
        v_break_started := null;
      end if;
      v_out := v_event.occurred_at;
    end if;
  end loop;

  v_pause_minutes := floor(v_pause_seconds / 60.0)::integer;
  if v_in is not null and v_out is not null then
    v_duration := greatest(0, round((extract(epoch from v_out - v_in) / 3600.0 - v_pause_minutes / 60.0)::numeric, 2));
  end if;
  v_legacy_id := 'time-clock:' || coalesce(v_employee.legacy_id, v_employee.id::text) || ':' || p_work_date::text;
  select payload into v_existing_payload
  from public.business_records
  where organization_id = p_organization_id and record_type = 'punch' and legacy_id = v_legacy_id
  limit 1;

  v_payload := jsonb_build_object(
    'id', v_legacy_id,
    'empId', coalesce(v_employee.legacy_id, v_employee.id::text),
    'date', p_work_date::text,
    'in', case when v_in is null then '' else to_char(v_in at time zone p_timezone, 'HH24:MI') end,
    'out', case when v_out is null then '' else to_char(v_out at time zone p_timezone, 'HH24:MI') end,
    'pauseMin', v_pause_minutes,
    'dur', v_duration,
    'source', 'external-time-clock',
    'rawIn', case when v_in is null then '' else to_char(v_in at time zone p_timezone, 'HH24:MI') end,
    'rawOut', case when v_out is null then '' else to_char(v_out at time zone p_timezone, 'HH24:MI') end,
    'rawPauseMin', v_pause_minutes,
    'rawEventCount', v_event_count,
    'updatedAt', now()
  );
  if v_existing_payload ? 'adjustment' then
    v_payload := v_payload || jsonb_build_object('adjustment', v_existing_payload -> 'adjustment');
  end if;

  perform set_config('app.plannipro_time_clock_rebuild', 'on', true);
  insert into public.business_records (
    organization_id, establishment_id, employee_id, record_type, legacy_id, payload, deleted_at
  ) values (
    p_organization_id, p_establishment_id, p_employee_id, 'punch', v_legacy_id, v_payload, null
  )
  on conflict (organization_id, record_type, legacy_id) do update set
    establishment_id = excluded.establishment_id,
    employee_id = excluded.employee_id,
    payload = excluded.payload,
    deleted_at = null;
  perform set_config('app.plannipro_time_clock_rebuild', 'off', true);

  return v_payload;
end;
$$;

revoke all on function public.rebuild_time_clock_day_summary(uuid, uuid, uuid, date, text)
  from public, anon, authenticated;

drop trigger if exists business_records_enforce_permission on public.business_records;
create trigger business_records_enforce_permission
  before update on public.business_records
  for each row
  when (not (
    coalesce(current_setting('app.plannipro_time_clock_rebuild', true), 'off') = 'on'
    and old.record_type = 'punch'
    and new.record_type = 'punch'
    and old.payload->>'source' = 'external-time-clock'
    and new.payload->>'source' = 'external-time-clock'
  ))
  execute function public.enforce_business_record_permission();

commit;
