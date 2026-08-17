BEGIN;

-- Delivery error budgets protect the external publication path. Control,
-- authorization, account-session, and worker-integrity failures are actionable
-- operational faults, but they are not evidence that a platform delivery failed.
CREATE OR REPLACE FUNCTION geo.publication_attempt_consumes_error_budget(
  p_state text,
  p_error_code text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN NULLIF(upper(btrim(p_error_code)), '') IS NULL THEN false
    WHEN upper(btrim(p_state)) = 'UNCERTAIN' THEN
      upper(btrim(p_error_code)) = 'ASSISTED_SUBMIT_REJECTED'
    WHEN upper(btrim(p_state)) <> 'FAILED' THEN false
    ELSE upper(btrim(p_error_code)) <> ALL (ARRAY[
      'PUBLICATION_GATE_BLOCKED',
      'PUBLICATION_AUTHORIZATION_INVALID',
      'CTRIP_ASSISTED_ACCOUNT_NOT_CONFIGURED',
      'CTRIP_ASSISTED_ADAPTER_EVIDENCE_EXPIRED',
      'WORKER_ACTOR_NOT_CONFIGURED',
      'WORKER_ACTOR_NOT_AUTHORIZED',
      'WORKER_LEASE_EXPIRED',
      'FAILURE_PERSISTENCE_FAILED',
      'UNEXPECTED_ERROR',
      'UNSUPPORTED_OUTBOX_TOPIC',
      'INVALID_OUTBOX_PAYLOAD',
      'TENANT_SCOPE_MISMATCH',
      'PUBLICATION_JOB_NOT_FOUND',
      'COMPLETED_JOB_WITHOUT_RECEIPT',
      'UNCERTAIN_JOB_WITHOUT_RECEIPT',
      'PUBLICATION_SCOPE_MISMATCH',
      'PAYLOAD_HASH_MISMATCH',
      'CONNECTOR_NOT_FOUND',
      'ACCOUNT_CAPABILITY_BLOCKED',
      'MVP_DRY_RUN_ONLY',
      'DRY_RUN_PREFLIGHT_FAILED',
      'INVALID_DRY_RUN_RECEIPT',
      'CAPABILITY_EVIDENCE_INSUFFICIENT',
      'EXECUTION_LEVEL_UNSUPPORTED',
      'UNATTENDED_REQUIRES_VERIFIED_API',
      'EXTERNAL_WRITE_DISABLED',
      'PREVIEW_CANNOT_CONFIRM_PUBLICATION',
      'ASSISTED_SESSION_REQUIRED',
      'ASSISTED_CHALLENGE_REQUIRED',
      'ASSISTED_ADAPTER_DRIFT',
      'ASSISTED_SCOPE_MISMATCH',
      'ASSISTED_DRAFT_NOT_PREPARED',
      'ASSISTED_HANDOFF_BINDING_MISMATCH',
      'ASSISTED_HANDOFF_ID_MISMATCH',
      'ASSISTED_HANDOFF_EXPIRED',
      'ASSISTED_HANDOFF_CANCELLED',
      'ASSISTED_HANDOFF_FAILED'
    ]::text[])
  END
$$;

DO $$
DECLARE
  function_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'geo.acquire_publication_execution(uuid,uuid,text)'::regprocedure
  ) INTO function_definition;
  IF function_definition IS NULL
     OR position(
       'attempt.state = ''failed'''
       IN function_definition
     ) = 0
     OR position(
       'attempt.error_code IS DISTINCT FROM ''PUBLICATION_GATE_BLOCKED'''
       IN function_definition
     ) = 0
     OR position(
       'readback_handoff.tenant_id = attempt.tenant_id'
       IN function_definition
     ) = 0 THEN
    RAISE EXCEPTION 'publication acquire error-budget predicate drifted before 0069';
  END IF;

  function_definition := replace(
    function_definition,
    $needle$attempt.state = 'failed'$needle$,
    $replacement$geo.publication_attempt_consumes_error_budget(
              attempt.state, attempt.error_code
            )$replacement$
  );
  function_definition := replace(
    function_definition,
    $needle$attempt.error_code IS DISTINCT FROM 'PUBLICATION_GATE_BLOCKED'$needle$,
    $replacement$true$replacement$
  );
  function_definition := replace(
    function_definition,
    $needle$readback_handoff.tenant_id = attempt.tenant_id$needle$,
    $replacement$upper(btrim(attempt.error_code)) <> 'ASSISTED_SUBMIT_REJECTED'
                AND readback_handoff.tenant_id = attempt.tenant_id$replacement$
  );

  IF position(
    'geo.publication_attempt_consumes_error_budget('
    IN function_definition
  ) = 0 THEN
    RAISE EXCEPTION 'publication acquire error-budget classifier was not patched by 0069';
  END IF;
  IF position(
       'upper(btrim(attempt.error_code)) <> ''ASSISTED_SUBMIT_REJECTED'''
       IN function_definition
     ) = 0 THEN
    RAISE EXCEPTION 'publication acquire rejected-submit exception was not patched by 0069';
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
     OR position(
       'prior_attempt.state = ''failed'''
       IN function_definition
     ) = 0
     OR position(
       'prior_attempt.error_code IS DISTINCT FROM ''PUBLICATION_GATE_BLOCKED'''
       IN function_definition
     ) = 0
     OR position(
       'readback_handoff.tenant_id = prior_attempt.tenant_id'
       IN function_definition
     ) = 0
     OR position(
       'ELSIF attempt_row.half_open_probe THEN'
       IN function_definition
     ) = 0
     OR position(
       'ELSIF p_outcome IN (''failed'', ''uncertain'') THEN'
       IN function_definition
     ) = 0 THEN
    RAISE EXCEPTION 'publication finish error-budget predicate drifted before 0069';
  END IF;

  function_definition := replace(
    function_definition,
    $needle$prior_attempt.state = 'failed'$needle$,
    $replacement$geo.publication_attempt_consumes_error_budget(
          prior_attempt.state, prior_attempt.error_code
        )$replacement$
  );
  function_definition := replace(
    function_definition,
    $needle$prior_attempt.error_code IS DISTINCT FROM 'PUBLICATION_GATE_BLOCKED'$needle$,
    $replacement$true$replacement$
  );
  function_definition := replace(
    function_definition,
    $needle$readback_handoff.tenant_id = prior_attempt.tenant_id$needle$,
    $replacement$upper(btrim(prior_attempt.error_code)) <> 'ASSISTED_SUBMIT_REJECTED'
            AND readback_handoff.tenant_id = prior_attempt.tenant_id$replacement$
  );
  function_definition := replace(
    function_definition,
    $needle$ELSIF attempt_row.half_open_probe THEN$needle$,
    $replacement$ELSIF attempt_row.half_open_probe
      AND geo.publication_attempt_consumes_error_budget(p_outcome, p_error_code) THEN$replacement$
  );
  function_definition := replace(
    function_definition,
    $needle$ELSIF p_outcome IN ('failed', 'uncertain') THEN$needle$,
    $replacement$ELSIF attempt_row.half_open_probe THEN
    UPDATE geo.circuit_breakers AS circuit
    SET probe_attempt_id = NULL,
        probe_started_at = NULL,
        reason = 'half-open publication probe was inconclusive: ' ||
          left(trim(p_error_code), 200),
        updated_at = now_value
    WHERE circuit.tenant_id = tenant_value
      AND circuit.probe_attempt_id = p_attempt_id;
  ELSIF geo.publication_attempt_consumes_error_budget(p_outcome, p_error_code) THEN$replacement$
  );

  IF position(
    'control_row.scope_type <> ''tenant'''
    IN function_definition
  ) = 0 THEN
    function_definition := replace(
      function_definition,
      $needle$        AND prior_attempt.started_at >= now_value - interval '1 day'$needle$,
      $replacement$        AND (control_row.scope_type <> 'tenant'
             OR prior_job.channel_account_id = job_row.channel_account_id)
        AND prior_attempt.started_at >= now_value - interval '1 day'$replacement$
    );
  END IF;

  IF position(
       'geo.publication_attempt_consumes_error_budget('
       IN function_definition
     ) = 0
     OR position(
       'half-open publication probe was inconclusive'
       IN function_definition
     ) = 0
     OR position(
       'prior_job.channel_account_id = job_row.channel_account_id'
       IN function_definition
     ) = 0 THEN
    RAISE EXCEPTION 'publication finish error-budget semantics were not patched by 0069';
  END IF;
  EXECUTE function_definition;
END
$$;

REVOKE ALL ON FUNCTION geo.publication_attempt_consumes_error_budget(text, text) FROM PUBLIC;

COMMIT;
