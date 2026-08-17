BEGIN;

-- Awaiting delivery is an external publication state, not an expired worker
-- lease. A run may legitimately reach its processing-attempt limit immediately
-- after creating the publication job and must remain available for terminal
-- publication synchronization.
DO $$
DECLARE
  function_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'geo.claim_automation_runs(text,integer,integer)'::regprocedure
  ) INTO function_definition;
  IF function_definition IS NULL THEN
    RAISE EXCEPTION 'automation claim function is unavailable before 0068';
  END IF;

  IF position(
    '(run.state IN (''retry_wait'', ''awaiting_delivery'') AND'
    IN function_definition
  ) > 0 THEN
    function_definition := replace(
      function_definition,
      $needle$(run.state IN ('retry_wait', 'awaiting_delivery') AND
         run.available_at <= statement_timestamp())$needle$,
      $replacement$(run.state = 'retry_wait' AND
         run.available_at <= statement_timestamp())$replacement$
    );
  END IF;

  IF position(
    '(run.state IN (''retry_wait'', ''awaiting_delivery'') AND'
    IN function_definition
  ) > 0 OR position(
    '(run.state = ''retry_wait'' AND'
    IN function_definition
  ) = 0 THEN
    RAISE EXCEPTION 'automation delivery-wait exhaustion guard was not patched by 0068';
  END IF;
  EXECUTE function_definition;
END
$$;

-- Tenant controls provide the default error-budget value, but account health
-- is isolated. A misconfigured account must not consume the budget of another
-- account while tenant-wide rate and daily publication quotas remain global.
DO $$
DECLARE
  function_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'geo.acquire_publication_execution(uuid,uuid,text)'::regprocedure
  ) INTO function_definition;
  IF function_definition IS NULL THEN
    RAISE EXCEPTION 'publication acquire function is unavailable before 0068';
  END IF;

  IF position(
    'control_row.scope_type <> ''tenant''' IN function_definition
  ) = 0 THEN
    IF position(
      'AND attempt.started_at >= now_value - interval ''1 day'''
      IN function_definition
    ) = 0 THEN
      RAISE EXCEPTION 'publication error-budget counter drifted before 0068';
    END IF;
    function_definition := replace(
      function_definition,
      $needle$            AND attempt.started_at >= now_value - interval '1 day'$needle$,
      $replacement$            AND (control_row.scope_type <> 'tenant'
                 OR prior_job.channel_account_id = job_row.channel_account_id)
            AND attempt.started_at >= now_value - interval '1 day'$replacement$
    );
  END IF;

  IF position(
    'control_row.scope_type <> ''tenant''' IN function_definition
  ) = 0 OR position(
    'prior_job.channel_account_id = job_row.channel_account_id'
    IN function_definition
  ) = 0 THEN
    RAISE EXCEPTION 'tenant error-budget account isolation was not patched by 0068';
  END IF;
  EXECUTE function_definition;
END
$$;

-- Repair only the unambiguous single-target runs that the old exhaustion guard
-- mislabeled after a publication job had already been bound. The publication
-- job remains authoritative; this never retries or submits it.
DO $$
DECLARE
  affected_batch_ids uuid[];
  affected_batch_id uuid;
BEGIN
  WITH eligible AS (
    SELECT run.tenant_id,
           run.id AS run_id,
           run.batch_id,
           target.id AS target_id,
           job.state AS job_state,
           COALESCE(NULLIF(trim(job.last_error_code), ''),
             'AUTOMATION_PUBLICATION_' || upper(job.state)) AS job_error,
           job.confirmed_at
    FROM geo.automation_runs AS run
    JOIN geo.automation_run_targets AS target
      ON target.tenant_id = run.tenant_id
     AND target.run_id = run.id
    JOIN geo.publication_jobs AS job
      ON job.tenant_id = target.tenant_id
     AND job.id = target.publication_job_id
    WHERE run.state = 'failed'
      AND run.stage = 'delivery'
      AND run.last_error_code = 'AUTOMATION_MAX_ATTEMPTS_EXCEEDED'
      AND target.state = 'failed'
      AND target.last_error_code = 'AUTOMATION_MAX_ATTEMPTS_EXCEEDED'
      AND (
        SELECT count(*)
        FROM geo.automation_run_targets AS sibling
        WHERE sibling.tenant_id = run.tenant_id
          AND sibling.run_id = run.id
      ) = 1
  ), repaired_targets AS (
    UPDATE geo.automation_run_targets AS target
    SET state = CASE
          WHEN eligible.job_state IN (
            'queued', 'dispatching', 'retry_wait', 'uncertain', 'reconciling'
          ) THEN 'awaiting_delivery'
          WHEN eligible.job_state = 'confirmed' THEN 'confirmed'
          ELSE 'delivery_failed'
        END,
        last_error_code = CASE
          WHEN eligible.job_state IN (
            'queued', 'dispatching', 'retry_wait', 'uncertain', 'reconciling', 'confirmed'
          ) THEN NULL
          ELSE eligible.job_error
        END,
        last_error_message = CASE
          WHEN eligible.job_state IN (
            'queued', 'dispatching', 'retry_wait', 'uncertain', 'reconciling', 'confirmed'
          ) THEN NULL
          ELSE left(eligible.job_error, 4000)
        END,
        completed_at = CASE
          WHEN eligible.job_state IN (
            'queued', 'dispatching', 'retry_wait', 'uncertain', 'reconciling'
          ) THEN NULL
          ELSE COALESCE(target.completed_at, eligible.confirmed_at, clock_timestamp())
        END
    FROM eligible
    WHERE target.tenant_id = eligible.tenant_id
      AND target.id = eligible.target_id
    RETURNING eligible.tenant_id, eligible.run_id, eligible.batch_id,
              eligible.job_state, eligible.job_error, eligible.confirmed_at
  ), repaired_runs AS (
    UPDATE geo.automation_runs AS run
    SET state = CASE
          WHEN repaired.job_state IN (
            'queued', 'dispatching', 'retry_wait', 'uncertain', 'reconciling'
          ) THEN 'awaiting_delivery'
          WHEN repaired.job_state = 'confirmed' THEN 'completed'
          ELSE 'delivery_failed'
        END,
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error_code = CASE
          WHEN repaired.job_state IN (
            'queued', 'dispatching', 'retry_wait', 'uncertain', 'reconciling', 'confirmed'
          ) THEN NULL
          ELSE 'AUTOMATION_DELIVERY_FAILED'
        END,
        last_error_message = CASE
          WHEN repaired.job_state IN (
            'queued', 'dispatching', 'retry_wait', 'uncertain', 'reconciling', 'confirmed'
          ) THEN NULL
          ELSE left(repaired.job_error, 4000)
        END,
        completed_at = CASE
          WHEN repaired.job_state IN (
            'queued', 'dispatching', 'retry_wait', 'uncertain', 'reconciling'
          ) THEN NULL
          ELSE COALESCE(run.completed_at, repaired.confirmed_at, clock_timestamp())
        END
    FROM repaired_targets AS repaired
    WHERE run.tenant_id = repaired.tenant_id
      AND run.id = repaired.run_id
    RETURNING run.batch_id
  )
  SELECT array_agg(DISTINCT repaired_runs.batch_id)
  INTO affected_batch_ids
  FROM repaired_runs;

  IF affected_batch_ids IS NOT NULL THEN
    FOREACH affected_batch_id IN ARRAY affected_batch_ids LOOP
      PERFORM geo.refresh_automation_batch_state(affected_batch_id);
    END LOOP;
  END IF;
END
$$;

COMMIT;
