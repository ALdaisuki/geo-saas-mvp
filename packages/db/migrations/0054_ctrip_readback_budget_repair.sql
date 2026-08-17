BEGIN;

-- Readback-pending uncertain submissions are still awaiting an independent public
-- observation. They must not consume the account's delivery error budget, and a
-- gate denial is a control result rather than a platform execution failure.
DO $$
DECLARE
  function_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'geo.acquire_publication_execution(uuid,uuid,text)'::regprocedure
  ) INTO function_definition;
  IF function_definition IS NULL
     OR position('attempt.state IN (''failed'', ''uncertain'')' IN function_definition) = 0 THEN
    RAISE EXCEPTION 'publication acquire function drifted before 0054';
  END IF;
  IF position('readback_handoff.state IN (''readback_pending'', ''confirmed'')' IN function_definition) = 0 THEN
    function_definition := replace(
      function_definition,
      $needle$attempt.state IN ('failed', 'uncertain')$needle$,
      $replacement$attempt.state IN ('failed', 'uncertain')
              AND attempt.error_code IS DISTINCT FROM 'PUBLICATION_GATE_BLOCKED'
              AND NOT EXISTS (
                SELECT 1
                FROM geo.publication_assisted_handoffs AS readback_handoff
                WHERE readback_handoff.tenant_id = attempt.tenant_id
                  AND readback_handoff.attempt_id = attempt.id
                  AND readback_handoff.state IN ('readback_pending', 'confirmed')
              )$replacement$
    );
  END IF;
  IF position('readback_handoff.state IN (''readback_pending'', ''confirmed'')' IN function_definition) = 0 THEN
    RAISE EXCEPTION 'publication acquire function was not patched by 0054';
  END IF;
  EXECUTE function_definition;
END
$$;

DO $$
DECLARE
  function_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'geo.finish_publication_execution(uuid,uuid,text,text)'::regprocedure
  ) INTO function_definition;
  IF function_definition IS NULL
     OR position('prior_attempt.state IN (''failed'', ''uncertain'')' IN function_definition) = 0 THEN
    RAISE EXCEPTION 'publication finish function drifted before 0054';
  END IF;
  IF position('readback_handoff.state IN (''readback_pending'', ''confirmed'')' IN function_definition) = 0 THEN
    function_definition := replace(
      function_definition,
      $needle$prior_attempt.state IN ('failed', 'uncertain')$needle$,
      $replacement$prior_attempt.state IN ('failed', 'uncertain')
          AND prior_attempt.error_code IS DISTINCT FROM 'PUBLICATION_GATE_BLOCKED'
          AND NOT EXISTS (
            SELECT 1
            FROM geo.publication_assisted_handoffs AS readback_handoff
            WHERE readback_handoff.tenant_id = prior_attempt.tenant_id
              AND readback_handoff.attempt_id = prior_attempt.id
              AND readback_handoff.state IN ('readback_pending', 'confirmed')
          )$replacement$
    );
  END IF;
  IF position('readback_handoff.state IN (''readback_pending'', ''confirmed'')' IN function_definition) = 0 THEN
    RAISE EXCEPTION 'publication finish function was not patched by 0054';
  END IF;
  EXECUTE function_definition;
END
$$;

-- Reopen only uncertain, identity-less readbacks. The submit permit and browser
-- evidence remain intact, so this never issues a second platform submission.
ALTER TABLE geo.publication_assisted_handoffs
  DISABLE TRIGGER publication_assisted_handoffs_transition_only;

UPDATE geo.publication_readbacks AS readback
SET status = 'pending',
    completed_at = NULL,
    last_error = NULL,
    updated_at = clock_timestamp()
WHERE readback.id IN (
  SELECT handoff.publication_readback_id
  FROM geo.publication_assisted_handoffs AS handoff
  JOIN geo.publication_jobs AS job
    ON job.tenant_id = handoff.tenant_id AND job.id = handoff.job_id
  WHERE handoff.state = 'needs_review'
    AND handoff.submit_outcome = 'uncertain'
    AND handoff.readback_outcome = 'unavailable'
    AND handoff.external_id IS NULL
    AND handoff.external_url IS NULL
    AND job.execution_level = 'unattended'
);

UPDATE geo.publication_assisted_handoffs AS handoff
SET state = 'readback_pending',
    readback_owner_principal_id = NULL,
    readback_lease_expires_at = NULL,
    last_error_code = 'ASSISTED_READBACK_REOPENED',
    last_error_message = 'Uncertain submission reopened for refreshed public readback'
FROM geo.publication_jobs AS job
WHERE handoff.job_id = job.id
  AND handoff.tenant_id = job.tenant_id
  AND handoff.state = 'needs_review'
  AND handoff.submit_outcome = 'uncertain'
  AND handoff.readback_outcome = 'unavailable'
  AND handoff.external_id IS NULL
  AND handoff.external_url IS NULL
  AND job.execution_level = 'unattended';

-- The readback-budget trigger intentionally resets the counter and applies its
-- default deadline whenever state enters readback_pending. Extend that deadline
-- in a separate update so the migration's delayed-readback window is retained.
UPDATE geo.publication_assisted_handoffs AS handoff
SET readback_attempt_count = 0,
    readback_deadline_at = clock_timestamp() + interval '60 minutes'
FROM geo.publication_jobs AS job
WHERE handoff.job_id = job.id
  AND handoff.tenant_id = job.tenant_id
  AND handoff.state = 'readback_pending'
  AND handoff.last_error_code = 'ASSISTED_READBACK_REOPENED'
  AND job.execution_level = 'unattended';

ALTER TABLE geo.publication_assisted_handoffs
  ENABLE TRIGGER publication_assisted_handoffs_transition_only;

COMMIT;
