BEGIN;

-- The original function checked job.execution_level before loading the job
-- row. Recreate it in forward history so unattended creator-management
-- confirmation always proves the current readback lease after lineage is
-- locked, without changing the already-applied 0103 migration.
CREATE OR REPLACE FUNCTION geo.record_publication_assisted_publisher_status_confirmation(
  p_handoff_id uuid,
  p_evidence_hash geo.sha256_hex,
  p_external_id text,
  p_external_url text,
  p_observed_at timestamptz
)
RETURNS TABLE (state text, external_id text, external_url text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_bound_ctrip_bridge(p_handoff_id);
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  job geo.publication_jobs%ROWTYPE;
  normalized_external_id text := NULLIF(trim(p_external_id), '');
  normalized_external_url text := NULLIF(trim(p_external_url), '');
BEGIN
  IF p_observed_at IS NULL
     OR p_observed_at > statement_timestamp() + interval '1 minute'
     OR p_observed_at < statement_timestamp() - interval '24 hours'
     OR normalized_external_id IS NULL
     OR normalized_external_url IS NULL
     OR length(normalized_external_id) > 500
     OR length(normalized_external_url) > 2000 THEN
    RAISE EXCEPTION 'invalid creator-management publication confirmation'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id
  FOR UPDATE;
  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002';
  END IF;
  IF handoff.state <> 'readback_pending'
     OR handoff.publication_receipt_id IS NULL
     OR handoff.publication_readback_id IS NULL THEN
    RAISE EXCEPTION 'publisher-status confirmation requires a submitted pending handoff'
      USING ERRCODE = '55000';
  END IF;
  IF handoff.submit_evidence_kind <> 'browser' THEN
    RAISE EXCEPTION 'publisher-status confirmation requires browser submit evidence'
      USING ERRCODE = '23514';
  END IF;
  IF handoff.submit_observed_at IS NULL
     OR p_observed_at < handoff.submit_observed_at - interval '1 minute' THEN
    RAISE EXCEPTION 'publisher-status confirmation predates the submit observation'
      USING ERRCODE = '22023';
  END IF;
  IF NOT geo.browser_publication_identity_allowed(
    handoff.platform, normalized_external_id, normalized_external_url
  ) THEN
    RAISE EXCEPTION 'publisher-status identity is outside the platform allowlist'
      USING ERRCODE = '23514';
  END IF;
  IF (handoff.submit_candidate_external_id IS NOT NULL
      AND handoff.submit_candidate_external_id <> normalized_external_id)
     OR (handoff.submit_candidate_external_url IS NOT NULL
      AND handoff.submit_candidate_external_url <> normalized_external_url) THEN
    RAISE EXCEPTION 'publisher-status identity conflicts with the submitted candidate'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO job
  FROM geo.publication_jobs AS publication_job
  WHERE publication_job.tenant_id = tenant_value
    AND publication_job.id = handoff.job_id
  FOR UPDATE;
  IF job.id IS NULL
     OR job.platform <> handoff.platform
     OR job.channel_account_id <> handoff.channel_account_id
     OR job.variant_id <> handoff.variant_id
     OR job.payload_hash <> handoff.payload_hash THEN
    RAISE EXCEPTION 'publisher-status handoff lineage does not match its publication job'
      USING ERRCODE = '55000';
  END IF;

  IF job.execution_level = 'unattended' AND (
    handoff.readback_owner_principal_id IS DISTINCT FROM actor_value
    OR handoff.readback_lease_expires_at IS NULL
    OR handoff.readback_lease_expires_at < statement_timestamp()
  ) THEN
    RAISE EXCEPTION 'unattended publisher-status confirmation requires the current bridge lease'
      USING ERRCODE = '55006';
  END IF;

  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = 'confirmed',
      readback_outcome = 'publisher_confirmed',
      readback_evidence_kind = 'creator_management',
      readback_evidence_hash = p_evidence_hash,
      readback_observed_at = p_observed_at,
      readback_attempt_count = readback_attempt_count + 1,
      observed_payload_hash = NULL,
      external_id = normalized_external_id,
      external_url = normalized_external_url,
      readback_owner_principal_id = NULL,
      readback_lease_expires_at = NULL,
      last_error_code = NULL,
      last_error_message = NULL
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id;

  UPDATE geo.publication_readbacks AS readback
  SET status = 'succeeded',
      reason = 'publisher_status_confirmed',
      completed_at = clock_timestamp(),
      last_error = NULL
  WHERE readback.tenant_id = tenant_value
    AND readback.id = handoff.publication_readback_id;

  UPDATE geo.publication_jobs AS publication_job
  SET state = 'confirmed',
      confirmed_at = clock_timestamp(),
      last_error_code = NULL
  WHERE publication_job.tenant_id = tenant_value
    AND publication_job.id = handoff.job_id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value,
    actor_value,
    'publication_assisted_handoff.publisher_status_confirmed',
    'publication_assisted_handoff',
    p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    p_evidence_hash,
    jsonb_build_object(
      'platform', handoff.platform,
      'confirmationScope', 'publisher_status',
      'publicReadbackConfirmed', false,
      'externalIdHash', encode(public.digest(normalized_external_id, 'sha256'), 'hex'),
      'externalUrlHash', encode(public.digest(normalized_external_url, 'sha256'), 'hex'),
      'executionLevel', job.execution_level
    )
  );

  RETURN QUERY SELECT 'confirmed'::text, normalized_external_id, normalized_external_url;
END
$$;

REVOKE ALL ON FUNCTION geo.record_publication_assisted_publisher_status_confirmation(
  uuid, geo.sha256_hex, text, text, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_publisher_status_confirmation(
  uuid, geo.sha256_hex, text, text, timestamptz
) TO geo_runtime;

COMMENT ON FUNCTION geo.record_publication_assisted_publisher_status_confirmation(
  uuid, geo.sha256_hex, text, text, timestamptz
) IS
  'Confirms publication from an authenticated creator-management row; public anonymous availability remains unverified.';

COMMIT;
