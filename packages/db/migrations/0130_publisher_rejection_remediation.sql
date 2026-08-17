BEGIN;

-- Platform moderation rejection is a first-class terminal observation. It is
-- distinct from an unavailable public page and from a submit-time failure.
ALTER TABLE geo.publication_assisted_handoffs
  DROP CONSTRAINT IF EXISTS publication_assisted_handoffs_readback_outcome_check;

ALTER TABLE geo.publication_assisted_handoffs
  ADD CONSTRAINT publication_assisted_handoffs_readback_outcome_check
    CHECK (readback_outcome IN (
      'publisher_confirmed', 'publisher_rejected', 'confirmed', 'not_found',
      'mismatch', 'unavailable', 'simulation_only'
    ));

ALTER TABLE geo.automation_run_targets
  DROP CONSTRAINT automation_run_targets_state_check;

ALTER TABLE geo.automation_run_targets
  ADD CONSTRAINT automation_run_targets_state_check
  CHECK (state IN (
    'pending', 'variant_ready', 'audit_failed', 'awaiting_manual_review',
    'awaiting_delivery', 'submitted_pending_review', 'publisher_rejected',
    'preview_completed', 'confirmed', 'delivery_failed', 'blocked', 'failed',
    'cancelled'
  ));

ALTER TABLE geo.automation_run_targets
  DROP CONSTRAINT automation_run_targets_completion_check;

ALTER TABLE geo.automation_run_targets
  ADD CONSTRAINT automation_run_targets_completion_check
  CHECK (
    (state IN (
      'submitted_pending_review', 'publisher_rejected', 'preview_completed',
      'confirmed', 'audit_failed', 'delivery_failed', 'blocked', 'failed'
    )) = (completed_at IS NOT NULL)
  );

ALTER TABLE geo.automation_run_targets
  ADD CONSTRAINT automation_run_targets_publisher_rejected_complete
  CHECK (
    state <> 'publisher_rejected' OR (
      variant_id IS NOT NULL AND audit_artifact_id IS NOT NULL AND
      publication_job_id IS NOT NULL AND completed_at IS NOT NULL AND
      last_error_code IS NOT NULL
    )
  );

-- A needs_review handoff is normally uncertain, but an authenticated creator
-- backend rejection is a definitive failed delivery. Preserve that distinction
-- before the publication-job trigger projects it onto the automation target.
CREATE OR REPLACE FUNCTION geo.sync_ctrip_handoff_terminal_job()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  terminal_at timestamptz := clock_timestamp();
  terminal_error text;
  attempt_outcome text;
  target_job_state text;
  publisher_rejected boolean :=
    NEW.state = 'needs_review' AND NEW.readback_outcome = 'publisher_rejected';
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state
     OR NEW.state NOT IN ('confirmed', 'needs_review', 'failed', 'expired', 'cancelled') THEN
    RETURN NEW;
  END IF;

  terminal_error := COALESCE(
    NULLIF(trim(NEW.last_error_code), ''),
    CASE
      WHEN publisher_rejected THEN 'ASSISTED_PUBLISHER_REJECTED'
      WHEN NEW.state = 'expired' THEN 'ASSISTED_HANDOFF_EXPIRED'
      WHEN NEW.state = 'cancelled' THEN 'ASSISTED_HANDOFF_CANCELLED'
      WHEN NEW.state = 'needs_review' THEN 'ASSISTED_HANDOFF_NEEDS_REVIEW'
      WHEN NEW.state = 'failed' THEN 'ASSISTED_HANDOFF_FAILED'
      ELSE NULL
    END
  );
  attempt_outcome := CASE
    WHEN NEW.state = 'confirmed' THEN 'succeeded'
    WHEN publisher_rejected THEN 'failed'
    WHEN NEW.state = 'needs_review' THEN 'uncertain'
    ELSE 'failed'
  END;
  target_job_state := CASE
    WHEN NEW.state = 'confirmed' THEN 'confirmed'
    WHEN NEW.state = 'cancelled' THEN 'cancelled'
    WHEN publisher_rejected THEN 'permanent_failure'
    ELSE 'needs_review'
  END;

  UPDATE geo.publication_attempts AS attempt
  SET state = attempt_outcome,
      response_hash = COALESCE(
        attempt.response_hash,
        (
          SELECT receipt.response_hash
          FROM geo.publication_receipts AS receipt
          WHERE receipt.tenant_id = NEW.tenant_id
            AND receipt.id = NEW.publication_receipt_id
        )
      ),
      error_code = CASE WHEN attempt_outcome = 'succeeded' THEN NULL ELSE terminal_error END,
      error_message = CASE
        WHEN attempt_outcome = 'succeeded' THEN NULL
        ELSE left(COALESCE(NULLIF(trim(NEW.last_error_message), ''), terminal_error), 4000)
      END,
      finished_at = terminal_at,
      governance_finished_at = terminal_at
  WHERE attempt.tenant_id = NEW.tenant_id
    AND attempt.id = NEW.attempt_id
    AND attempt.job_id = NEW.job_id
    AND attempt.state = 'started';

  UPDATE geo.publication_jobs AS job
  SET state = target_job_state,
      lease_owner = NULL,
      lease_expires_at = NULL,
      confirmed_at = CASE WHEN target_job_state = 'confirmed'
        THEN COALESCE(NEW.readback_observed_at, terminal_at)
        ELSE NULL
      END,
      cancelled_at = CASE WHEN target_job_state = 'cancelled'
        THEN COALESCE(NEW.cancelled_at, terminal_at)
        ELSE job.cancelled_at
      END,
      cancelled_by_actor_id = CASE WHEN target_job_state = 'cancelled'
        THEN NEW.cancelled_by_actor_id
        ELSE job.cancelled_by_actor_id
      END,
      cancellation_reason = CASE WHEN target_job_state = 'cancelled'
        THEN COALESCE(NEW.cancellation_reason, 'Ctrip handoff cancelled')
        ELSE job.cancellation_reason
      END,
      last_error_code = CASE WHEN target_job_state = 'confirmed' THEN NULL ELSE terminal_error END,
      updated_at = terminal_at
  WHERE job.tenant_id = NEW.tenant_id
    AND job.id = NEW.job_id
    AND job.state IN (
      'queued', 'dispatching', 'retry_wait', 'uncertain', 'reconciling', 'needs_review'
    );

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, before_hash, after_hash, details
  )
  SELECT
    NEW.tenant_id,
    NEW.bridge_service_principal_id,
    'publication_assisted_handoff.job_terminal_synced',
    'publication_job',
    NEW.job_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), NEW.id::text),
    job.request_hash,
    COALESCE(NEW.readback_evidence_hash, NEW.prepare_evidence_hash, NEW.submit_evidence_hash),
    jsonb_build_object(
      'handoffId', NEW.id,
      'attemptId', NEW.attempt_id,
      'handoffState', NEW.state,
      'jobState', target_job_state,
      'attemptOutcome', attempt_outcome,
      'errorCode', terminal_error,
      'publisherRejected', publisher_rejected
    )
  FROM geo.publication_jobs AS job
  WHERE job.tenant_id = NEW.tenant_id AND job.id = NEW.job_id;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION geo.sync_automation_target_from_publication_job()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  affected_run_ids uuid[];
  affected_batch_ids uuid[];
  failure_code text := COALESCE(
    NULLIF(trim(NEW.last_error_code), ''),
    'AUTOMATION_PUBLICATION_' || upper(NEW.state)
  );
  publisher_rejected boolean :=
    NEW.state = 'permanent_failure'
    AND failure_code LIKE 'ASSISTED_PUBLISHER_REJECTED%';
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
          WHEN publisher_rejected THEN 'publisher_rejected'
          ELSE 'delivery_failed'
        END,
        last_error_code = CASE WHEN NEW.state = 'confirmed' THEN NULL ELSE failure_code END,
        last_error_message = CASE
          WHEN NEW.state = 'confirmed' THEN NULL
          WHEN publisher_rejected
            AND failure_code = 'ASSISTED_PUBLISHER_REJECTED_SOFT_ADVERTORIAL'
          THEN '平台审核未通过：文章被判定为广告软文'
          WHEN publisher_rejected THEN '平台审核未通过'
          ELSE left(failure_code, 4000)
        END,
        completed_at = COALESCE(
          target.completed_at,
          CASE WHEN NEW.state = 'confirmed' THEN COALESCE(NEW.confirmed_at, clock_timestamp())
               ELSE clock_timestamp() END
        )
    WHERE target.tenant_id = NEW.tenant_id
      AND target.publication_job_id = NEW.id
      AND (
        (NEW.state = 'confirmed'
          AND target.state IN ('awaiting_delivery', 'submitted_pending_review'))
        OR (publisher_rejected
          AND target.state IN ('awaiting_delivery', 'submitted_pending_review'))
        OR (NEW.state <> 'confirmed' AND NOT publisher_rejected
          AND target.state = 'awaiting_delivery')
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
           count(*) FILTER (WHERE target.state IN (
             'pending', 'variant_ready', 'awaiting_manual_review', 'awaiting_delivery'
           ))::integer AS active_count,
           count(*) FILTER (WHERE target.state IN (
             'submitted_pending_review', 'preview_completed', 'confirmed'
           ))::integer AS success_count,
           count(*) FILTER (WHERE target.state IN (
             'audit_failed', 'publisher_rejected', 'blocked', 'failed',
             'delivery_failed', 'cancelled'
           ))::integer AS failure_count,
           count(*) FILTER (WHERE target.state = 'blocked')::integer AS blocked_count,
           count(*) FILTER (WHERE target.state IN (
             'publisher_rejected', 'delivery_failed'
           ))::integer AS publication_failure_count
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
             WHEN counts.blocked_count = counts.failure_count AND counts.failure_count > 0
               THEN 'blocked'
             WHEN counts.publication_failure_count = counts.failure_count
               AND counts.failure_count > 0 THEN 'delivery_failed'
             WHEN counts.success_count > 0 AND counts.failure_count > 0
               THEN 'partially_failed'
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
      AND run.state <> 'cancelled'
    RETURNING run.batch_id
  )
  SELECT array_agg(DISTINCT updated_runs.batch_id)
  INTO affected_batch_ids
  FROM updated_runs;

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
    AND batch.id = ANY(COALESCE(affected_batch_ids, ARRAY[]::uuid[]))
    AND batch.state <> 'cancelled';

  RETURN NEW;
END
$$;

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
    RAISE EXCEPTION 'automation remediation plan must be an object' USING ERRCODE = '22023';
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
  IF target_row.state NOT IN (
       'awaiting_manual_review', 'audit_failed', 'blocked', 'publisher_rejected'
     ) OR target_row.audit_artifact_id IS NULL THEN
    RAISE EXCEPTION 'automation target is not eligible for remediation' USING ERRCODE = '55000';
  END IF;

  IF target_row.publication_job_id IS NOT NULL THEN
    SELECT * INTO job_row
    FROM geo.publication_jobs AS job
    WHERE job.tenant_id = tenant_value AND job.id = target_row.publication_job_id
    FOR UPDATE;
    IF job_row.id IS NULL THEN
      RAISE EXCEPTION 'publication job was not found for the remediation target'
        USING ERRCODE = 'P0002';
    END IF;
    IF target_row.state = 'publisher_rejected' THEN
      IF job_row.state <> 'permanent_failure'
         OR job_row.last_error_code NOT LIKE 'ASSISTED_PUBLISHER_REJECTED%' THEN
        RAISE EXCEPTION 'publisher rejection remediation requires retained rejection evidence'
          USING ERRCODE = '55000';
      END IF;
    ELSE
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
  END IF;

  UPDATE geo.automation_run_targets AS target
  SET state = 'pending',
      variant_id = NULL,
      audit_run_id = NULL,
      audit_artifact_id = NULL,
      publication_job_id = NULL,
      remediation = p_remediation,
      checkpoint = '{}'::jsonb,
      completed_at = NULL,
      last_error_code = NULL,
      last_error_message = NULL,
      updated_at = clock_timestamp()
  WHERE target.tenant_id = tenant_value AND target.id = p_target_id;

  UPDATE geo.automation_runs AS run
  SET state = 'scheduled',
      stage = 'targets',
      available_at = clock_timestamp(),
      attempt_count = 0,
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

CREATE OR REPLACE FUNCTION geo.record_publication_assisted_publisher_rejection(
  p_handoff_id uuid,
  p_evidence_hash geo.sha256_hex,
  p_reason_code text,
  p_observed_at timestamptz
)
RETURNS TABLE (state text, external_id text, external_url text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_bound_ctrip_bridge(p_handoff_id);
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  job geo.publication_jobs%ROWTYPE;
  target_row geo.automation_run_targets%ROWTYPE;
  run_row geo.automation_runs%ROWTYPE;
  batch_configuration jsonb := '{}'::jsonb;
  reason_code text := NULLIF(trim(p_reason_code), '');
  rejection_error_code text;
  rejection_message text;
  prior_attempt integer := 0;
  remediation_attempt integer;
  remediation_enabled boolean := true;
  remediation_plan jsonb;
  remediation_requeued boolean := false;
  remediation_error text;
BEGIN
  IF p_observed_at IS NULL
     OR p_observed_at > statement_timestamp() + interval '1 minute'
     OR p_observed_at < statement_timestamp() - interval '7 days'
     OR reason_code NOT IN (
       'publisher.rejected.soft_advertorial', 'publisher.rejected.other'
     ) THEN
    RAISE EXCEPTION 'invalid creator-management publisher rejection'
      USING ERRCODE = '22023';
  END IF;

  rejection_error_code := CASE reason_code
    WHEN 'publisher.rejected.soft_advertorial'
      THEN 'ASSISTED_PUBLISHER_REJECTED_SOFT_ADVERTORIAL'
    ELSE 'ASSISTED_PUBLISHER_REJECTED'
  END;
  rejection_message := CASE reason_code
    WHEN 'publisher.rejected.soft_advertorial'
      THEN '平台审核未通过：文章被判定为广告软文'
    ELSE '平台审核未通过'
  END;

  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id
  FOR UPDATE;
  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002';
  END IF;
  IF handoff.state <> 'readback_pending'
     OR handoff.publication_receipt_id IS NULL
     OR handoff.publication_readback_id IS NULL THEN
    RAISE EXCEPTION 'publisher rejection requires a submitted pending handoff'
      USING ERRCODE = '55000';
  END IF;
  IF handoff.submit_evidence_kind <> 'browser' THEN
    RAISE EXCEPTION 'publisher rejection requires browser submit evidence'
      USING ERRCODE = '23514';
  END IF;
  IF handoff.submit_observed_at IS NULL
     OR p_observed_at < handoff.submit_observed_at - interval '1 minute' THEN
    RAISE EXCEPTION 'publisher rejection predates the submit observation'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO job
  FROM geo.publication_jobs AS publication_job
  WHERE publication_job.tenant_id = tenant_value
    AND publication_job.id = handoff.job_id
  FOR UPDATE;
  IF job.id IS NULL
     OR job.platform <> handoff.platform
     OR job.channel_account_id <> handoff.channel_account_id
     OR job.variant_id <> handoff.variant_id
     OR job.payload_hash <> handoff.payload_hash THEN
    RAISE EXCEPTION 'publisher rejection lineage does not match its publication job'
      USING ERRCODE = '55000';
  END IF;
  IF job.execution_level = 'unattended' AND (
    handoff.readback_owner_principal_id <> actor_value
    OR handoff.readback_lease_expires_at < statement_timestamp()
  ) THEN
    RAISE EXCEPTION 'unattended publisher rejection requires the current bridge lease'
      USING ERRCODE = '55006';
  END IF;

  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = 'needs_review',
      readback_outcome = 'publisher_rejected',
      readback_evidence_kind = 'creator_management',
      readback_evidence_hash = p_evidence_hash,
      readback_observed_at = p_observed_at,
      readback_attempt_count = readback_attempt_count + 1,
      observed_payload_hash = NULL,
      external_id = NULL,
      external_url = NULL,
      readback_owner_principal_id = NULL,
      readback_lease_expires_at = NULL,
      last_error_code = rejection_error_code,
      last_error_message = rejection_message
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id;

  UPDATE geo.publication_readbacks AS readback
  SET status = 'failed',
      reason = reason_code,
      completed_at = clock_timestamp(),
      last_error = rejection_error_code
  WHERE readback.tenant_id = tenant_value
    AND readback.id = handoff.publication_readback_id;

  UPDATE geo.publication_jobs AS publication_job
  SET state = 'permanent_failure',
      confirmed_at = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error_code = rejection_error_code
  WHERE publication_job.tenant_id = tenant_value
    AND publication_job.id = handoff.job_id;

  SELECT target.* INTO target_row
  FROM geo.automation_run_targets AS target
  WHERE target.tenant_id = tenant_value
    AND target.publication_job_id = handoff.job_id
  FOR UPDATE;

  IF target_row.id IS NOT NULL THEN
    SELECT * INTO run_row
    FROM geo.automation_runs AS run
    WHERE run.tenant_id = tenant_value AND run.id = target_row.run_id
    FOR UPDATE;
    SELECT batch.configuration INTO batch_configuration
    FROM geo.automation_batches AS batch
    WHERE batch.tenant_id = tenant_value AND batch.id = run_row.batch_id;
    remediation_enabled := CASE
      WHEN batch_configuration ? 'automationRemediationEnabled'
       AND batch_configuration ->> 'automationRemediationEnabled' IN ('true', 'false')
      THEN (batch_configuration ->> 'automationRemediationEnabled')::boolean
      ELSE true
    END;
    prior_attempt := CASE
      WHEN jsonb_typeof(target_row.remediation -> 'attempt') = 'number'
      THEN greatest(0, (target_row.remediation ->> 'attempt')::integer)
      ELSE 0
    END;
    remediation_attempt := prior_attempt + 1;

    IF reason_code = 'publisher.rejected.soft_advertorial'
       AND remediation_enabled
       AND remediation_attempt <= 2
       AND target_row.state = 'publisher_rejected' THEN
      remediation_plan := jsonb_build_object(
        'taskId', run_row.id::text || ':' || target_row.id::text ||
          ':publisher-remediation:' || remediation_attempt::text,
        'scope', 'target',
        'mode', 'automatic',
        'attempt', remediation_attempt,
        'maxAttempts', 2,
        'reasonCodes', jsonb_build_array(reason_code),
        'actions', jsonb_build_array(
          'change_diversity_blueprint', 'rebuild_article', 'restructure_article',
          'soften_promotion', 'reformat_for_platform', 'replace_media'
        )
      );
      BEGIN
        PERFORM * FROM geo.restart_automation_target_for_remediation(
          run_row.id, target_row.id, remediation_plan
        );
        remediation_requeued := true;
      EXCEPTION WHEN OTHERS THEN
        remediation_error := left(SQLSTATE || ':' || SQLERRM, 1000);
      END;
    END IF;
  END IF;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value,
    actor_value,
    'publication_assisted_handoff.publisher_rejected',
    'publication_assisted_handoff',
    p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    p_evidence_hash,
    jsonb_build_object(
      'platform', handoff.platform,
      'reasonCode', reason_code,
      'errorCode', rejection_error_code,
      'automationRemediationEnabled', remediation_enabled,
      'remediationAttempt', remediation_attempt,
      'remediationRequeued', remediation_requeued,
      'remediationError', remediation_error,
      'submitBoundaryCrossed', true
    )
  );

  RETURN QUERY SELECT 'needs_review'::text, NULL::text, NULL::text;
END
$$;

REVOKE ALL ON FUNCTION geo.record_publication_assisted_publisher_rejection(
  uuid, geo.sha256_hex, text, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_publisher_rejection(
  uuid, geo.sha256_hex, text, timestamptz
) TO geo_runtime;

REVOKE ALL ON FUNCTION geo.restart_automation_target_for_remediation(uuid, uuid, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.restart_automation_target_for_remediation(uuid, uuid, jsonb)
  TO geo_runtime;

COMMENT ON FUNCTION geo.record_publication_assisted_publisher_rejection(
  uuid, geo.sha256_hex, text, timestamptz
) IS
  'Records a platform moderation rejection and requeues at most two fresh soft-advertorial remediations without mutating the rejected article';

COMMIT;
