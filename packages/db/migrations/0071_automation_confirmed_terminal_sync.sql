BEGIN;

-- A publication job can be confirmed after its parent run reaches the
-- processing-attempt limit. Synchronize that terminal success just like a
-- terminal failure so the parent run and batch cannot remain in delivery wait.
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
    SET state = CASE WHEN NEW.state = 'confirmed' THEN 'confirmed' ELSE 'delivery_failed' END,
        last_error_code = CASE WHEN NEW.state = 'confirmed' THEN NULL ELSE failure_code END,
        last_error_message = CASE WHEN NEW.state = 'confirmed' THEN NULL ELSE left(failure_code, 4000) END,
        completed_at = COALESCE(
          target.completed_at,
          CASE WHEN NEW.state = 'confirmed' THEN COALESCE(NEW.confirmed_at, clock_timestamp())
               ELSE clock_timestamp() END
        )
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

  WITH run_counts AS (
    SELECT run.id,
           run.batch_id,
           count(*)::integer AS target_count,
           count(*) FILTER (WHERE target.state IN ('pending', 'variant_ready', 'awaiting_delivery'))::integer AS active_count,
           count(*) FILTER (WHERE target.state IN ('preview_completed', 'confirmed'))::integer AS success_count,
           count(*) FILTER (WHERE target.state IN ('audit_failed', 'blocked', 'failed', 'delivery_failed', 'cancelled'))::integer AS failure_count,
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
          ELSE 'AUTOMATION_TARGETS_FAILED'
        END,
        last_error_message = CASE terminal.next_state
          WHEN 'completed' THEN NULL
          WHEN 'delivery_failed' THEN left(failure_code, 4000)
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

-- Repair jobs that reached confirmed before this terminal-success branch was
-- installed. This only reconciles existing rows; it never retries or submits.
DO $$
DECLARE
  affected_tenant_ids uuid[];
  affected_run_ids uuid[];
  affected_batch_ids uuid[];
BEGIN
WITH updated_targets AS (
  UPDATE geo.automation_run_targets AS target
  SET state = 'confirmed',
      last_error_code = NULL,
      last_error_message = NULL,
      completed_at = COALESCE(target.completed_at, job.confirmed_at, clock_timestamp())
  FROM geo.publication_jobs AS job
  WHERE job.tenant_id = target.tenant_id
    AND job.id = target.publication_job_id
    AND job.state = 'confirmed'
    AND target.state = 'awaiting_delivery'
  RETURNING target.tenant_id, target.run_id
)
SELECT array_agg(tenant_id ORDER BY tenant_id, run_id),
       array_agg(run_id ORDER BY tenant_id, run_id)
INTO affected_tenant_ids, affected_run_ids
FROM (
  SELECT DISTINCT tenant_id, run_id
  FROM updated_targets
) AS affected;

IF affected_run_ids IS NOT NULL THEN
WITH run_counts AS (
  SELECT run.tenant_id,
         run.id,
         run.batch_id,
         count(*)::integer AS target_count,
         count(*) FILTER (WHERE target.state IN ('pending', 'variant_ready', 'awaiting_delivery'))::integer AS active_count,
         count(*) FILTER (WHERE target.state IN ('preview_completed', 'confirmed'))::integer AS success_count,
         count(*) FILTER (WHERE target.state IN ('audit_failed', 'blocked', 'failed', 'delivery_failed', 'cancelled'))::integer AS failure_count,
         count(*) FILTER (WHERE target.state = 'delivery_failed')::integer AS delivery_failure_count
  FROM geo.automation_runs AS run
  JOIN geo.automation_run_targets AS target
    ON target.tenant_id = run.tenant_id
   AND target.run_id = run.id
  WHERE EXISTS (
    SELECT 1
    FROM unnest(affected_tenant_ids, affected_run_ids)
      AS affected(tenant_id, run_id)
    WHERE affected.tenant_id = run.tenant_id
      AND affected.run_id = run.id
  )
  GROUP BY run.tenant_id, run.id, run.batch_id
), terminal_runs AS (
  SELECT counts.*,
         CASE
           WHEN counts.success_count = counts.target_count THEN 'completed'
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
        ELSE 'AUTOMATION_TARGETS_FAILED'
      END,
      last_error_message = CASE terminal.next_state
        WHEN 'completed' THEN NULL
        WHEN 'delivery_failed' THEN 'AUTOMATION_DELIVERY_FAILED'
        ELSE 'AUTOMATION_TARGETS_FAILED'
      END
  FROM terminal_runs AS terminal
  WHERE run.tenant_id = terminal.tenant_id
    AND run.id = terminal.id
    AND run.state IN ('running', 'awaiting_delivery')
  RETURNING run.tenant_id, run.batch_id
)
SELECT array_agg(tenant_id ORDER BY tenant_id, batch_id),
       array_agg(batch_id ORDER BY tenant_id, batch_id)
INTO affected_tenant_ids, affected_batch_ids
FROM (
  SELECT DISTINCT tenant_id, batch_id
  FROM updated_runs
) AS affected;

IF affected_batch_ids IS NOT NULL THEN
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
WHERE EXISTS (
    SELECT 1
    FROM unnest(affected_tenant_ids, affected_batch_ids)
      AS affected(tenant_id, batch_id)
    WHERE affected.tenant_id = batch.tenant_id
      AND affected.batch_id = batch.id
  )
  AND batch.state <> 'cancelled';
END IF;
END IF;
END
$$;

COMMIT;
