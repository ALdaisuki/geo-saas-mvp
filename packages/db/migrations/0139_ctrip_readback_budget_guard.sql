BEGIN;

-- A Ctrip handoff must never be claimed after its public-readback deadline or
-- after the database-enforced attempt budget. The previous account-scoped
-- claimer intentionally bypassed the deadline for Ctrip, which allowed the
-- poller to write attempt 101 and fail the CHECK constraint. Close exhausted
-- rows before claiming new work so they become an explicit operator-review
-- outcome instead of a repeating background error.
CREATE OR REPLACE FUNCTION geo.expire_ctrip_readback_budget()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  candidate geo.publication_assisted_handoffs%ROWTYPE;
  processed_count integer := 0;
BEGIN
  FOR candidate IN
    SELECT handoff.*
    FROM geo.publication_assisted_handoffs AS handoff
    JOIN geo.publication_jobs AS job
      ON job.tenant_id = handoff.tenant_id AND job.id = handoff.job_id
    WHERE handoff.tenant_id = tenant_value
      AND handoff.platform = 'ctrip_community'
      AND handoff.state = 'readback_pending'
      AND (
        handoff.readback_attempt_count >= 100
        OR handoff.readback_deadline_at <= statement_timestamp()
      )
      AND handoff.external_id IS NULL
      AND handoff.external_url IS NULL
      AND job.platform = handoff.platform
    FOR UPDATE OF handoff SKIP LOCKED
  LOOP
    UPDATE geo.publication_assisted_handoffs AS handoff
    SET state = 'needs_review',
        readback_outcome = COALESCE(handoff.readback_outcome, 'unavailable'),
        readback_owner_principal_id = NULL,
        readback_lease_expires_at = NULL,
        last_error_code = CASE
          WHEN candidate.readback_attempt_count >= 100
            THEN 'ASSISTED_READBACK_ATTEMPTS_EXHAUSTED'
          ELSE 'ASSISTED_READBACK_DEADLINE_EXCEEDED'
        END,
        last_error_message = CASE
          WHEN candidate.readback_attempt_count >= 100
            THEN 'Ctrip public readback attempt budget was exhausted; operator review is required'
          ELSE 'Ctrip public readback window expired; operator review is required'
        END
    WHERE handoff.tenant_id = tenant_value AND handoff.id = candidate.id;

    UPDATE geo.publication_readbacks AS readback
    SET status = 'failed',
        completed_at = COALESCE(readback.completed_at, clock_timestamp()),
        last_error = CASE
          WHEN candidate.readback_attempt_count >= 100
            THEN 'ASSISTED_READBACK_ATTEMPTS_EXHAUSTED'
          ELSE 'ASSISTED_READBACK_DEADLINE_EXCEEDED'
        END
    WHERE readback.tenant_id = tenant_value
      AND readback.id = candidate.publication_readback_id;

    INSERT INTO geo.audit_log (
      tenant_id, actor_id, action, resource_type, resource_id,
      request_id, after_hash, details
    ) VALUES (
      tenant_value,
      geo.require_actor_id(),
      'publication_assisted_handoff.readback_budget_exhausted',
      'publication_assisted_handoff',
      candidate.id,
      COALESCE(NULLIF(current_setting('app.request_id', true), ''), candidate.id::text),
      candidate.preview_hash,
      jsonb_build_object(
        'platform', candidate.platform,
        'attemptCount', candidate.readback_attempt_count,
        'attemptLimit', 100,
        'deadlineAt', candidate.readback_deadline_at,
        'reason', CASE
          WHEN candidate.readback_attempt_count >= 100
            THEN 'attempt_budget_exhausted'
          ELSE 'deadline_exceeded'
        END,
        'automaticRetryAllowed', false
      )
    );

    processed_count := processed_count + 1;
  END LOOP;

  RETURN processed_count;
END
$$;

DO $claim$
DECLARE
  definition text;
  old_guard text := $needle$    AND (
      candidate.platform = 'ctrip_community'
      OR candidate.readback_deadline_at >= statement_timestamp()
    )$needle$;
BEGIN
  SELECT pg_get_functiondef('geo.claim_next_ctrip_unattended_readback()'::regprocedure)
    INTO definition;
  IF definition IS NULL
     OR position('PERFORM geo.expire_priority_platform_readback_windows();' IN definition) = 0
     OR position(old_guard IN definition) = 0 THEN
    RAISE EXCEPTION 'Ctrip readback claim drifted before 0139';
  END IF;

  definition := replace(
    definition,
    'PERFORM geo.expire_priority_platform_readback_windows();',
    'PERFORM geo.expire_priority_platform_readback_windows();
  PERFORM geo.expire_ctrip_readback_budget();'
  );
  definition := replace(
    definition,
    old_guard,
    $replacement$    AND candidate.readback_deadline_at >= statement_timestamp()
    AND candidate.readback_attempt_count < 100$replacement$
  );

  IF position(old_guard IN definition) <> 0
     OR position('candidate.readback_attempt_count < 100' IN definition) = 0
     OR position('PERFORM geo.expire_ctrip_readback_budget();' IN definition) = 0 THEN
    RAISE EXCEPTION 'Ctrip readback claim budget guard was not installed';
  END IF;
  EXECUTE definition;
END
$claim$;

REVOKE ALL ON FUNCTION geo.expire_ctrip_readback_budget() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.expire_ctrip_readback_budget() TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.claim_next_ctrip_unattended_readback() TO geo_runtime;

COMMENT ON FUNCTION geo.expire_ctrip_readback_budget() IS
  'Moves expired or exhausted Ctrip public-readback handoffs to explicit operator review without another browser claim';

COMMENT ON FUNCTION geo.claim_next_ctrip_unattended_readback() IS
  'Claims Ctrip readback only before its deadline and finite attempt budget';

COMMIT;
