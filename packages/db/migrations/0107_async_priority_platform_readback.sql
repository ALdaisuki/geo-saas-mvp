BEGIN;

-- Platform moderation commonly outlives the interactive browser window. The
-- first ten minutes remain a high-frequency confirmation phase; an accepted
-- one-shot submit then becomes a completed delivery with asynchronous
-- readback, without fabricating a public URL or treating review latency as a
-- delivery failure.
ALTER TABLE geo.automation_run_targets
  DROP CONSTRAINT automation_run_targets_state_check;

ALTER TABLE geo.automation_run_targets
  ADD CONSTRAINT automation_run_targets_state_check
  CHECK (state IN (
    'pending', 'variant_ready', 'audit_failed', 'awaiting_manual_review',
    'awaiting_delivery', 'submitted_pending_review', 'preview_completed',
    'confirmed', 'delivery_failed', 'blocked', 'failed', 'cancelled'
  ));

ALTER TABLE geo.automation_run_targets
  DROP CONSTRAINT automation_run_targets_completion_check;

ALTER TABLE geo.automation_run_targets
  ADD CONSTRAINT automation_run_targets_completion_check
  CHECK (
    (state IN (
      'submitted_pending_review', 'preview_completed', 'confirmed',
      'audit_failed', 'delivery_failed', 'blocked', 'failed'
    )) = (completed_at IS NOT NULL)
  );

ALTER TABLE geo.automation_run_targets
  ADD CONSTRAINT automation_run_targets_submitted_pending_review_complete
  CHECK (
    state <> 'submitted_pending_review' OR (
      variant_id IS NOT NULL AND audit_artifact_id IS NOT NULL AND
      publication_job_id IS NOT NULL AND completed_at IS NOT NULL
    )
  );

CREATE OR REPLACE FUNCTION geo.expire_priority_platform_readback_windows()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  candidate geo.publication_assisted_handoffs%ROWTYPE;
  async_deadline timestamptz;
  affected_run_ids uuid[];
  affected_batch_ids uuid[];
  processed_count integer := 0;
BEGIN
  FOR candidate IN
    SELECT handoff.*
    FROM geo.publication_assisted_handoffs AS handoff
    JOIN geo.publication_jobs AS job
      ON job.tenant_id = handoff.tenant_id AND job.id = handoff.job_id
    WHERE handoff.tenant_id = tenant_value
      AND handoff.state = 'readback_pending'
      AND handoff.readback_deadline_at <= statement_timestamp()
      AND handoff.external_id IS NULL
      AND handoff.external_url IS NULL
      AND job.platform = handoff.platform
      AND job.platform IN ('toutiao', 'sohu', 'baijiahao', 'netease')
    FOR UPDATE OF handoff SKIP LOCKED
  LOOP
    async_deadline := COALESCE(candidate.submit_observed_at, candidate.submit_permit_consumed_at)
      + interval '24 hours';

    IF candidate.readback_deadline_at < async_deadline
       AND async_deadline > statement_timestamp() THEN
      UPDATE geo.publication_assisted_handoffs AS handoff
      SET readback_deadline_at = async_deadline,
          readback_owner_principal_id = NULL,
          readback_lease_expires_at = NULL,
          last_error_code = 'ASSISTED_READBACK_DEFERRED',
          last_error_message = '已提交平台审核，系统将在后台继续异步回读'
      WHERE handoff.tenant_id = tenant_value AND handoff.id = candidate.id;

      UPDATE geo.publication_readbacks AS readback
      SET status = 'pending',
          completed_at = NULL,
          last_error = 'ASSISTED_READBACK_DEFERRED'
      WHERE readback.tenant_id = tenant_value
        AND readback.id = candidate.publication_readback_id;

      UPDATE geo.publication_jobs AS job
      SET state = 'uncertain',
          confirmed_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error_code = 'ASSISTED_READBACK_DEFERRED'
      WHERE job.tenant_id = tenant_value AND job.id = candidate.job_id;

      WITH submitted_targets AS (
        UPDATE geo.automation_run_targets AS target
        SET state = 'submitted_pending_review',
            completed_at = COALESCE(target.completed_at, clock_timestamp()),
            last_error_code = NULL,
            last_error_message = NULL
        WHERE target.tenant_id = tenant_value
          AND target.publication_job_id = candidate.job_id
          AND target.state = 'awaiting_delivery'
        RETURNING target.run_id
      )
      SELECT array_agg(DISTINCT run_id) INTO affected_run_ids
      FROM submitted_targets;

      IF affected_run_ids IS NOT NULL THEN
        WITH run_counts AS (
          SELECT run.id, run.batch_id,
                 count(*)::integer AS target_count,
                 count(*) FILTER (WHERE target.state IN (
                   'pending', 'variant_ready', 'awaiting_manual_review', 'awaiting_delivery'
                 ))::integer AS active_count,
                 count(*) FILTER (WHERE target.state IN (
                   'preview_completed', 'submitted_pending_review', 'confirmed'
                 ))::integer AS success_count,
                 count(*) FILTER (WHERE target.state IN (
                   'audit_failed', 'blocked', 'failed', 'delivery_failed', 'cancelled'
                 ))::integer AS failure_count,
                 count(*) FILTER (WHERE target.state = 'delivery_failed')::integer
                   AS delivery_failure_count
          FROM geo.automation_runs AS run
          JOIN geo.automation_run_targets AS target
            ON target.tenant_id = run.tenant_id AND target.run_id = run.id
          WHERE run.tenant_id = tenant_value AND run.id = ANY(affected_run_ids)
          GROUP BY run.id, run.batch_id
        ), terminal_runs AS (
          SELECT counts.*,
                 CASE
                   WHEN counts.success_count = counts.target_count THEN 'completed'
                   WHEN counts.delivery_failure_count = counts.failure_count
                     AND counts.failure_count > 0 THEN 'delivery_failed'
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
          WHERE run.tenant_id = tenant_value
            AND run.id = terminal.id
            AND run.state IN ('running', 'awaiting_delivery')
          RETURNING run.batch_id
        )
        SELECT array_agg(DISTINCT batch_id) INTO affected_batch_ids
        FROM updated_runs;

        IF affected_batch_ids IS NOT NULL THEN
          PERFORM geo.refresh_automation_batch_state(batch_id)
          FROM unnest(affected_batch_ids) AS batch_id;
        END IF;
      END IF;

      INSERT INTO geo.audit_log (
        tenant_id, actor_id, action, resource_type, resource_id,
        request_id, after_hash, details
      ) VALUES (
        tenant_value, geo.require_actor_id(),
        'publication_assisted_handoff.readback_deferred',
        'publication_assisted_handoff', candidate.id,
        COALESCE(NULLIF(current_setting('app.request_id', true), ''), candidate.id::text),
        candidate.preview_hash,
        jsonb_build_object(
          'reason', 'platform_review_pending',
          'highFrequencyWindowMinutes', 10,
          'asyncDeadlineAt', async_deadline,
          'attemptCount', candidate.readback_attempt_count,
          'submitBoundaryCrossed', true
        )
      );
    ELSE
      UPDATE geo.publication_assisted_handoffs AS handoff
      SET state = 'needs_review',
          readback_outcome = CASE
            WHEN handoff.readback_evidence_kind IS NULL
             AND handoff.readback_evidence_hash IS NULL
             AND handoff.readback_observed_at IS NULL
            THEN NULL
            ELSE COALESCE(handoff.readback_outcome, 'not_found')
          END,
          readback_owner_principal_id = NULL,
          readback_lease_expires_at = NULL,
          last_error_code = 'ASSISTED_READBACK_UNCERTAIN',
          last_error_message = '异步回读窗口已结束，结果仍不明确，请人工确认'
      WHERE handoff.tenant_id = tenant_value AND handoff.id = candidate.id;

      UPDATE geo.publication_readbacks AS readback
      SET status = 'failed', completed_at = clock_timestamp(),
          last_error = 'ASSISTED_READBACK_UNCERTAIN'
      WHERE readback.tenant_id = tenant_value
        AND readback.id = candidate.publication_readback_id;

      UPDATE geo.publication_jobs AS job
      SET state = 'needs_review', confirmed_at = NULL,
          last_error_code = 'ASSISTED_READBACK_UNCERTAIN'
      WHERE job.tenant_id = tenant_value AND job.id = candidate.job_id;

      INSERT INTO geo.audit_log (
        tenant_id, actor_id, action, resource_type, resource_id,
        request_id, after_hash, details
      ) VALUES (
        tenant_value, geo.require_actor_id(),
        'publication_assisted_handoff.needs_review',
        'publication_assisted_handoff', candidate.id,
        COALESCE(NULLIF(current_setting('app.request_id', true), ''), candidate.id::text),
        candidate.preview_hash,
        jsonb_build_object(
          'reason', 'async_readback_timeout',
          'readbackDeadlineAt', candidate.readback_deadline_at,
          'attemptCount', candidate.readback_attempt_count,
          'uncertain', true,
          'submitBoundaryCrossed', true
        )
      );
    END IF;

    processed_count := processed_count + 1;
  END LOOP;

  RETURN processed_count;
END
$$;

DO $claim$
DECLARE
  definition text;
  deadline_guard text := $needle$      OR candidate.readback_deadline_at >= statement_timestamp()
    )$needle$;
BEGIN
  SELECT pg_get_functiondef('geo.claim_next_ctrip_unattended_readback()'::regprocedure)
    INTO definition;
  IF definition IS NULL
     OR position('PERFORM geo.expire_priority_platform_readback_windows();' IN definition) = 0
     OR position(deadline_guard IN definition) = 0 THEN
    RAISE EXCEPTION 'priority platform readback claim drifted before 0107';
  END IF;
  definition := replace(
    definition,
    deadline_guard,
    $replacement$      OR candidate.readback_deadline_at >= statement_timestamp()
    )
    AND (
      candidate.platform = 'ctrip_community'
      OR candidate.readback_attempt_count = 0
      OR candidate.updated_at <= statement_timestamp() - CASE
        WHEN COALESCE(candidate.submit_observed_at, candidate.submit_permit_consumed_at)
          >= statement_timestamp() - interval '10 minutes'
        THEN interval '1 minute'
        ELSE interval '30 minutes'
      END
    )$replacement$
  );
  EXECUTE definition;
END
$claim$;

DO $readback$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_functiondef(
    'geo.record_publication_assisted_readback(uuid,text,text,geo.sha256_hex,geo.sha256_hex,text,text,timestamptz)'::regprocedure
  ) INTO definition;
  IF definition IS NULL
     OR position('next_attempt_count >= 10' IN definition) = 0 THEN
    RAISE EXCEPTION 'priority platform readback recorder drifted before 0107';
  END IF;
  definition := replace(definition, 'next_attempt_count >= 10', 'false');
  definition := replace(definition, '''attemptLimit'', 10', '''attemptLimit'', 100');
  definition := replace(
    definition,
    'last_error_code = readback_error,',
    $replacement$last_error_code = CASE
        WHEN next_state = 'readback_pending'
         AND p_observed_at >= COALESCE(handoff.submit_observed_at, handoff.submit_permit_consumed_at)
           + interval '10 minutes'
        THEN 'ASSISTED_READBACK_DEFERRED'
        ELSE readback_error
      END,$replacement$
  );
  definition := replace(
    definition,
    'last_error = readback_error',
    $replacement$last_error = CASE
        WHEN next_state = 'readback_pending'
         AND p_observed_at >= COALESCE(handoff.submit_observed_at, handoff.submit_permit_consumed_at)
           + interval '10 minutes'
        THEN 'ASSISTED_READBACK_DEFERRED'
        ELSE readback_error
      END$replacement$
  );
  definition := replace(
    definition,
    'last_error_code = readback_error',
    $replacement$last_error_code = CASE
        WHEN next_state = 'readback_pending'
         AND p_observed_at >= COALESCE(handoff.submit_observed_at, handoff.submit_permit_consumed_at)
           + interval '10 minutes'
        THEN 'ASSISTED_READBACK_DEFERRED'
        ELSE readback_error
      END$replacement$
  );
  IF position('next_attempt_count >= 10' IN definition) <> 0 THEN
    RAISE EXCEPTION 'priority platform readback attempt exhaustion survived 0107';
  END IF;
  EXECUTE definition;
END
$readback$;

DO $sync$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_functiondef('geo.sync_automation_target_from_publication_job()'::regprocedure)
    INTO definition;
  IF definition IS NULL
     OR position('target.state = ''awaiting_delivery''' IN definition) = 0 THEN
    RAISE EXCEPTION 'automation publication terminal sync drifted before 0107';
  END IF;
  definition := replace(
    definition,
    'AND target.state = ''awaiting_delivery''',
    $replacement$AND (
        (NEW.state = 'confirmed' AND target.state IN ('awaiting_delivery', 'submitted_pending_review'))
        OR (NEW.state <> 'confirmed' AND target.state = 'awaiting_delivery')
      )$replacement$
  );
  EXECUTE definition;
END
$sync$;

GRANT EXECUTE ON FUNCTION geo.expire_priority_platform_readback_windows() TO geo_runtime;

COMMENT ON FUNCTION geo.expire_priority_platform_readback_windows() IS
  'Defers accepted priority-platform submits to a 24-hour asynchronous readback window after ten minutes, then requests manual review without resubmitting';

COMMENT ON FUNCTION geo.claim_next_ctrip_unattended_readback() IS
  'Claims high-frequency priority-platform readback for ten minutes and low-frequency asynchronous readback every thirty minutes afterward';

COMMIT;
