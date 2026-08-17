BEGIN;

CREATE OR REPLACE FUNCTION geo.record_publication_assisted_prepared_conflict(
  p_handoff_id uuid,
  p_evidence_hash geo.sha256_hex,
  p_evidence_kind text,
  p_observed_at timestamptz,
  p_adapter_version text,
  p_diagnostic_code text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_bound_ctrip_bridge(p_handoff_id);
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  diagnostic_value text := NULLIF(trim(p_diagnostic_code), '');
  next_state text;
  next_error_code text;
BEGIN
  IF p_evidence_hash IS NULL
     OR p_evidence_kind NOT IN ('simulation', 'browser')
     OR p_observed_at IS NULL
     OR p_observed_at > statement_timestamp() + interval '1 minute'
     OR p_observed_at < statement_timestamp() - interval '30 minutes'
     OR p_adapter_version IS NULL
     OR length(trim(p_adapter_version)) NOT BETWEEN 1 AND 100
     OR diagnostic_value IS NULL
     OR length(diagnostic_value) NOT BETWEEN 1 AND 160
     OR diagnostic_value !~ '^submit:[a-z0-9:_-]+$' THEN
    RAISE EXCEPTION 'invalid prepared conflict report' USING ERRCODE = '22023';
  END IF;

  next_state := CASE diagnostic_value
    WHEN 'submit:session-required' THEN 'session_required'
    WHEN 'submit:challenge-required' THEN 'challenge_required'
    ELSE 'failed'
  END;
  next_error_code := CASE next_state
    WHEN 'session_required' THEN 'ASSISTED_SESSION_REQUIRED'
    WHEN 'challenge_required' THEN 'ASSISTED_CHALLENGE_REQUIRED'
    ELSE 'ASSISTED_PREPARED_DRAFT_MISMATCH'
  END;

  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id
  FOR UPDATE;

  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002';
  END IF;
  IF handoff.state NOT IN ('draft_prepared', 'awaiting_operator_submit') THEN
    RAISE EXCEPTION 'prepared conflict requires a pre-submit handoff'
      USING ERRCODE = '55000';
  END IF;
  IF handoff.submit_permit_consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'prepared conflict cannot follow submit permit consumption'
      USING ERRCODE = '55000';
  END IF;
  IF handoff.adapter_version <> trim(p_adapter_version) THEN
    RAISE EXCEPTION 'bridge adapter version does not match the reviewed handoff'
      USING ERRCODE = '42501';
  END IF;

  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = next_state,
      prepare_outcome = CASE
        WHEN next_state IN ('session_required', 'challenge_required') THEN next_state
        ELSE assisted_handoff.prepare_outcome
      END,
      prepare_evidence_hash = CASE
        WHEN next_state IN ('session_required', 'challenge_required') THEN p_evidence_hash
        ELSE assisted_handoff.prepare_evidence_hash
      END,
      prepare_evidence_kind = CASE
        WHEN next_state IN ('session_required', 'challenge_required') THEN p_evidence_kind
        ELSE assisted_handoff.prepare_evidence_kind
      END,
      prepare_observed_at = CASE
        WHEN next_state IN ('session_required', 'challenge_required') THEN p_observed_at
        ELSE assisted_handoff.prepare_observed_at
      END,
      media_manifest_hash = CASE
        WHEN next_state IN ('session_required', 'challenge_required') THEN NULL
        ELSE assisted_handoff.media_manifest_hash
      END,
      submit_permit_hash = NULL,
      submit_permit_expires_at = NULL,
      submit_permit_issued_by_actor_id = NULL,
      submit_permit_issued_by_principal_id = NULL,
      submit_permit_consumed_by_principal_id = NULL,
      last_error_code = next_error_code,
      last_error_message = diagnostic_value,
      updated_at = clock_timestamp()
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id;

  IF next_state = 'challenge_required' THEN
    INSERT INTO geo.circuit_breakers (
      tenant_id, scope_type, scope_key, state, failure_count,
      opened_at, retry_at, reason
    ) VALUES (
      tenant_value, 'account', handoff.channel_account_id::text, 'open', 1,
      statement_timestamp(), statement_timestamp() + interval '10 minutes',
      next_error_code
    )
    ON CONFLICT (tenant_id, scope_type, scope_key) DO UPDATE
    SET state = 'open',
        failure_count = geo.circuit_breakers.failure_count + 1,
        opened_at = statement_timestamp(),
        retry_at = statement_timestamp() + interval '10 minutes',
        reason = next_error_code,
        probe_attempt_id = NULL,
        probe_started_at = NULL,
        updated_at = clock_timestamp();
  END IF;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value,
    'publication_assisted_handoff.prepared_conflict_recorded',
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    p_evidence_hash,
    jsonb_build_object(
      'evidenceKind', p_evidence_kind,
      'observedAt', p_observed_at,
      'adapterVersion', trim(p_adapter_version),
      'diagnosticCode', diagnostic_value,
      'nextState', next_state,
      'errorCode', next_error_code,
      'submitPermitConsumed', false
    )
  );
  RETURN true;
END
$$;

DO $$
DECLARE
  function_definition text;
  transition_needle text :=
    $needle$(OLD.state = 'draft_prepared' AND NEW.state IN ('awaiting_operator_submit', 'cancelled', 'expired', 'failed'))$needle$;
  transition_replacement text :=
    $replacement$(OLD.state = 'draft_prepared' AND NEW.state IN ('session_required', 'challenge_required', 'awaiting_operator_submit', 'cancelled', 'expired', 'failed'))$replacement$;
  awaiting_transition_needle text :=
    $needle$(OLD.state = 'awaiting_operator_submit' AND NEW.state IN ('submitted_unconfirmed', 'cancelled', 'expired', 'failed'))$needle$;
  awaiting_transition_replacement text :=
    $replacement$(OLD.state = 'awaiting_operator_submit' AND NEW.state IN ('session_required', 'challenge_required', 'submitted_unconfirmed', 'cancelled', 'expired', 'failed'))$replacement$;
BEGIN
  SELECT pg_get_functiondef(
    'geo.enforce_publication_assisted_handoff_transition()'::regprocedure
  ) INTO function_definition;

  IF function_definition IS NULL
     OR position(transition_needle IN function_definition) = 0
     OR position(awaiting_transition_needle IN function_definition) = 0 THEN
    RAISE EXCEPTION 'prepared submit blocker transition drifted before 0129';
  END IF;

  function_definition := replace(
    function_definition,
    transition_needle,
    transition_replacement
  );
  function_definition := replace(
    function_definition,
    awaiting_transition_needle,
    awaiting_transition_replacement
  );

  IF position(
    $expected$NEW.state IN ('session_required', 'challenge_required', 'awaiting_operator_submit'$expected$
    IN function_definition
  ) = 0
     OR position(
       $expected$NEW.state IN ('session_required', 'challenge_required', 'submitted_unconfirmed'$expected$
       IN function_definition
     ) = 0 THEN
    RAISE EXCEPTION 'prepared submit blocker transition was not patched by 0129';
  END IF;

  EXECUTE function_definition;
END
$$;

REVOKE ALL ON FUNCTION geo.record_publication_assisted_prepared_conflict(
  uuid, geo.sha256_hex, text, timestamptz, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_prepared_conflict(
  uuid, geo.sha256_hex, text, timestamptz, text, text
) TO geo_runtime;

COMMIT;
