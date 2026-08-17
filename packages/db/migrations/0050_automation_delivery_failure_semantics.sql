-- Separate pre-gate execution failures from failures observed after a platform
-- publication request. A delivery failure is still a terminal automation
-- result, but it must not be reported as a content or governance run failure.

ALTER TABLE geo.automation_runs
  DROP CONSTRAINT automation_runs_state_check;

ALTER TABLE geo.automation_runs
  ADD CONSTRAINT automation_runs_state_check
  CHECK (state IN (
    'scheduled', 'running', 'retry_wait', 'awaiting_delivery', 'completed',
    'partially_failed', 'delivery_failed', 'blocked', 'failed', 'cancelled'
  ));

ALTER TABLE geo.automation_run_targets
  DROP CONSTRAINT automation_run_targets_state_check;

ALTER TABLE geo.automation_run_targets
  ADD CONSTRAINT automation_run_targets_state_check
  CHECK (state IN (
    'pending', 'variant_ready', 'audit_failed', 'awaiting_delivery',
    'preview_completed', 'confirmed', 'delivery_failed', 'blocked', 'failed',
    'cancelled'
  ));

DO $$
DECLARE
  function_definition text;
  marker text;
BEGIN
  SELECT pg_get_functiondef(
    'geo.checkpoint_automation_target(uuid,uuid,text,integer,text,uuid,uuid,uuid,uuid,text,text,jsonb,integer)'::regprocedure
  ) INTO function_definition;
  IF function_definition IS NULL
     OR position('automation target transition' IN function_definition) = 0 THEN
    RAISE EXCEPTION 'automation target checkpoint function drifted before 0050';
  END IF;

  function_definition := replace(
    function_definition,
    $needle$'preview_completed', 'confirmed', 'blocked', 'failed', 'cancelled'$needle$,
    $replacement$'preview_completed', 'confirmed', 'delivery_failed', 'blocked', 'failed', 'cancelled'$replacement$
  );
  function_definition := replace(
    function_definition,
    $needle$'audit_failed', 'blocked', 'failed'$needle$,
    $replacement$'audit_failed', 'delivery_failed', 'blocked', 'failed'$replacement$
  );
  function_definition := replace(
    function_definition,
    $needle$'preview_completed', 'confirmed', 'audit_failed', 'blocked', 'failed'$needle$,
    $replacement$'preview_completed', 'confirmed', 'delivery_failed', 'audit_failed', 'blocked', 'failed'$replacement$
  );
  function_definition := replace(
    function_definition,
    $needle$WHEN p_new_state IN ('awaiting_delivery', 'preview_completed', 'confirmed') THEN 'delivery'$needle$,
    $replacement$WHEN p_new_state IN ('awaiting_delivery', 'preview_completed', 'confirmed', 'delivery_failed') THEN 'delivery'$replacement$
  );

  marker := $marker$  IF p_new_state IN ('audit_failed', 'delivery_failed', 'blocked', 'failed') AND
     (p_error_code IS NULL OR length(trim(p_error_code)) = 0) THEN$marker$;
  IF position(marker IN function_definition) = 0 THEN
    RAISE EXCEPTION 'automation target checkpoint failure marker drifted before 0050';
  END IF;
  function_definition := replace(
    function_definition,
    marker,
    $replacement$  IF p_new_state = 'delivery_failed' AND (
    publication_job_value IS NULL OR NOT EXISTS (
      SELECT 1
      FROM geo.publication_jobs AS job
      WHERE job.tenant_id = tenant_value
        AND job.id = publication_job_value
        AND job.state IN ('needs_review', 'permanent_failure')
    )
  ) THEN
    RAISE EXCEPTION 'delivery_failed requires a terminal publication delivery failure'
      USING ERRCODE = '23514';
  END IF;

  IF p_new_state IN ('audit_failed', 'delivery_failed', 'blocked', 'failed') AND
     (p_error_code IS NULL OR length(trim(p_error_code)) = 0) THEN$replacement$
  );
  EXECUTE function_definition;
END
$$;

DO $$
DECLARE
  function_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'geo.reconcile_automation_run(uuid,text,integer,integer,text,text)'::regprocedure
  ) INTO function_definition;
  IF function_definition IS NULL
     OR position('unfinished automation targets require an explicit retry delay' IN function_definition) = 0 THEN
    RAISE EXCEPTION 'automation run reconciliation function drifted before 0050';
  END IF;

  function_definition := replace(
    function_definition,
    E'  failure_count integer;\n  next_state text;',
    E'  failure_count integer;\n  delivery_failure_count integer;\n  next_state text;'
  );
  function_definition := replace(
    function_definition,
    $needle$         count(*) FILTER (
           WHERE target.state IN ('audit_failed', 'blocked', 'failed', 'cancelled')
         )::integer
  INTO target_count, unfinished_count, awaiting_count, success_count, failure_count$needle$,
    $replacement$         count(*) FILTER (
           WHERE target.state IN ('audit_failed', 'blocked', 'failed', 'delivery_failed', 'cancelled')
         )::integer,
         count(*) FILTER (WHERE target.state = 'delivery_failed')::integer
  INTO target_count, unfinished_count, awaiting_count, success_count, failure_count, delivery_failure_count$replacement$
  );
  function_definition := replace(
    function_definition,
    $needle$  ELSIF success_count > 0 AND failure_count > 0 THEN$needle$,
    $replacement$  ELSIF delivery_failure_count = failure_count AND failure_count > 0 THEN
    next_state := 'delivery_failed';
    available_value := run_row.available_at;
    completed_value := clock_timestamp();
  ELSIF success_count > 0 AND failure_count > 0 THEN$replacement$
  );
  function_definition := replace(
    function_definition,
    $needle$WHEN next_state IN ('awaiting_delivery', 'completed', 'partially_failed')$needle$,
    $replacement$WHEN next_state IN ('awaiting_delivery', 'completed', 'partially_failed', 'delivery_failed')$replacement$
  );
  function_definition := replace(
    function_definition,
    $needle$    WHEN next_state = 'awaiting_delivery' THEN NULL$needle$,
    $replacement$    WHEN next_state = 'awaiting_delivery' THEN NULL
    WHEN next_state = 'delivery_failed' THEN 'AUTOMATION_DELIVERY_FAILED'$replacement$
  );
  EXECUTE function_definition;
END
$$;

-- Reopen only uncertain, no-identity observations. The submit permit and
-- browser evidence remain intact, so the bridge can continue readback without
-- ever issuing another submit action.
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

UPDATE geo.publication_jobs AS job
SET state = 'uncertain',
    confirmed_at = NULL,
    last_error_code = 'ASSISTED_READBACK_REOPENED',
    updated_at = clock_timestamp()
WHERE job.id IN (
  SELECT handoff.job_id
  FROM geo.publication_assisted_handoffs AS handoff
  JOIN geo.publication_jobs AS candidate_job
    ON candidate_job.tenant_id = handoff.tenant_id AND candidate_job.id = handoff.job_id
  WHERE handoff.state = 'needs_review'
    AND handoff.submit_outcome = 'uncertain'
    AND handoff.readback_outcome = 'unavailable'
    AND handoff.external_id IS NULL
    AND handoff.external_url IS NULL
    AND candidate_job.execution_level = 'unattended'
);

ALTER TABLE geo.publication_assisted_handoffs
  DISABLE TRIGGER publication_assisted_handoffs_transition_only;

UPDATE geo.publication_assisted_handoffs AS handoff
SET state = 'readback_pending',
    readback_deadline_at = GREATEST(
      COALESCE(handoff.readback_deadline_at, clock_timestamp()),
      clock_timestamp() + interval '60 minutes'
    ),
    readback_owner_principal_id = NULL,
    readback_lease_expires_at = NULL,
    last_error_code = 'ASSISTED_READBACK_REOPENED',
    last_error_message = 'Uncertain submission reopened for delayed public readback',
    updated_at = clock_timestamp()
FROM geo.publication_jobs AS job
WHERE handoff.job_id = job.id
  AND handoff.tenant_id = job.tenant_id
  AND handoff.state = 'needs_review'
  AND handoff.submit_outcome = 'uncertain'
  AND handoff.readback_outcome = 'unavailable'
  AND handoff.external_id IS NULL
  AND handoff.external_url IS NULL
  AND job.execution_level = 'unattended';

ALTER TABLE geo.publication_assisted_handoffs
  ENABLE TRIGGER publication_assisted_handoffs_transition_only;

COMMENT ON COLUMN geo.automation_run_targets.state IS
  'Delivery failures are distinct from pre-gate failed/blocked targets';
