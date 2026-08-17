BEGIN;

-- 0114 broadened every non-confirmed publication job to a blocked target.
-- That conflates an operator decision point (needs_review) with a real
-- delivery failure (permanent_failure). Restore the distinction: only
-- needs_review maps to blocked/AUTOMATION_GATE_BLOCKED; permanent_failure
-- keeps the delivery_failed semantics while still counting blocked targets
-- for run-level terminal state.
CREATE OR REPLACE FUNCTION geo.sync_automation_target_from_publication_job()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  affected_run_ids uuid[];
  updated_run_count integer;
  failure_code text := COALESCE(
    NULLIF(trim(NEW.last_error_code), ''),
    'AUTOMATION_PUBLICATION_' || upper(NEW.state)
  );
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state
     OR NEW.state NOT IN ('confirmed', 'needs_review', 'permanent_failure') THEN
    RETURN NEW;
  END IF;

  WITH updated_targets AS (
    UPDATE geo.automation_run_targets AS target
    SET state = CASE
          WHEN NEW.state = 'confirmed' THEN 'confirmed'
          WHEN NEW.state = 'needs_review' THEN 'blocked'
          ELSE 'delivery_failed'
        END,
        last_error_code = CASE WHEN NEW.state = 'confirmed' THEN NULL ELSE failure_code END,
        last_error_message = CASE WHEN NEW.state = 'confirmed' THEN NULL ELSE left(failure_code, 4000) END,
        completed_at = COALESCE(
          target.completed_at,
          CASE WHEN NEW.state = 'confirmed' THEN COALESCE(NEW.confirmed_at, clock_timestamp())
               ELSE clock_timestamp() END
        )
    WHERE target.tenant_id = NEW.tenant_id
      AND target.publication_job_id = NEW.id
      AND (
        (NEW.state = 'confirmed' AND target.state IN ('awaiting_delivery', 'submitted_pending_review'))
        OR (NEW.state <> 'confirmed' AND target.state = 'awaiting_delivery')
      )
    RETURNING target.run_id
  )
  SELECT array_agg(DISTINCT updated_targets.run_id)
  INTO affected_run_ids
  FROM updated_targets;

  IF affected_run_ids IS NULL THEN
    RETURN NEW;
  END IF;

  WITH run_counts AS (
    SELECT run.id,
           run.batch_id,
           count(*)::integer AS target_count,
           count(*) FILTER (WHERE target.state IN ('pending', 'variant_ready', 'awaiting_delivery'))::integer AS active_count,
           count(*) FILTER (WHERE target.state IN ('preview_completed', 'confirmed'))::integer AS success_count,
           count(*) FILTER (WHERE target.state IN ('audit_failed', 'blocked', 'failed', 'delivery_failed', 'cancelled'))::integer AS failure_count,
           count(*) FILTER (WHERE target.state = 'blocked')::integer AS blocked_count,
           count(*) FILTER (WHERE target.state = 'delivery_failed')::integer AS delivery_failure_count
    FROM geo.automation_runs AS run
    JOIN geo.automation_run_targets AS target
      ON target.tenant_id = run.tenant_id
     AND target.run_id = run.id
    WHERE run.tenant_id = NEW.tenant_id
      AND run.id = ANY(affected_run_ids)
    GROUP BY run.id, run.batch_id
  ), terminal_runs AS (
    SELECT counts.*,
           CASE
             WHEN counts.success_count = counts.target_count THEN 'completed'
             WHEN counts.blocked_count = counts.failure_count AND counts.failure_count > 0 THEN 'blocked'
             WHEN counts.delivery_failure_count = counts.failure_count AND counts.failure_count > 0 THEN 'delivery_failed'
             WHEN counts.success_count > 0 AND counts.failure_count > 0 THEN 'partially_failed'
             ELSE 'failed'
           END AS next_state
    FROM run_counts AS counts
    WHERE counts.active_count = 0
  ), updated_runs AS (
    UPDATE geo.automation_runs AS run
    SET state = terminal.next_state,
        stage = 'delivery',
        lease_owner = NULL,
        lease_expires_at = NULL,
        completed_at = COALESCE(run.completed_at, clock_timestamp()),
        last_error_code = CASE terminal.next_state
          WHEN 'completed' THEN NULL
          WHEN 'delivery_failed' THEN 'AUTOMATION_DELIVERY_FAILED'
          WHEN 'blocked' THEN 'AUTOMATION_GATE_BLOCKED'
          ELSE 'AUTOMATION_TARGETS_FAILED'
        END,
        last_error_message = CASE terminal.next_state
          WHEN 'completed' THEN NULL
          WHEN 'delivery_failed' THEN left(failure_code, 4000)
          WHEN 'blocked' THEN left(failure_code, 4000)
          ELSE 'AUTOMATION_TARGETS_FAILED'
        END
    FROM terminal_runs AS terminal
    WHERE run.tenant_id = NEW.tenant_id
      AND run.id = terminal.id
      AND run.state IN ('running', 'awaiting_delivery')
    RETURNING run.batch_id
  )
  SELECT count(*) INTO updated_run_count FROM updated_runs;

  UPDATE geo.automation_batches AS batch
  SET state = CASE
        WHEN EXISTS (
          SELECT 1 FROM geo.automation_runs AS run
          WHERE run.tenant_id = batch.tenant_id
            AND run.batch_id = batch.id
            AND run.state IN ('scheduled', 'running', 'retry_wait', 'awaiting_delivery')
        ) THEN 'running'
        WHEN NOT EXISTS (
          SELECT 1 FROM geo.automation_runs AS run
          WHERE run.tenant_id = batch.tenant_id
            AND run.batch_id = batch.id
            AND run.state <> 'completed'
        ) THEN 'completed'
        ELSE 'partially_failed'
      END,
      completed_at = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM geo.automation_runs AS run
          WHERE run.tenant_id = batch.tenant_id
            AND run.batch_id = batch.id
            AND run.state IN ('scheduled', 'running', 'retry_wait', 'awaiting_delivery')
        ) THEN COALESCE(batch.completed_at, clock_timestamp())
        ELSE NULL
      END
  WHERE batch.tenant_id = NEW.tenant_id
    AND batch.id IN (
      SELECT DISTINCT run.batch_id
      FROM geo.automation_runs AS run
      WHERE run.tenant_id = NEW.tenant_id
        AND run.id = ANY(affected_run_ids)
    )
    AND batch.state <> 'cancelled';

  RETURN NEW;
END
$$;

-- A publication-gate blocked target carries a terminal publication job.
-- Manual remediation must be able to retire that job and re-open the target
-- so the operator can retry after clearing the gate. Confirmed or
-- preview-completed jobs are never retired here; those stay in readback.
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
  actor_value uuid := geo.require_actor_id();
  run_row geo.automation_runs%ROWTYPE;
  target_row geo.automation_run_targets%ROWTYPE;
  job_row geo.publication_jobs%ROWTYPE;
  refreshed_batch_state text;
BEGIN
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
     OR target_row.audit_artifact_id IS NULL THEN
    RAISE EXCEPTION 'automation target is not eligible for manual remediation' USING ERRCODE = '55000';
  END IF;

  IF target_row.publication_job_id IS NOT NULL THEN
    SELECT * INTO job_row
    FROM geo.publication_jobs AS job
    WHERE job.tenant_id = tenant_value AND job.id = target_row.publication_job_id
    FOR UPDATE;
    IF job_row.id IS NULL THEN
      RAISE EXCEPTION 'publication job was not found for the blocked target' USING ERRCODE = 'P0002';
    END IF;
    IF job_row.state IN ('confirmed', 'preview_completed', 'uncertain') THEN
      RAISE EXCEPTION 'publication job already reached a readback state' USING ERRCODE = '55000';
    END IF;
    UPDATE geo.publication_jobs AS job
    SET state = 'cancelled',
        lease_owner = NULL,
        lease_expires_at = NULL,
        cancelled_at = clock_timestamp(),
        cancelled_by_actor_id = actor_value,
        cancellation_reason = left(
          'Reopened for automation remediation: ' || p_remediation::text,
          1000
        ),
        last_error_code = 'reopened_for_remediation'
    WHERE job.tenant_id = tenant_value AND job.id = job_row.id;
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

COMMIT;
