BEGIN;

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
      'BROWSER_ASSISTED_ACCOUNT_NOT_CONFIGURED',
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
      'ASSISTED_HANDOFF_FAILED',
      'ASSISTED_PREPARED_DRAFT_MISMATCH'
    ]::text[])
  END
$$;

CREATE FUNCTION geo.record_publication_assisted_prepared_conflict(
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

  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id
  FOR UPDATE;

  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002';
  END IF;
  IF handoff.state <> 'draft_prepared' THEN
    RAISE EXCEPTION 'prepared conflict requires a draft_prepared handoff'
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
  SET state = 'failed',
      submit_permit_hash = NULL,
      submit_permit_expires_at = NULL,
      submit_permit_issued_by_actor_id = NULL,
      submit_permit_issued_by_principal_id = NULL,
      submit_permit_consumed_by_principal_id = NULL,
      last_error_code = 'ASSISTED_PREPARED_DRAFT_MISMATCH',
      last_error_message = diagnostic_value,
      updated_at = clock_timestamp()
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id;

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
      'errorCode', 'ASSISTED_PREPARED_DRAFT_MISMATCH',
      'submitPermitConsumed', false
    )
  );
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION geo.publication_attempt_consumes_error_budget(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.record_publication_assisted_prepared_conflict(
  uuid, geo.sha256_hex, text, timestamptz, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_prepared_conflict(
  uuid, geo.sha256_hex, text, timestamptz, text, text
) TO geo_runtime;

COMMIT;
