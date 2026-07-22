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
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state
     OR NEW.state NOT IN ('confirmed', 'needs_review', 'failed', 'expired', 'cancelled') THEN
    RETURN NEW;
  END IF;

  terminal_error := COALESCE(
    NULLIF(trim(NEW.last_error_code), ''),
    CASE NEW.state
      WHEN 'expired' THEN 'ASSISTED_HANDOFF_EXPIRED'
      WHEN 'cancelled' THEN 'ASSISTED_HANDOFF_CANCELLED'
      WHEN 'needs_review' THEN 'ASSISTED_HANDOFF_NEEDS_REVIEW'
      WHEN 'failed' THEN 'ASSISTED_HANDOFF_FAILED'
      ELSE NULL
    END
  );
  attempt_outcome := CASE
    WHEN NEW.state = 'confirmed' THEN 'succeeded'
    WHEN NEW.state = 'needs_review' THEN 'uncertain'
    ELSE 'failed'
  END;
  target_job_state := CASE
    WHEN NEW.state = 'confirmed' THEN 'confirmed'
    WHEN NEW.state = 'cancelled' THEN 'cancelled'
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
    AND job.state IN ('queued', 'dispatching', 'retry_wait', 'uncertain', 'reconciling', 'needs_review');

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
      'errorCode', terminal_error
    )
  FROM geo.publication_jobs AS job
  WHERE job.tenant_id = NEW.tenant_id AND job.id = NEW.job_id;

  RETURN NEW;
END
$$;

CREATE TRIGGER publication_assisted_handoff_terminal_sync
AFTER UPDATE OF state ON geo.publication_assisted_handoffs
FOR EACH ROW EXECUTE FUNCTION geo.sync_ctrip_handoff_terminal_job();

-- Repair terminal handoffs created before this trigger existed. The same state
-- mapping is intentionally conservative: a browser-side failure requires review.
WITH terminal_handoffs AS (
  SELECT handoff.*
  FROM geo.publication_assisted_handoffs AS handoff
  WHERE handoff.state IN ('confirmed', 'needs_review', 'failed', 'expired', 'cancelled')
)
UPDATE geo.publication_attempts AS attempt
SET state = CASE
      WHEN handoff.state = 'confirmed' THEN 'succeeded'
      WHEN handoff.state = 'needs_review' THEN 'uncertain'
      ELSE 'failed'
    END,
    response_hash = COALESCE(attempt.response_hash, receipt.response_hash),
    error_code = CASE WHEN handoff.state = 'confirmed' THEN NULL ELSE COALESCE(
      handoff.last_error_code,
      CASE handoff.state
        WHEN 'expired' THEN 'ASSISTED_HANDOFF_EXPIRED'
        WHEN 'cancelled' THEN 'ASSISTED_HANDOFF_CANCELLED'
        WHEN 'needs_review' THEN 'ASSISTED_HANDOFF_NEEDS_REVIEW'
        ELSE 'ASSISTED_HANDOFF_FAILED'
      END
    ) END,
    error_message = CASE WHEN handoff.state = 'confirmed' THEN NULL ELSE left(COALESCE(
      handoff.last_error_message,
      handoff.last_error_code,
      'Ctrip handoff reached a terminal state'
    ), 4000) END,
    finished_at = COALESCE(handoff.readback_observed_at, handoff.updated_at),
    governance_finished_at = COALESCE(handoff.readback_observed_at, handoff.updated_at)
FROM terminal_handoffs AS handoff
LEFT JOIN geo.publication_receipts AS receipt
  ON receipt.tenant_id = handoff.tenant_id AND receipt.id = handoff.publication_receipt_id
WHERE attempt.tenant_id = handoff.tenant_id
  AND attempt.id = handoff.attempt_id
  AND attempt.job_id = handoff.job_id
  AND attempt.state = 'started';

WITH terminal_handoffs AS (
  SELECT handoff.*
  FROM geo.publication_assisted_handoffs AS handoff
  WHERE handoff.state IN ('confirmed', 'needs_review', 'failed', 'expired', 'cancelled')
)
UPDATE geo.publication_jobs AS job
SET state = CASE
      WHEN handoff.state = 'confirmed' THEN 'confirmed'
      WHEN handoff.state = 'cancelled' THEN 'cancelled'
      ELSE 'needs_review'
    END,
    lease_owner = NULL,
    lease_expires_at = NULL,
    confirmed_at = CASE WHEN handoff.state = 'confirmed'
      THEN COALESCE(handoff.readback_observed_at, handoff.updated_at)
      ELSE NULL
    END,
    cancelled_at = CASE WHEN handoff.state = 'cancelled'
      THEN COALESCE(handoff.cancelled_at, handoff.updated_at)
      ELSE job.cancelled_at
    END,
    cancelled_by_actor_id = CASE WHEN handoff.state = 'cancelled'
      THEN handoff.cancelled_by_actor_id
      ELSE job.cancelled_by_actor_id
    END,
    cancellation_reason = CASE WHEN handoff.state = 'cancelled'
      THEN COALESCE(handoff.cancellation_reason, 'Ctrip handoff cancelled')
      ELSE job.cancellation_reason
    END,
    last_error_code = CASE WHEN handoff.state = 'confirmed' THEN NULL ELSE COALESCE(
      handoff.last_error_code,
      CASE handoff.state
        WHEN 'expired' THEN 'ASSISTED_HANDOFF_EXPIRED'
        WHEN 'cancelled' THEN 'ASSISTED_HANDOFF_CANCELLED'
        WHEN 'needs_review' THEN 'ASSISTED_HANDOFF_NEEDS_REVIEW'
        ELSE 'ASSISTED_HANDOFF_FAILED'
      END
    ) END,
    updated_at = COALESCE(handoff.readback_observed_at, handoff.updated_at)
FROM terminal_handoffs AS handoff
WHERE job.tenant_id = handoff.tenant_id
  AND job.id = handoff.job_id
  AND job.state IN ('queued', 'dispatching', 'retry_wait', 'uncertain', 'reconciling', 'needs_review');

REVOKE ALL ON FUNCTION geo.sync_ctrip_handoff_terminal_job() FROM PUBLIC;
