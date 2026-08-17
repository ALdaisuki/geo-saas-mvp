BEGIN;

CREATE OR REPLACE FUNCTION geo.cancel_publication_assisted_handoff(
  p_handoff_id uuid,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  handoff geo.publication_assisted_handoffs%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 5 AND 1000 THEN
    RAISE EXCEPTION 'cancellation reason must contain 5 to 1000 characters'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id
  FOR UPDATE;

  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002';
  END IF;
  IF handoff.state = 'cancelled' THEN
    RETURN false;
  END IF;
  IF handoff.state IN (
    'submitted_unconfirmed', 'readback_pending', 'confirmed',
    'needs_review', 'expired', 'failed'
  ) THEN
    RAISE EXCEPTION 'assisted handoff cannot be cancelled in state %', handoff.state
      USING ERRCODE = '55000';
  END IF;
  IF handoff.submit_permit_consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a consumed submit permit requires reconciliation, not cancellation'
      USING ERRCODE = '55000';
  END IF;

  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = 'cancelled',
      lease_owner_actor_id = NULL,
      lease_expires_at = NULL,
      heartbeat_at = NULL,
      draft_prepare_owner_principal_id = NULL,
      draft_prepare_lease_expires_at = NULL,
      readback_owner_principal_id = NULL,
      readback_lease_expires_at = NULL,
      submit_permit_hash = NULL,
      submit_permit_expires_at = NULL,
      submit_permit_consumed_at = NULL,
      cancelled_at = statement_timestamp(),
      cancelled_by_actor_id = actor_value,
      cancellation_reason = trim(p_reason)
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.cancelled',
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    handoff.preview_hash,
    jsonb_build_object('reason', trim(p_reason), 'previousState', handoff.state)
  );

  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION geo.cancel_automation_batch(
  p_batch_id uuid,
  p_reason text
)
RETURNS TABLE (
  automation_batch_id uuid,
  state text,
  cancelled_runs integer,
  cancelled_targets integer,
  was_changed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  batch_row geo.automation_batches%ROWTYPE;
  run_count integer := 0;
  target_count integer := 0;
  handoff_count integer := 0;
  job_count integer := 0;
  handoff_id uuid;
  job_id uuid;
  delivery_reason text;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'cancellation reason is required' USING ERRCODE = '22023';
  END IF;
  delivery_reason := left('Automation batch cancelled: ' || trim(p_reason), 1000);

  PERFORM pg_advisory_xact_lock(hashtextextended('automation:' || tenant_value::text, 0));

  SELECT * INTO batch_row
  FROM geo.automation_batches AS batch
  WHERE batch.tenant_id = tenant_value AND batch.id = p_batch_id
  FOR UPDATE;

  IF batch_row.id IS NULL THEN
    RAISE EXCEPTION 'automation batch was not found' USING ERRCODE = 'P0002';
  END IF;
  IF batch_row.state IN ('completed', 'partially_failed', 'cancelled') THEN
    RETURN QUERY SELECT batch_row.id, batch_row.state, 0, 0, false;
    RETURN;
  END IF;

  UPDATE geo.automation_run_targets AS target
  SET state = 'cancelled',
      cancelled_at = clock_timestamp(),
      last_error_code = 'AUTOMATION_BATCH_CANCELLED',
      last_error_message = left(trim(p_reason), 4000)
  WHERE target.tenant_id = tenant_value
    AND target.run_id IN (
      SELECT run.id
      FROM geo.automation_runs AS run
      WHERE run.tenant_id = tenant_value AND run.batch_id = p_batch_id
    )
    AND target.state IN ('pending', 'variant_ready', 'awaiting_delivery');
  GET DIAGNOSTICS target_count = ROW_COUNT;

  UPDATE geo.automation_runs AS run
  SET state = 'cancelled',
      lease_owner = NULL,
      lease_expires_at = NULL,
      cancelled_at = clock_timestamp(),
      cancelled_by_actor_id = actor_value,
      cancellation_reason = trim(p_reason),
      last_error_code = 'AUTOMATION_BATCH_CANCELLED',
      last_error_message = left(trim(p_reason), 4000)
  WHERE run.tenant_id = tenant_value
    AND run.batch_id = p_batch_id
    AND run.state IN ('scheduled', 'running', 'retry_wait', 'awaiting_delivery');
  GET DIAGNOSTICS run_count = ROW_COUNT;

  UPDATE geo.automation_batches AS batch
  SET state = 'cancelled',
      cancelled_at = clock_timestamp(),
      cancelled_by_actor_id = actor_value,
      cancellation_reason = trim(p_reason)
  WHERE batch.tenant_id = tenant_value AND batch.id = p_batch_id;

  FOR handoff_id IN
    SELECT handoff.id
    FROM geo.publication_assisted_handoffs AS handoff
    JOIN geo.automation_run_targets AS target
      ON target.tenant_id = handoff.tenant_id
     AND target.publication_job_id = handoff.job_id
    JOIN geo.automation_runs AS run
      ON run.tenant_id = target.tenant_id
     AND run.id = target.run_id
    WHERE handoff.tenant_id = tenant_value
      AND run.batch_id = p_batch_id
      AND handoff.state IN (
        'handoff_pending', 'session_required', 'challenge_required',
        'draft_prepared', 'awaiting_operator_submit'
      )
    ORDER BY handoff.created_at, handoff.id
  LOOP
    IF geo.cancel_publication_assisted_handoff(handoff_id, delivery_reason) THEN
      handoff_count := handoff_count + 1;
    END IF;
  END LOOP;

  FOR job_id IN
    SELECT job.id
    FROM geo.publication_jobs AS job
    JOIN geo.automation_run_targets AS target
      ON target.tenant_id = job.tenant_id
     AND target.publication_job_id = job.id
    JOIN geo.automation_runs AS run
      ON run.tenant_id = target.tenant_id
     AND run.id = target.run_id
    LEFT JOIN geo.publication_assisted_handoffs AS handoff
      ON handoff.tenant_id = job.tenant_id
     AND handoff.job_id = job.id
    WHERE job.tenant_id = tenant_value
      AND run.batch_id = p_batch_id
      AND handoff.id IS NULL
      AND (
        job.state IN ('queued', 'retry_wait')
        OR (
          job.state = 'dispatching'
          AND (job.lease_expires_at IS NULL OR job.lease_expires_at < statement_timestamp())
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM geo.outbox_events AS event
        WHERE event.tenant_id = job.tenant_id
          AND event.aggregate_type = 'publication_job'
          AND event.aggregate_id = job.id
          AND event.topic = 'publication.requested'
          AND event.published_at IS NULL
          AND event.dead_lettered_at IS NULL
          AND event.locked_by IS NOT NULL
          AND event.locked_until >= statement_timestamp()
      )
    ORDER BY job.created_at, job.id
  LOOP
    IF (SELECT result.was_changed FROM geo.cancel_publication_job(job_id, delivery_reason) AS result) THEN
      job_count := job_count + 1;
    END IF;
  END LOOP;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'automation_batch.cancelled',
    'automation_batch', p_batch_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_batch_id::text),
    encode(public.digest(
      p_batch_id::text || ':cancelled:' || run_count::text || ':' || target_count::text ||
      ':' || handoff_count::text || ':' || job_count::text,
      'sha256'
    ), 'hex'),
    jsonb_build_object(
      'reason', trim(p_reason),
      'cancelledRuns', run_count,
      'cancelledTargets', target_count,
      'cancelledHandoffs', handoff_count,
      'cancelledPublicationJobs', job_count
    )
  );

  RETURN QUERY SELECT p_batch_id, 'cancelled'::text, run_count, target_count, true;
END
$$;

-- Repair pre-submit delivery work left active by batches cancelled before this migration.
WITH candidates AS (
  SELECT handoff.tenant_id, handoff.id, batch.cancelled_at, batch.cancelled_by_actor_id,
         left('Automation batch cancelled: ' || batch.cancellation_reason, 1000) AS reason
  FROM geo.publication_assisted_handoffs AS handoff
  JOIN geo.automation_run_targets AS target
    ON target.tenant_id = handoff.tenant_id
   AND target.publication_job_id = handoff.job_id
  JOIN geo.automation_runs AS run
    ON run.tenant_id = target.tenant_id
   AND run.id = target.run_id
  JOIN geo.automation_batches AS batch
    ON batch.tenant_id = run.tenant_id
   AND batch.id = run.batch_id
  WHERE batch.state = 'cancelled'
    AND handoff.state IN (
      'handoff_pending', 'session_required', 'challenge_required',
      'draft_prepared', 'awaiting_operator_submit'
    )
)
UPDATE geo.publication_assisted_handoffs AS handoff
SET state = 'cancelled',
    lease_owner_actor_id = NULL,
    lease_expires_at = NULL,
    heartbeat_at = NULL,
    draft_prepare_owner_principal_id = NULL,
    draft_prepare_lease_expires_at = NULL,
    readback_owner_principal_id = NULL,
    readback_lease_expires_at = NULL,
    submit_permit_hash = NULL,
    submit_permit_expires_at = NULL,
    submit_permit_consumed_at = NULL,
    cancelled_at = candidates.cancelled_at,
    cancelled_by_actor_id = candidates.cancelled_by_actor_id,
    cancellation_reason = candidates.reason,
    last_error_code = 'AUTOMATION_BATCH_CANCELLED',
    last_error_message = candidates.reason
FROM candidates
WHERE handoff.tenant_id = candidates.tenant_id
  AND handoff.id = candidates.id;

WITH candidates AS (
  SELECT job.tenant_id, job.id, batch.cancelled_at, batch.cancelled_by_actor_id,
         left('Automation batch cancelled: ' || batch.cancellation_reason, 1000) AS reason
  FROM geo.publication_jobs AS job
  JOIN geo.automation_run_targets AS target
    ON target.tenant_id = job.tenant_id
   AND target.publication_job_id = job.id
  JOIN geo.automation_runs AS run
    ON run.tenant_id = target.tenant_id
   AND run.id = target.run_id
  JOIN geo.automation_batches AS batch
    ON batch.tenant_id = run.tenant_id
   AND batch.id = run.batch_id
  LEFT JOIN geo.publication_assisted_handoffs AS handoff
    ON handoff.tenant_id = job.tenant_id
   AND handoff.job_id = job.id
  WHERE batch.state = 'cancelled'
    AND handoff.id IS NULL
    AND (
      job.state IN ('queued', 'retry_wait')
      OR (
        job.state = 'dispatching'
        AND (job.lease_expires_at IS NULL OR job.lease_expires_at < statement_timestamp())
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM geo.outbox_events AS event
      WHERE event.tenant_id = job.tenant_id
        AND event.aggregate_type = 'publication_job'
        AND event.aggregate_id = job.id
        AND event.topic = 'publication.requested'
        AND event.published_at IS NULL
        AND event.dead_lettered_at IS NULL
        AND event.locked_by IS NOT NULL
        AND event.locked_until >= statement_timestamp()
    )
)
UPDATE geo.publication_attempts AS attempt
SET state = 'failed',
    error_code = 'CANCELLED_BY_OPERATOR',
    error_message = candidates.reason,
    finished_at = candidates.cancelled_at,
    governance_finished_at = candidates.cancelled_at
FROM candidates
WHERE attempt.tenant_id = candidates.tenant_id
  AND attempt.job_id = candidates.id
  AND attempt.state = 'started';

WITH candidates AS (
  SELECT job.tenant_id, job.id,
         left('Automation batch cancelled: ' || batch.cancellation_reason, 1000) AS reason
  FROM geo.publication_jobs AS job
  JOIN geo.automation_run_targets AS target
    ON target.tenant_id = job.tenant_id
   AND target.publication_job_id = job.id
  JOIN geo.automation_runs AS run
    ON run.tenant_id = target.tenant_id
   AND run.id = target.run_id
  JOIN geo.automation_batches AS batch
    ON batch.tenant_id = run.tenant_id
   AND batch.id = run.batch_id
  LEFT JOIN geo.publication_assisted_handoffs AS handoff
    ON handoff.tenant_id = job.tenant_id
   AND handoff.job_id = job.id
  WHERE batch.state = 'cancelled'
    AND handoff.id IS NULL
    AND (
      job.state IN ('queued', 'retry_wait')
      OR (
        job.state = 'dispatching'
        AND (job.lease_expires_at IS NULL OR job.lease_expires_at < statement_timestamp())
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM geo.outbox_events AS active_event
      WHERE active_event.tenant_id = job.tenant_id
        AND active_event.aggregate_type = 'publication_job'
        AND active_event.aggregate_id = job.id
        AND active_event.topic = 'publication.requested'
        AND active_event.published_at IS NULL
        AND active_event.dead_lettered_at IS NULL
        AND active_event.locked_by IS NOT NULL
        AND active_event.locked_until >= statement_timestamp()
    )
)
UPDATE geo.outbox_events AS event
SET dead_lettered_at = clock_timestamp(),
    locked_by = NULL,
    locked_until = NULL,
    last_error = left('cancelled: ' || candidates.reason, 4000)
FROM candidates
WHERE event.tenant_id = candidates.tenant_id
  AND event.aggregate_type = 'publication_job'
  AND event.aggregate_id = candidates.id
  AND event.topic = 'publication.requested'
  AND event.published_at IS NULL
  AND event.dead_lettered_at IS NULL;

WITH candidates AS (
  SELECT job.tenant_id, job.id, batch.cancelled_at, batch.cancelled_by_actor_id,
         left('Automation batch cancelled: ' || batch.cancellation_reason, 1000) AS reason
  FROM geo.publication_jobs AS job
  JOIN geo.automation_run_targets AS target
    ON target.tenant_id = job.tenant_id
   AND target.publication_job_id = job.id
  JOIN geo.automation_runs AS run
    ON run.tenant_id = target.tenant_id
   AND run.id = target.run_id
  JOIN geo.automation_batches AS batch
    ON batch.tenant_id = run.tenant_id
   AND batch.id = run.batch_id
  LEFT JOIN geo.publication_assisted_handoffs AS handoff
    ON handoff.tenant_id = job.tenant_id
   AND handoff.job_id = job.id
  WHERE batch.state = 'cancelled'
    AND handoff.id IS NULL
    AND (
      job.state IN ('queued', 'retry_wait')
      OR (
        job.state = 'dispatching'
        AND (job.lease_expires_at IS NULL OR job.lease_expires_at < statement_timestamp())
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM geo.outbox_events AS active_event
      WHERE active_event.tenant_id = job.tenant_id
        AND active_event.aggregate_type = 'publication_job'
        AND active_event.aggregate_id = job.id
        AND active_event.topic = 'publication.requested'
        AND active_event.published_at IS NULL
        AND active_event.dead_lettered_at IS NULL
        AND active_event.locked_by IS NOT NULL
        AND active_event.locked_until >= statement_timestamp()
    )
)
UPDATE geo.publication_jobs AS job
SET state = 'cancelled',
    lease_owner = NULL,
    lease_expires_at = NULL,
    cancelled_at = candidates.cancelled_at,
    cancelled_by_actor_id = candidates.cancelled_by_actor_id,
    cancellation_reason = candidates.reason,
    last_error_code = 'cancelled_by_operator'
FROM candidates
WHERE job.tenant_id = candidates.tenant_id
  AND job.id = candidates.id;

REVOKE ALL ON FUNCTION geo.cancel_publication_assisted_handoff(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.cancel_automation_batch(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.cancel_publication_assisted_handoff(uuid, text) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.cancel_automation_batch(uuid, text) TO geo_runtime;

COMMIT;
