-- Re-open one failed audit target as a fresh target-level remediation without
-- touching confirmed or in-flight publication work.
BEGIN;

CREATE OR REPLACE FUNCTION geo.restart_automation_target_for_remediation(
  p_run_id uuid,
  p_target_id uuid,
  p_remediation jsonb
)
RETURNS TABLE (
  automation_run_id uuid,
  run_state text,
  batch_state text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  run_row geo.automation_runs%ROWTYPE;
  target_row geo.automation_run_targets%ROWTYPE;
  refreshed_batch_state text;
BEGIN
  PERFORM geo.require_actor_id();
  IF p_remediation IS NULL OR jsonb_typeof(p_remediation) <> 'object' THEN
    RAISE EXCEPTION 'manual remediation plan must be an object' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(hashtextextended('automation:' || tenant_value::text, 0));

  SELECT * INTO run_row
  FROM geo.automation_runs AS run
  WHERE run.tenant_id = tenant_value AND run.id = p_run_id
  FOR UPDATE;
  IF run_row.id IS NULL THEN
    RAISE EXCEPTION 'automation run was not found' USING ERRCODE = 'P0002';
  END IF;
  IF run_row.lease_owner IS NOT NULL OR run_row.state = 'running' THEN
    RAISE EXCEPTION 'automation run is currently leased' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO target_row
  FROM geo.automation_run_targets AS target
  WHERE target.tenant_id = tenant_value
    AND target.id = p_target_id
    AND target.run_id = p_run_id
  FOR UPDATE;
  IF target_row.id IS NULL THEN
    RAISE EXCEPTION 'automation target was not found for the run' USING ERRCODE = 'P0002';
  END IF;
  IF target_row.state NOT IN ('awaiting_manual_review', 'audit_failed', 'blocked')
     OR target_row.audit_artifact_id IS NULL
     OR target_row.publication_job_id IS NOT NULL THEN
    RAISE EXCEPTION 'automation target is not eligible for manual remediation' USING ERRCODE = '55000';
  END IF;

  UPDATE geo.automation_run_targets AS target
  SET state = 'pending',
      variant_id = NULL,
      audit_run_id = NULL,
      audit_artifact_id = NULL,
      publication_job_id = NULL,
      remediation = p_remediation,
      completed_at = NULL,
      last_error_code = NULL,
      last_error_message = NULL,
      updated_at = clock_timestamp()
  WHERE target.tenant_id = tenant_value AND target.id = p_target_id;

  UPDATE geo.automation_runs AS run
  SET state = 'scheduled',
      stage = 'targets',
      available_at = clock_timestamp(),
      lease_owner = NULL,
      lease_expires_at = NULL,
      heartbeat_at = NULL,
      completed_at = NULL,
      last_error_code = NULL,
      last_error_message = NULL,
      updated_at = clock_timestamp()
  WHERE run.tenant_id = tenant_value AND run.id = p_run_id;

  refreshed_batch_state := geo.refresh_automation_batch_state(run_row.batch_id);
  RETURN QUERY SELECT p_run_id, 'scheduled'::text, refreshed_batch_state;
END
$$;

REVOKE ALL ON FUNCTION geo.restart_automation_target_for_remediation(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.restart_automation_target_for_remediation(uuid, uuid, jsonb)
  TO geo_runtime;

DO $verify$
BEGIN
  IF NOT has_function_privilege(
    'geo_runtime',
    'geo.restart_automation_target_for_remediation(uuid,uuid,jsonb)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'automation target remediation restart ACL grant was not installed';
  END IF;
END
$verify$;

COMMIT;
