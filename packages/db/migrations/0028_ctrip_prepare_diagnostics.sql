DROP FUNCTION geo.record_publication_assisted_bridge_status(
  uuid, text, geo.sha256_hex, geo.sha256_hex, text, timestamptz, text, text
);

CREATE FUNCTION geo.record_publication_assisted_bridge_status(
  p_handoff_id uuid,
  p_status text,
  p_session_evidence_hash geo.sha256_hex,
  p_prepare_evidence_hash geo.sha256_hex,
  p_prepare_evidence_kind text,
  p_prepare_observed_at timestamptz,
  p_adapter_version text,
  p_error_code text DEFAULT NULL,
  p_error_message text DEFAULT NULL
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
  next_error_code text;
  next_error_message text;
  next_prepare_outcome text;
BEGIN
  next_error_code := CASE
    WHEN p_status = 'session_required' THEN 'ASSISTED_SESSION_REQUIRED'
    WHEN p_status = 'challenge_required' THEN 'ASSISTED_CHALLENGE_REQUIRED'
    ELSE COALESCE(NULLIF(trim(p_error_code), ''), 'ASSISTED_ADAPTER_DRIFT')
  END;
  next_error_message := NULLIF(trim(p_error_message), '');
  next_prepare_outcome := CASE
    WHEN p_status = 'failed' AND next_error_code = 'CTRIP_PAYLOAD_INVALID' THEN 'payload_invalid'
    WHEN p_status = 'failed' THEN 'adapter_drift'
    ELSE p_status
  END;

  IF p_status NOT IN ('session_required', 'challenge_required', 'failed')
     OR p_session_evidence_hash IS NULL OR p_prepare_evidence_hash IS NULL
     OR p_prepare_evidence_kind IS NULL
     OR p_prepare_evidence_kind NOT IN ('simulation', 'browser')
     OR p_prepare_observed_at IS NULL
     OR p_prepare_observed_at > statement_timestamp() + interval '1 minute'
     OR p_prepare_observed_at < statement_timestamp() - interval '30 minutes'
     OR p_adapter_version IS NULL OR length(trim(p_adapter_version)) NOT BETWEEN 1 AND 100
     OR (p_status = 'failed' AND next_error_code NOT IN (
       'ASSISTED_ADAPTER_DRIFT', 'CTRIP_PAYLOAD_INVALID'
     ))
     OR (next_error_message IS NOT NULL AND (
       length(next_error_message) NOT BETWEEN 1 AND 160
       OR next_error_message !~ '^prepare:[a-z0-9:_-]+$'
     )) THEN
    RAISE EXCEPTION 'invalid bridge status report' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id
  FOR UPDATE;

  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002';
  END IF;
  IF handoff.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'assisted handoff has expired' USING ERRCODE = '55000';
  END IF;
  IF handoff.draft_prepare_owner_principal_id <> actor_value
     OR handoff.draft_prepare_lease_expires_at < statement_timestamp() THEN
    RAISE EXCEPTION 'bridge status requires the current draft preparation lease'
      USING ERRCODE = '55006';
  END IF;
  IF handoff.state NOT IN ('handoff_pending', 'session_required', 'challenge_required') THEN
    RAISE EXCEPTION 'bridge status cannot be recorded in state %', handoff.state
      USING ERRCODE = '55000';
  END IF;
  IF handoff.adapter_version <> trim(p_adapter_version) THEN
    RAISE EXCEPTION 'bridge adapter version does not match the reviewed handoff'
      USING ERRCODE = '42501';
  END IF;

  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = p_status,
      session_evidence_hash = p_session_evidence_hash,
      prepare_outcome = next_prepare_outcome,
      prepare_evidence_hash = p_prepare_evidence_hash,
      prepare_evidence_kind = p_prepare_evidence_kind,
      prepare_observed_at = p_prepare_observed_at,
      media_manifest_hash = NULL,
      draft_prepare_owner_principal_id = NULL,
      draft_prepare_lease_expires_at = NULL,
      last_error_code = next_error_code,
      last_error_message = next_error_message,
      updated_at = clock_timestamp()
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id;

  IF p_status = 'challenge_required' OR next_error_code = 'ASSISTED_ADAPTER_DRIFT' THEN
    INSERT INTO geo.circuit_breakers (
      tenant_id, scope_type, scope_key, state, failure_count,
      opened_at, retry_at, reason
    ) VALUES (
      tenant_value, 'account', handoff.channel_account_id::text, 'open', 1,
      statement_timestamp(), NULL, next_error_code
    )
    ON CONFLICT (tenant_id, scope_type, scope_key) DO UPDATE
    SET state = 'open',
        failure_count = geo.circuit_breakers.failure_count + 1,
        opened_at = statement_timestamp(),
        retry_at = NULL,
        reason = next_error_code,
        probe_attempt_id = NULL,
        probe_started_at = NULL;
  END IF;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.bridge_status_recorded',
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    p_prepare_evidence_hash,
    jsonb_build_object(
      'status', p_status,
      'prepareOutcome', next_prepare_outcome,
      'sessionEvidenceHash', p_session_evidence_hash,
      'evidenceKind', p_prepare_evidence_kind,
      'observedAt', p_prepare_observed_at,
      'errorCode', next_error_code,
      'diagnosticCode', next_error_message
    )
  );
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION geo.record_publication_assisted_bridge_status(
  uuid, text, geo.sha256_hex, geo.sha256_hex, text, timestamptz, text, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_bridge_status(
  uuid, text, geo.sha256_hex, geo.sha256_hex, text, timestamptz, text, text, text
) TO geo_runtime;
