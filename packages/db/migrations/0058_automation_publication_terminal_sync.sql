ALTER TABLE geo.automation_runs
  DROP CONSTRAINT automation_runs_check4;

ALTER TABLE geo.automation_runs
  ADD CONSTRAINT automation_runs_completion_check
  CHECK (
    (state IN (
      'completed', 'partially_failed', 'delivery_failed', 'blocked', 'failed'
    )) = (completed_at IS NOT NULL)
  );

ALTER TABLE geo.automation_run_targets
  DROP CONSTRAINT automation_run_targets_check4;

ALTER TABLE geo.automation_run_targets
  ADD CONSTRAINT automation_run_targets_completion_check
  CHECK (
    (state IN (
      'preview_completed', 'confirmed', 'audit_failed', 'delivery_failed', 'blocked', 'failed'
    )) = (completed_at IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION geo.sync_automation_target_from_publication_job()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  affected_run_ids uuid[];
  failure_code text := COALESCE(
    NULLIF(trim(NEW.last_error_code), ''),
    'AUTOMATION_PUBLICATION_' || upper(NEW.state)
  );
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state
     OR NEW.state NOT IN ('needs_review', 'permanent_failure') THEN
    RETURN NEW;
  END IF;

  WITH updated_targets AS (
    UPDATE geo.automation_run_targets AS target
    SET state = 'delivery_failed',
        last_error_code = failure_code,
        last_error_message = left(failure_code, 4000),
        completed_at = COALESCE(target.completed_at, clock_timestamp())
    WHERE target.tenant_id = NEW.tenant_id
      AND target.publication_job_id = NEW.id
      AND target.state = 'awaiting_delivery'
    RETURNING target.run_id
  )
  SELECT array_agg(DISTINCT updated_targets.run_id)
  INTO affected_run_ids
  FROM updated_targets;

  IF affected_run_ids IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE geo.automation_runs AS run
  SET state = 'delivery_failed',
      stage = 'delivery',
      lease_owner = NULL,
      lease_expires_at = NULL,
      completed_at = COALESCE(run.completed_at, clock_timestamp()),
      last_error_code = 'AUTOMATION_DELIVERY_FAILED',
      last_error_message = left(failure_code, 4000)
  WHERE run.tenant_id = NEW.tenant_id
    AND run.id = ANY(affected_run_ids)
    AND run.state = 'awaiting_delivery'
    AND EXISTS (
      SELECT 1
      FROM geo.automation_run_targets AS target
      WHERE target.tenant_id = run.tenant_id
        AND target.run_id = run.id
        AND target.state = 'delivery_failed'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM geo.automation_run_targets AS target
      WHERE target.tenant_id = run.tenant_id
        AND target.run_id = run.id
        AND target.state IN ('pending', 'variant_ready', 'awaiting_delivery')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM geo.automation_run_targets AS target
      WHERE target.tenant_id = run.tenant_id
        AND target.run_id = run.id
        AND target.state IN ('audit_failed', 'blocked', 'failed', 'cancelled')
    );

  WITH affected_batches AS (
    SELECT DISTINCT run.batch_id
    FROM geo.automation_runs AS run
    WHERE run.tenant_id = NEW.tenant_id
      AND run.id = ANY(affected_run_ids)
      AND run.state = 'delivery_failed'
  ), batch_counts AS (
    SELECT run.batch_id,
           count(*)::integer AS total_count,
           count(*) FILTER (
             WHERE run.state IN ('scheduled', 'running', 'retry_wait', 'awaiting_delivery')
           )::integer AS active_count,
           count(*) FILTER (WHERE run.state = 'completed')::integer AS completed_count
    FROM geo.automation_runs AS run
    JOIN affected_batches AS affected ON affected.batch_id = run.batch_id
    WHERE run.tenant_id = NEW.tenant_id
    GROUP BY run.batch_id
  ), next_states AS (
    SELECT counts.batch_id,
           CASE
             WHEN counts.active_count > 0 THEN 'running'
             WHEN counts.completed_count = counts.total_count THEN 'completed'
             ELSE 'partially_failed'
           END AS next_state
    FROM batch_counts AS counts
  )
  UPDATE geo.automation_batches AS batch
  SET state = next_states.next_state,
      started_at = CASE
        WHEN next_states.next_state = 'running'
          THEN COALESCE(batch.started_at, clock_timestamp())
        ELSE batch.started_at
      END,
      completed_at = CASE
        WHEN next_states.next_state IN ('completed', 'partially_failed')
          THEN COALESCE(batch.completed_at, clock_timestamp())
        ELSE NULL
      END
  FROM next_states
  WHERE batch.tenant_id = NEW.tenant_id
    AND batch.id = next_states.batch_id
    AND batch.state <> 'cancelled';

  RETURN NEW;
END
$$;

CREATE TRIGGER publication_jobs_automation_terminal_sync
AFTER UPDATE OF state ON geo.publication_jobs
FOR EACH ROW EXECUTE FUNCTION geo.sync_automation_target_from_publication_job();

COMMENT ON FUNCTION geo.sync_automation_target_from_publication_job() IS
  'Synchronizes terminal publication failures into bound automation targets before retry exhaustion';

REVOKE ALL ON FUNCTION geo.sync_automation_target_from_publication_job() FROM PUBLIC;
