BEGIN;

-- 0054 reopens the public readback row and handoff, but terminal handoff
-- synchronization can leave the associated publication job in needs_review.
-- The unattended readback claim functions intentionally accept only jobs that
-- are still in the reconciliation path. Restore that path for this migration's
-- explicit marker without re-submitting or changing any other terminal job.
UPDATE geo.publication_jobs AS job
SET state = 'reconciling',
    confirmed_at = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error_code = 'ASSISTED_READBACK_REOPENED',
    updated_at = clock_timestamp()
WHERE job.state = 'needs_review'
  AND job.execution_level = 'unattended'
  AND job.platform = 'ctrip_community'
  AND EXISTS (
    SELECT 1
    FROM geo.publication_assisted_handoffs AS handoff
    WHERE handoff.tenant_id = job.tenant_id
      AND handoff.job_id = job.id
      AND handoff.state = 'readback_pending'
      AND handoff.submit_outcome = 'uncertain'
      AND handoff.submit_permit_consumed_at IS NOT NULL
      AND handoff.last_error_code = 'ASSISTED_READBACK_REOPENED'
      AND handoff.external_id IS NULL
      AND handoff.external_url IS NULL
  );

COMMIT;
