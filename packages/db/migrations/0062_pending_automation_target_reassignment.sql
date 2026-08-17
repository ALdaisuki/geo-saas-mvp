CREATE OR REPLACE FUNCTION geo.reassign_pending_automation_target(
  p_run_id uuid,
  p_target_id uuid,
  p_channel_account_id uuid
)
RETURNS TABLE (channel_account_id uuid, was_changed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  request_value text := NULLIF(current_setting('app.request_id', true), '');
  run_row record;
  target_row geo.automation_run_targets%ROWTYPE;
  account_row record;
  existing_count integer;
  quota_date date;
  before_hash_value text;
  after_hash_value text;
BEGIN
  IF p_run_id IS NULL OR p_target_id IS NULL OR p_channel_account_id IS NULL THEN
    RAISE EXCEPTION 'run, target, and channel account are required' USING ERRCODE = '22023';
  END IF;

  SELECT run.id, run.state, run.attempt_count, run.lease_owner, run.lease_expires_at,
         run.content_item_id, run.content_version_id, run.available_at,
         batch.execution_level
  INTO run_row
  FROM geo.automation_runs AS run
  JOIN geo.automation_batches AS batch
    ON batch.tenant_id = run.tenant_id AND batch.id = run.batch_id
  WHERE run.tenant_id = tenant_value
    AND run.id = p_run_id
  FOR UPDATE OF run;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'automation run was not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT *
  INTO target_row
  FROM geo.automation_run_targets AS target
  WHERE target.tenant_id = tenant_value
    AND target.id = p_target_id
    AND target.run_id = p_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'automation target was not found' USING ERRCODE = 'P0002';
  END IF;

  IF run_row.state <> 'scheduled'
     OR run_row.attempt_count <> 0
     OR run_row.lease_owner IS NOT NULL
     OR run_row.lease_expires_at IS NOT NULL
     OR run_row.content_item_id IS NOT NULL
     OR run_row.content_version_id IS NOT NULL
     OR target_row.state <> 'pending'
     OR target_row.variant_id IS NOT NULL
     OR target_row.audit_run_id IS NOT NULL
     OR target_row.audit_artifact_id IS NOT NULL
     OR target_row.publication_job_id IS NOT NULL THEN
    RAISE EXCEPTION 'automation target assignment is immutable after the run is claimed'
      USING ERRCODE = '55000';
  END IF;

  SELECT account.id, account.platform, account.status, account.supported_execution_levels,
         account.daily_publish_quota, account.quota_timezone,
         runtime.session_state AS ctrip_runtime_session_state,
         control.mode AS account_control_mode,
         control.kill_switch_enabled AS account_kill_switch_enabled
  INTO account_row
  FROM geo.channel_accounts AS account
  LEFT JOIN geo.ctrip_account_runtime_bindings AS runtime
    ON runtime.tenant_id = account.tenant_id
   AND runtime.channel_account_id = account.id
  LEFT JOIN geo.automation_controls AS control
    ON control.tenant_id = account.tenant_id
   AND control.scope_type = 'account'
   AND control.scope_key = account.id::text
  WHERE account.tenant_id = tenant_value
    AND account.id = p_channel_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'channel account was not found' USING ERRCODE = 'P0002';
  END IF;

  IF account_row.platform <> target_row.platform
     OR account_row.status <> 'active'
     OR NOT (run_row.execution_level = ANY(account_row.supported_execution_levels))
     OR account_row.account_control_mode IS NULL
     OR account_row.account_kill_switch_enabled
     OR account_row.account_control_mode IN ('paused', 'stopped') THEN
    RAISE EXCEPTION 'channel account is not eligible for this automation target'
      USING ERRCODE = '55000';
  END IF;

  IF run_row.execution_level = 'unattended'
     AND (
       account_row.platform <> 'ctrip_community'
       OR account_row.account_control_mode <> 'unattended'
       OR account_row.ctrip_runtime_session_state NOT IN ('authenticated', 'ready')
     ) THEN
    RAISE EXCEPTION 'unattended automation requires an authenticated unattended Ctrip account'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM geo.circuit_breakers AS breaker
    WHERE breaker.tenant_id = tenant_value
      AND breaker.scope_type = 'account'
      AND breaker.scope_key = p_channel_account_id::text
      AND breaker.state IN ('open', 'half_open')
  ) THEN
    RAISE EXCEPTION 'channel account circuit breaker blocks assignment' USING ERRCODE = '55000';
  END IF;

  IF target_row.channel_account_id = p_channel_account_id THEN
    RETURN QUERY SELECT p_channel_account_id, false;
    RETURN;
  END IF;

  IF run_row.execution_level <> 'dry_run' THEN
    quota_date := (run_row.available_at AT TIME ZONE account_row.quota_timezone)::date;
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        tenant_value::text || ':channel-account-daily-quota:' ||
        p_channel_account_id::text || ':' || quota_date::text,
        0
      )
    );

    SELECT count(*)::integer
    INTO existing_count
    FROM geo.automation_run_targets AS target
    JOIN geo.automation_runs AS run
      ON run.tenant_id = target.tenant_id AND run.id = target.run_id
    JOIN geo.automation_batches AS batch
      ON batch.tenant_id = run.tenant_id AND batch.id = run.batch_id
    WHERE target.tenant_id = tenant_value
      AND target.channel_account_id = p_channel_account_id
      AND target.id <> p_target_id
      AND target.state <> 'cancelled'
      AND run.state <> 'cancelled'
      AND batch.state <> 'cancelled'
      AND batch.execution_level <> 'dry_run'
      AND (run.available_at AT TIME ZONE account_row.quota_timezone)::date = quota_date;

    IF existing_count + 1 > account_row.daily_publish_quota THEN
      RAISE EXCEPTION 'channel account daily publication quota would be exceeded'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  before_hash_value := encode(public.digest(target_row.channel_account_id::text, 'sha256'), 'hex');
  after_hash_value := encode(public.digest(p_channel_account_id::text, 'sha256'), 'hex');

  UPDATE geo.automation_run_targets AS target
  SET channel_account_id = p_channel_account_id
  WHERE target.tenant_id = tenant_value
    AND target.id = p_target_id
    AND target.run_id = p_run_id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, before_hash, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'automation_target.assignment_changed',
    'automation_run_target', p_target_id,
    COALESCE(request_value, 'assignment:' || p_target_id::text),
    before_hash_value, after_hash_value,
    jsonb_build_object(
      'runId', p_run_id,
      'previousChannelAccountId', target_row.channel_account_id,
      'channelAccountId', p_channel_account_id,
      'platform', target_row.platform
    )
  );

  RETURN QUERY SELECT p_channel_account_id, true;
END
$$;

REVOKE ALL ON FUNCTION geo.reassign_pending_automation_target(uuid, uuid, uuid)
  FROM PUBLIC, geo_dispatcher;
GRANT EXECUTE ON FUNCTION geo.reassign_pending_automation_target(uuid, uuid, uuid)
  TO geo_runtime;

REVOKE UPDATE ON TABLE geo.automation_run_targets FROM geo_runtime;
