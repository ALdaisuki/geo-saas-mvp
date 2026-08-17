-- The adapter evidence expiry gate was retired in 0056, but an old Worker
-- could still dead-letter publication jobs before creating a handoff. Reopen
-- only those zero-external-write jobs so the corrected Worker can continue the
-- existing automation run without creating duplicate content or submissions.

CREATE TEMPORARY TABLE obsolete_ctrip_evidence_recovery
ON COMMIT DROP
AS
SELECT job.tenant_id,
       job.id AS job_id,
       job.request_hash,
       run.id AS run_id,
       target.id AS target_id,
       batch.id AS batch_id,
       batch.created_by_actor_id AS actor_id,
       event.id AS event_id
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
JOIN geo.outbox_events AS event
  ON event.tenant_id = job.tenant_id
 AND event.aggregate_type = 'publication_job'
 AND event.aggregate_id = job.id
 AND event.topic = 'publication.requested'
WHERE job.platform = 'ctrip_community'
  AND job.execution_level IN ('assisted', 'unattended')
  AND job.state = 'permanent_failure'
  AND job.last_error_code = 'CTRIP_ASSISTED_ADAPTER_EVIDENCE_EXPIRED'
  AND target.state = 'delivery_failed'
  AND target.last_error_code = 'CTRIP_ASSISTED_ADAPTER_EVIDENCE_EXPIRED'
  AND run.state = 'delivery_failed'
  AND run.last_error_code = 'AUTOMATION_DELIVERY_FAILED'
  AND run.attempt_count < run.max_attempts
  AND batch.state IN ('running', 'partially_failed')
  AND event.published_at IS NULL
  AND event.dead_lettered_at IS NOT NULL
  AND event.last_error LIKE 'CTRIP_ASSISTED_ADAPTER_EVIDENCE_EXPIRED:%'
  AND EXISTS (
    SELECT 1
    FROM geo.publication_attempts AS attempt
    WHERE attempt.tenant_id = job.tenant_id
      AND attempt.job_id = job.id
      AND attempt.state = 'failed'
      AND attempt.error_code = 'CTRIP_ASSISTED_ADAPTER_EVIDENCE_EXPIRED'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM geo.publication_assisted_handoffs AS handoff
    WHERE handoff.tenant_id = job.tenant_id
      AND handoff.job_id = job.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM geo.publication_receipts AS receipt
    WHERE receipt.tenant_id = job.tenant_id
      AND receipt.job_id = job.id
  );

UPDATE geo.automation_run_targets AS target
SET state = 'awaiting_delivery',
    completed_at = NULL,
    last_error_code = NULL,
    last_error_message = NULL
FROM obsolete_ctrip_evidence_recovery AS recovery
WHERE target.tenant_id = recovery.tenant_id
  AND target.id = recovery.target_id;

UPDATE geo.automation_runs AS run
SET state = 'awaiting_delivery',
    stage = 'delivery',
    available_at = clock_timestamp(),
    lease_owner = NULL,
    lease_expires_at = NULL,
    completed_at = NULL,
    last_error_code = NULL,
    last_error_message = NULL
FROM obsolete_ctrip_evidence_recovery AS recovery
WHERE run.tenant_id = recovery.tenant_id
  AND run.id = recovery.run_id;

UPDATE geo.publication_jobs AS job
SET state = 'retry_wait',
    available_at = clock_timestamp(),
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error_code = NULL
FROM obsolete_ctrip_evidence_recovery AS recovery
WHERE job.tenant_id = recovery.tenant_id
  AND job.id = recovery.job_id;

UPDATE geo.outbox_events AS event
SET available_at = clock_timestamp(),
    locked_by = NULL,
    locked_until = NULL,
    dead_lettered_at = NULL,
    last_error = NULL
FROM obsolete_ctrip_evidence_recovery AS recovery
WHERE event.tenant_id = recovery.tenant_id
  AND event.id = recovery.event_id;

UPDATE geo.automation_batches AS batch
SET state = 'running',
    completed_at = NULL
WHERE (batch.tenant_id, batch.id) IN (
  SELECT recovery.tenant_id, recovery.batch_id
  FROM obsolete_ctrip_evidence_recovery AS recovery
);

INSERT INTO geo.audit_log (
  tenant_id, actor_id, action, resource_type, resource_id,
  request_id, before_hash, after_hash, details
)
SELECT recovery.tenant_id,
       recovery.actor_id,
       'publication_job.obsolete_adapter_evidence_failure_reopened',
       'publication_job',
       recovery.job_id,
       'migration:0059:' || recovery.job_id::text,
       recovery.request_hash,
       recovery.request_hash,
       jsonb_build_object(
         'automationRunId', recovery.run_id,
         'automationTargetId', recovery.target_id,
         'previousErrorCode', 'CTRIP_ASSISTED_ADAPTER_EVIDENCE_EXPIRED',
         'publicationJobState', 'retry_wait',
         'automationRunState', 'awaiting_delivery',
         'externalWriteObserved', false,
         'failedAttemptPreserved', true
       )
FROM obsolete_ctrip_evidence_recovery AS recovery;

