-- Repair handoffs that committed successfully before the worker lost the SQL
-- response and incorrectly marked the same attempt as failed.

WITH repairable AS (
  SELECT handoff.tenant_id, handoff.id AS handoff_id,
         handoff.job_id, handoff.attempt_id
  FROM geo.publication_assisted_handoffs AS handoff
  JOIN geo.publication_jobs AS job
    ON job.tenant_id = handoff.tenant_id AND job.id = handoff.job_id
  JOIN geo.publication_attempts AS attempt
    ON attempt.tenant_id = handoff.tenant_id
   AND attempt.id = handoff.attempt_id
   AND attempt.job_id = handoff.job_id
  WHERE handoff.state NOT IN ('confirmed', 'needs_review', 'cancelled', 'expired', 'failed')
    AND handoff.submit_permit_consumed_at IS NULL
    AND job.state IN ('retry_wait', 'permanent_failure')
    AND attempt.state = 'failed'
)
UPDATE geo.publication_attempts AS attempt
SET state = 'started',
    response_hash = NULL,
    error_code = NULL,
    error_message = NULL,
    finished_at = NULL,
    governance_finished_at = NULL
FROM repairable
WHERE attempt.tenant_id = repairable.tenant_id
  AND attempt.id = repairable.attempt_id
  AND attempt.job_id = repairable.job_id;

WITH repairable AS (
  SELECT handoff.tenant_id, handoff.id AS handoff_id,
         handoff.job_id, handoff.attempt_id, handoff.created_by_actor_id,
         job.request_hash, job.state AS previous_job_state
  FROM geo.publication_assisted_handoffs AS handoff
  JOIN geo.publication_jobs AS job
    ON job.tenant_id = handoff.tenant_id AND job.id = handoff.job_id
  JOIN geo.publication_attempts AS attempt
    ON attempt.tenant_id = handoff.tenant_id
   AND attempt.id = handoff.attempt_id
   AND attempt.job_id = handoff.job_id
  WHERE handoff.state NOT IN ('confirmed', 'needs_review', 'cancelled', 'expired', 'failed')
    AND handoff.submit_permit_consumed_at IS NULL
    AND job.state IN ('retry_wait', 'permanent_failure')
    AND attempt.state = 'started'
), repaired AS (
  UPDATE geo.publication_jobs AS job
  SET state = 'dispatching',
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error_code = NULL,
      updated_at = clock_timestamp()
  FROM repairable
  WHERE job.tenant_id = repairable.tenant_id
    AND job.id = repairable.job_id
  RETURNING repairable.*
)
INSERT INTO geo.audit_log (
  tenant_id, actor_id, action, resource_type, resource_id,
  request_id, before_hash, after_hash, details
)
SELECT tenant_id, created_by_actor_id,
       'publication_assisted_handoff.commit_response_recovered',
       'publication_job', job_id, handoff_id::text,
       request_hash, request_hash,
       jsonb_build_object(
         'handoffId', handoff_id,
         'attemptId', attempt_id,
         'previousJobState', previous_job_state,
         'jobState', 'dispatching',
         'externalWriteObserved', false,
         'submitPermitConsumed', false
       )
FROM repaired;
