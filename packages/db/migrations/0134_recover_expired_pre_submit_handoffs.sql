BEGIN;

-- A prepared browser draft is not evidence of a platform submission. Recover
-- expired pre-submit handoffs as manual-review work so they cannot retain a
-- publication execution lease forever or be automatically submitted later.
CREATE OR REPLACE FUNCTION geo.expire_stale_publication_assisted_handoffs(
  p_max_count integer DEFAULT 100
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  stale_handoff record;
  expired_count integer := 0;
BEGIN
  IF p_max_count IS NULL OR p_max_count NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'stale handoff sweep count must be between 1 and 500'
      USING ERRCODE = '22023';
  END IF;

  FOR stale_handoff IN
    SELECT candidate.id,
           candidate.job_id,
           candidate.attempt_id,
           candidate.state AS state_before,
           candidate.preview_hash
    FROM geo.publication_assisted_handoffs AS candidate
    WHERE candidate.tenant_id = tenant_value
      AND (
        candidate.state IN ('handoff_pending', 'session_required', 'challenge_required')
        OR candidate.state IN ('draft_prepared', 'awaiting_operator_submit')
      )
      AND candidate.submit_permit_consumed_at IS NULL
      AND candidate.expires_at <= statement_timestamp()
    ORDER BY candidate.created_at, candidate.id
    LIMIT p_max_count
    FOR UPDATE OF candidate SKIP LOCKED
  LOOP
    UPDATE geo.publication_assisted_handoffs AS handoff
    SET state = 'expired',
        lease_owner_actor_id = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NULL,
        draft_prepare_owner_principal_id = NULL,
        draft_prepare_lease_expires_at = NULL,
        submit_permit_hash = NULL,
        submit_permit_expires_at = NULL,
        submit_permit_consumed_at = NULL,
        submit_permit_issued_by_actor_id = NULL,
        submit_permit_issued_by_principal_id = NULL,
        submit_permit_consumed_by_principal_id = NULL,
        last_error_code = CASE
          WHEN handoff.state IN ('draft_prepared', 'awaiting_operator_submit')
            THEN 'ASSISTED_PRE_SUBMIT_HANDOFF_EXPIRED'
          ELSE COALESCE(NULLIF(trim(handoff.last_error_code), ''), 'ASSISTED_HANDOFF_EXPIRED')
        END,
        last_error_message = CASE
          WHEN handoff.state IN ('draft_prepared', 'awaiting_operator_submit')
            THEN 'browser draft expired before a submit permit was consumed'
          ELSE COALESCE(
            NULLIF(trim(handoff.last_error_message), ''),
            'assisted handoff expired before preparation completed'
          )
        END,
        updated_at = clock_timestamp()
    WHERE handoff.tenant_id = tenant_value
      AND handoff.id = stale_handoff.id
      AND (
        handoff.state IN ('handoff_pending', 'session_required', 'challenge_required')
        OR handoff.state IN ('draft_prepared', 'awaiting_operator_submit')
      )
      AND handoff.submit_permit_consumed_at IS NULL
      AND handoff.expires_at <= statement_timestamp();

    IF FOUND THEN
      UPDATE geo.publication_attempts AS publication_attempt
      SET state = 'failed',
          error_code = 'ASSISTED_PRE_SUBMIT_HANDOFF_EXPIRED',
          error_message = 'browser handoff expired before platform submission',
          finished_at = clock_timestamp()
      WHERE publication_attempt.tenant_id = tenant_value
        AND publication_attempt.id = stale_handoff.attempt_id
        AND publication_attempt.job_id = stale_handoff.job_id
        AND publication_attempt.state = 'started';

      UPDATE geo.publication_jobs AS publication_job
      SET state = 'needs_review',
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error_code = 'ASSISTED_PRE_SUBMIT_HANDOFF_EXPIRED'
      WHERE publication_job.tenant_id = tenant_value
        AND publication_job.id = stale_handoff.job_id
        AND publication_job.state = 'dispatching';

      INSERT INTO geo.audit_log (
        tenant_id, actor_id, action, resource_type, resource_id,
        request_id, after_hash, details
      ) VALUES (
        tenant_value,
        actor_value,
        'publication_assisted_handoff.expired_stale',
        'publication_assisted_handoff',
        stale_handoff.id,
        COALESCE(NULLIF(current_setting('app.request_id', true), ''), stale_handoff.id::text),
        stale_handoff.preview_hash,
        jsonb_build_object(
          'handoffStateBefore', stale_handoff.state_before,
          'jobId', stale_handoff.job_id,
          'attemptId', stale_handoff.attempt_id,
          'preSubmit', true
        )
      );
      expired_count := expired_count + 1;
    END IF;
  END LOOP;

  RETURN expired_count;
END
$$;

REVOKE ALL ON FUNCTION geo.expire_stale_publication_assisted_handoffs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.expire_stale_publication_assisted_handoffs(integer) TO geo_runtime;

COMMENT ON FUNCTION geo.expire_stale_publication_assisted_handoffs(integer) IS
  'Expires abandoned pre-submit browser handoffs, releases their execution lease, and routes them to manual review without resubmitting';

COMMIT;
