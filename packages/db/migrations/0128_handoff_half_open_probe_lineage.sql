BEGIN;

-- handoff half-open probe lineage: the current publication attempt may create
-- its handoff while it owns the recoverable account circuit's controlled probe.
DO $$
DECLARE
  function_definition text;
  block_reason_needle text :=
    $needle$  block_reason := geo.publication_assisted_block_reason(p_job_id);$needle$;
  block_reason_replacement text :=
    $replacement$  IF EXISTS (
    SELECT 1
    FROM geo.publication_attempts AS probe_attempt
    JOIN geo.circuit_breakers AS probe_circuit
      ON probe_circuit.tenant_id = probe_attempt.tenant_id
     AND probe_circuit.scope_type = 'account'
     AND probe_circuit.scope_key = job.channel_account_id::text
     AND probe_circuit.state = 'half_open'
     AND probe_circuit.probe_attempt_id = probe_attempt.id
     AND probe_circuit.reason IN (
       'ASSISTED_SESSION_REQUIRED',
       'ASSISTED_CHALLENGE_REQUIRED',
       'ASSISTED_ADAPTER_DRIFT'
     )
    WHERE probe_attempt.tenant_id = tenant_value
      AND probe_attempt.id = p_attempt_id
      AND probe_attempt.job_id = p_job_id
      AND probe_attempt.state = 'started'
      AND probe_attempt.half_open_probe
      AND probe_attempt.request_hash = job.request_hash
      AND job.state = 'dispatching'
  ) THEN
    PERFORM set_config('app.allow_account_half_open_probe', 'true', true);
  END IF;

  block_reason := geo.publication_assisted_block_reason(p_job_id);$replacement$;
BEGIN
  SELECT pg_get_functiondef(
    'geo.create_publication_assisted_handoff(uuid,uuid,uuid,uuid,geo.sha256_hex,text,text,timestamp with time zone)'::regprocedure
  ) INTO function_definition;

  IF function_definition IS NULL
     OR position(block_reason_needle IN function_definition) = 0 THEN
    RAISE EXCEPTION 'assisted handoff block boundary drifted before 0128';
  END IF;

  function_definition := replace(
    function_definition,
    block_reason_needle,
    block_reason_replacement
  );

  IF position('probe_circuit.probe_attempt_id = probe_attempt.id' IN function_definition) = 0
     OR position(
       'probe_attempt.request_hash = job.request_hash' IN function_definition
     ) = 0 THEN
    RAISE EXCEPTION 'handoff half-open probe lineage was not patched by 0128';
  END IF;

  EXECUTE function_definition;
END
$$;

DO $$
DECLARE
  function_definition text;
  block_reason_needle text :=
    $needle$  block_reason := geo.publication_assisted_block_reason(handoff.job_id);$needle$;
  block_reason_replacement text :=
    $replacement$  IF EXISTS (
    SELECT 1
    FROM geo.publication_attempts AS probe_attempt
    JOIN geo.circuit_breakers AS probe_circuit
      ON probe_circuit.tenant_id = probe_attempt.tenant_id
     AND probe_circuit.scope_type = 'account'
     AND probe_circuit.scope_key = handoff.channel_account_id::text
     AND probe_circuit.state = 'half_open'
     AND probe_circuit.probe_attempt_id = probe_attempt.id
     AND probe_circuit.reason IN (
       'ASSISTED_SESSION_REQUIRED',
       'ASSISTED_CHALLENGE_REQUIRED',
       'ASSISTED_ADAPTER_DRIFT'
     )
    WHERE probe_attempt.tenant_id = tenant_value
      AND probe_attempt.id = handoff.attempt_id
      AND probe_attempt.job_id = handoff.job_id
      AND probe_attempt.state = 'started'
      AND probe_attempt.half_open_probe
  ) THEN
    PERFORM set_config('app.allow_account_half_open_probe', 'true', true);
  END IF;

  block_reason := geo.publication_assisted_block_reason(handoff.job_id);$replacement$;
BEGIN
  SELECT pg_get_functiondef(
    'geo.claim_publication_assisted_draft_prepare(uuid,integer)'::regprocedure
  ) INTO function_definition;

  IF function_definition IS NULL
     OR position(block_reason_needle IN function_definition) = 0 THEN
    RAISE EXCEPTION 'specific draft preparation claim drifted before 0128';
  END IF;

  function_definition := replace(
    function_definition,
    block_reason_needle,
    block_reason_replacement
  );

  IF position('probe_attempt.id = handoff.attempt_id' IN function_definition) = 0
     OR position('probe_attempt.job_id = handoff.job_id' IN function_definition) = 0 THEN
    RAISE EXCEPTION 'specific draft preparation probe lineage was not patched by 0128';
  END IF;

  EXECUTE function_definition;
END
$$;

COMMIT;
