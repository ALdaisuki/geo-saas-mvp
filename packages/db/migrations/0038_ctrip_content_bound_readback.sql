ALTER TABLE geo.publication_assisted_handoffs
  ADD COLUMN public_content_hash geo.sha256_hex,
  ADD COLUMN readback_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN readback_deadline_at timestamptz,
  ADD CONSTRAINT publication_assisted_handoff_readback_attempt_count
    CHECK (readback_attempt_count BETWEEN 0 AND 100) NOT VALID;

CREATE OR REPLACE FUNCTION geo.enforce_publication_assisted_handoff_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'publication assisted handoffs cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF NEW.lease_owner_actor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM geo.tenant_memberships AS membership
    WHERE membership.tenant_id = NEW.tenant_id AND membership.user_id = NEW.lease_owner_actor_id
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin', 'publisher')
      AND membership.capabilities @> '["publish:request"]'::jsonb
  ) THEN RAISE EXCEPTION 'handoff lease owner must be an active publication operator' USING ERRCODE = '42501'; END IF;
  IF NEW.draft_prepare_owner_principal_id IS NOT NULL AND (
    NEW.draft_prepare_owner_principal_id <> NEW.bridge_service_principal_id OR NOT EXISTS (
      SELECT 1 FROM geo.service_principals AS principal
      WHERE principal.tenant_id = NEW.tenant_id AND principal.id = NEW.draft_prepare_owner_principal_id
        AND principal.kind = 'integration' AND principal.profile = 'ctrip_bridge'
        AND principal.status = 'active' AND principal.capabilities @> '["publish:bridge"]'::jsonb
    )
  ) THEN RAISE EXCEPTION 'draft preparation lease owner must be the bound active Ctrip bridge' USING ERRCODE = '42501'; END IF;
  IF NEW.readback_owner_principal_id IS NOT NULL AND (
    NEW.readback_owner_principal_id <> NEW.bridge_service_principal_id OR NOT EXISTS (
      SELECT 1 FROM geo.service_principals AS principal
      WHERE principal.tenant_id = NEW.tenant_id AND principal.id = NEW.readback_owner_principal_id
        AND principal.kind = 'integration' AND principal.profile = 'ctrip_bridge'
        AND principal.status = 'active' AND principal.capabilities @> '["publish:bridge"]'::jsonb
    )
  ) THEN RAISE EXCEPTION 'readback lease owner must be the bound active Ctrip bridge' USING ERRCODE = '42501'; END IF;
  IF NEW.cancelled_by_actor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM geo.tenant_memberships AS membership
    WHERE membership.tenant_id = NEW.tenant_id AND membership.user_id = NEW.cancelled_by_actor_id
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin', 'publisher')
      AND membership.capabilities @> '["publish:cancel"]'::jsonb
  ) THEN RAISE EXCEPTION 'handoff cancellation requires an active publication operator' USING ERRCODE = '42501'; END IF;

  IF (to_jsonb(OLD) - ARRAY[
        'state', 'lease_owner_actor_id', 'lease_expires_at', 'heartbeat_at',
        'draft_prepare_owner_principal_id', 'draft_prepare_lease_expires_at',
        'readback_owner_principal_id', 'readback_lease_expires_at',
        'session_evidence_hash', 'draft_evidence_hash', 'prepare_outcome',
        'prepare_evidence_kind', 'prepare_evidence_hash', 'prepare_observed_at',
        'media_manifest_hash', 'public_content_hash', 'submit_evidence_hash',
        'submit_permit_hash', 'submit_permit_expires_at', 'submit_permit_consumed_at',
        'submit_permit_issued_by_actor_id', 'submit_permit_issued_by_principal_id',
        'submit_permit_consumed_by_principal_id', 'submit_outcome', 'submit_evidence_kind',
        'submit_observed_at', 'submit_candidate_external_id', 'submit_candidate_external_url',
        'publication_receipt_id', 'publication_readback_id', 'readback_outcome',
        'readback_evidence_kind', 'readback_evidence_hash', 'readback_observed_at',
        'readback_attempt_count', 'readback_deadline_at', 'observed_payload_hash',
        'external_draft_id', 'external_id', 'external_url', 'cancelled_at',
        'cancelled_by_actor_id', 'cancellation_reason', 'last_error_code',
        'last_error_message', 'updated_at'
      ]) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY[
        'state', 'lease_owner_actor_id', 'lease_expires_at', 'heartbeat_at',
        'draft_prepare_owner_principal_id', 'draft_prepare_lease_expires_at',
        'readback_owner_principal_id', 'readback_lease_expires_at',
        'session_evidence_hash', 'draft_evidence_hash', 'prepare_outcome',
        'prepare_evidence_kind', 'prepare_evidence_hash', 'prepare_observed_at',
        'media_manifest_hash', 'public_content_hash', 'submit_evidence_hash',
        'submit_permit_hash', 'submit_permit_expires_at', 'submit_permit_consumed_at',
        'submit_permit_issued_by_actor_id', 'submit_permit_issued_by_principal_id',
        'submit_permit_consumed_by_principal_id', 'submit_outcome', 'submit_evidence_kind',
        'submit_observed_at', 'submit_candidate_external_id', 'submit_candidate_external_url',
        'publication_receipt_id', 'publication_readback_id', 'readback_outcome',
        'readback_evidence_kind', 'readback_evidence_hash', 'readback_observed_at',
        'readback_attempt_count', 'readback_deadline_at', 'observed_payload_hash',
        'external_draft_id', 'external_id', 'external_url', 'cancelled_at',
        'cancelled_by_actor_id', 'cancellation_reason', 'last_error_code',
        'last_error_message', 'updated_at'
      ]) THEN
    RAISE EXCEPTION 'publication assisted handoff request fields are immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    NEW.state = OLD.state OR
    (OLD.state = 'handoff_pending' AND NEW.state IN ('session_required', 'challenge_required', 'draft_prepared', 'cancelled', 'expired', 'failed')) OR
    (OLD.state IN ('session_required', 'challenge_required') AND NEW.state IN ('handoff_pending', 'session_required', 'challenge_required', 'draft_prepared', 'cancelled', 'expired', 'failed')) OR
    (OLD.state = 'draft_prepared' AND NEW.state IN ('awaiting_operator_submit', 'cancelled', 'expired', 'failed')) OR
    (OLD.state = 'awaiting_operator_submit' AND NEW.state IN ('submitted_unconfirmed', 'cancelled', 'expired', 'failed')) OR
    (OLD.state = 'submitted_unconfirmed' AND NEW.state IN ('readback_pending', 'needs_review', 'failed')) OR
    (OLD.state = 'readback_pending' AND NEW.state IN ('confirmed', 'needs_review', 'failed'))
  ) THEN
    RAISE EXCEPTION 'invalid publication assisted handoff transition from % to %', OLD.state, NEW.state USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('confirmed', 'needs_review', 'cancelled', 'expired', 'failed') AND to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
    RAISE EXCEPTION 'terminal publication assisted handoffs are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

UPDATE geo.publication_assisted_handoffs
SET readback_deadline_at = COALESCE(submit_observed_at, updated_at) + interval '30 minutes'
WHERE state = 'readback_pending' AND readback_deadline_at IS NULL;

ALTER TABLE geo.publication_assisted_handoffs
  ADD CONSTRAINT publication_assisted_handoff_readback_deadline
    CHECK (state <> 'readback_pending' OR readback_deadline_at IS NOT NULL) NOT VALID;

ALTER TABLE geo.publication_assisted_handoffs
  VALIDATE CONSTRAINT publication_assisted_handoff_readback_attempt_count,
  VALIDATE CONSTRAINT publication_assisted_handoff_readback_deadline;

CREATE OR REPLACE FUNCTION geo.apply_ctrip_readback_budget()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF NEW.state = 'readback_pending' AND OLD.state IS DISTINCT FROM 'readback_pending' THEN
    NEW.readback_attempt_count := 0;
    NEW.readback_deadline_at := COALESCE(NEW.submit_observed_at, statement_timestamp()) + interval '30 minutes';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER publication_assisted_handoff_00_readback_budget
BEFORE UPDATE OF state ON geo.publication_assisted_handoffs
FOR EACH ROW EXECUTE FUNCTION geo.apply_ctrip_readback_budget();

REVOKE ALL ON FUNCTION geo.record_publication_assisted_draft(
  uuid, geo.sha256_hex, geo.sha256_hex, geo.sha256_hex, geo.sha256_hex,
  text, timestamptz, text, text
) FROM PUBLIC, geo_runtime;

DROP FUNCTION geo.record_publication_assisted_draft(
  uuid, geo.sha256_hex, geo.sha256_hex, geo.sha256_hex, geo.sha256_hex,
  text, timestamptz, text, text
);

CREATE FUNCTION geo.record_publication_assisted_draft(
  p_handoff_id uuid,
  p_session_evidence_hash geo.sha256_hex,
  p_draft_evidence_hash geo.sha256_hex,
  p_prepare_evidence_hash geo.sha256_hex,
  p_media_manifest_hash geo.sha256_hex,
  p_public_content_hash geo.sha256_hex,
  p_prepare_evidence_kind text,
  p_prepare_observed_at timestamptz,
  p_external_draft_id text,
  p_adapter_version text
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
  block_reason text;
BEGIN
  IF p_session_evidence_hash IS NULL OR p_draft_evidence_hash IS NULL
     OR p_prepare_evidence_hash IS NULL OR p_media_manifest_hash IS NULL
     OR p_public_content_hash IS NULL OR p_prepare_evidence_kind IS NULL
     OR p_prepare_evidence_kind NOT IN ('simulation', 'browser')
     OR p_prepare_observed_at IS NULL
     OR p_prepare_observed_at > statement_timestamp() + interval '1 minute'
     OR p_prepare_observed_at < statement_timestamp() - interval '30 minutes'
     OR p_external_draft_id IS NULL
     OR length(trim(p_external_draft_id)) NOT BETWEEN 1 AND 500
     OR p_adapter_version IS NULL OR length(trim(p_adapter_version)) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid assisted draft evidence' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id
  FOR UPDATE;
  IF handoff.id IS NULL THEN RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002'; END IF;
  IF handoff.expires_at <= statement_timestamp() THEN RAISE EXCEPTION 'assisted handoff has expired' USING ERRCODE = '55000'; END IF;
  IF handoff.draft_prepare_owner_principal_id <> actor_value
     OR handoff.draft_prepare_lease_expires_at < statement_timestamp() THEN
    RAISE EXCEPTION 'draft evidence requires the current draft preparation lease' USING ERRCODE = '55006';
  END IF;
  IF handoff.state NOT IN ('handoff_pending', 'session_required', 'challenge_required') THEN
    RAISE EXCEPTION 'draft evidence cannot be recorded in state %', handoff.state USING ERRCODE = '55000';
  END IF;
  IF handoff.adapter_version <> trim(p_adapter_version) THEN
    RAISE EXCEPTION 'draft adapter version does not match the reviewed handoff' USING ERRCODE = '42501';
  END IF;
  block_reason := geo.publication_assisted_block_reason(handoff.job_id);
  IF block_reason IS NOT NULL THEN RAISE EXCEPTION 'draft preparation blocked: %', block_reason USING ERRCODE = '42501'; END IF;

  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = 'draft_prepared', session_evidence_hash = p_session_evidence_hash,
      draft_evidence_hash = p_draft_evidence_hash, prepare_outcome = 'prepared',
      prepare_evidence_hash = p_prepare_evidence_hash,
      prepare_evidence_kind = p_prepare_evidence_kind,
      prepare_observed_at = p_prepare_observed_at,
      media_manifest_hash = p_media_manifest_hash,
      public_content_hash = p_public_content_hash,
      external_draft_id = trim(p_external_draft_id),
      draft_prepare_owner_principal_id = NULL,
      draft_prepare_lease_expires_at = NULL,
      last_error_code = NULL, last_error_message = NULL,
      updated_at = clock_timestamp()
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.draft_prepared',
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    p_prepare_evidence_hash,
    jsonb_build_object(
      'prepareOutcome', 'prepared', 'sessionEvidenceHash', p_session_evidence_hash,
      'draftEvidenceHash', p_draft_evidence_hash, 'mediaManifestHash', p_media_manifest_hash,
      'publicContentHash', p_public_content_hash, 'evidenceKind', p_prepare_evidence_kind,
      'observedAt', p_prepare_observed_at,
      'externalDraftIdHash', encode(public.digest(trim(p_external_draft_id), 'sha256'), 'hex')
    )
  );
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION geo.record_publication_assisted_readback(
  p_handoff_id uuid,
  p_outcome text,
  p_evidence_kind text,
  p_evidence_hash geo.sha256_hex,
  p_observed_payload_hash geo.sha256_hex,
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
  next_state text;
  readback_status text;
  readback_error text;
  recorded_outcome text := p_outcome;
  next_attempt_count integer;
  exhausted boolean := false;
  normalized_external_id text := NULLIF(trim(p_external_id), '');
  normalized_external_url text := NULLIF(trim(p_external_url), '');
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('confirmed', 'not_found', 'mismatch', 'unavailable', 'simulation_only')
     OR p_evidence_kind IS NULL OR p_evidence_kind NOT IN ('simulation', 'browser', 'platform_readback')
     OR p_observed_at IS NULL OR p_observed_at > statement_timestamp() + interval '1 minute'
     OR p_observed_at < statement_timestamp() - interval '24 hours' THEN
    RAISE EXCEPTION 'invalid assisted readback observation' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO handoff FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id FOR UPDATE;
  IF handoff.id IS NULL THEN RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO job FROM geo.publication_jobs AS publication_job
  WHERE publication_job.tenant_id = tenant_value AND publication_job.id = handoff.job_id;
  IF handoff.state <> 'readback_pending' OR handoff.publication_receipt_id IS NULL
     OR handoff.publication_readback_id IS NULL OR handoff.readback_deadline_at IS NULL THEN
    RAISE EXCEPTION 'readback requires a pending browser publication observation' USING ERRCODE = '55000';
  END IF;
  IF job.execution_level = 'unattended' AND (
       handoff.readback_owner_principal_id <> actor_value OR
       handoff.readback_lease_expires_at < statement_timestamp()
     ) THEN
    RAISE EXCEPTION 'unattended readback requires the current bridge lease' USING ERRCODE = '55006';
  END IF;
  IF p_observed_at < handoff.submit_observed_at - interval '1 minute' THEN
    RAISE EXCEPTION 'readback predates the submit observation' USING ERRCODE = '22023';
  END IF;

  next_attempt_count := handoff.readback_attempt_count + 1;
  IF p_outcome = 'confirmed' THEN
    IF p_evidence_kind <> 'platform_readback'
       OR normalized_external_id IS NULL OR length(normalized_external_id) > 500
       OR normalized_external_url IS NULL OR length(normalized_external_url) > 2000
       OR normalized_external_url !~* '^https://([a-z0-9-]+\.)*ctrip\.com(?::443)?/' THEN
      RAISE EXCEPTION 'confirmed readback requires public Ctrip identity evidence' USING ERRCODE = '23514';
    END IF;
    IF handoff.public_content_hash IS NULL
       OR p_observed_payload_hash IS DISTINCT FROM handoff.public_content_hash THEN
      next_state := 'needs_review'; readback_status := 'failed';
      readback_error := 'ASSISTED_READBACK_CONTENT_BINDING_MISMATCH';
      recorded_outcome := 'mismatch';
    ELSE
      next_state := 'confirmed'; readback_status := 'succeeded'; readback_error := NULL;
    END IF;
  ELSIF p_outcome = 'unavailable' THEN
    IF normalized_external_id IS NOT NULL OR normalized_external_url IS NOT NULL THEN
      RAISE EXCEPTION 'unavailable readback cannot claim external identity' USING ERRCODE = '23514';
    END IF;
    exhausted := next_attempt_count >= 20 OR p_observed_at >= handoff.readback_deadline_at;
    IF exhausted THEN
      next_state := 'needs_review'; readback_status := 'failed';
      readback_error := CASE
        WHEN p_observed_at >= handoff.readback_deadline_at THEN 'ASSISTED_READBACK_DEADLINE_EXCEEDED'
        ELSE 'ASSISTED_READBACK_ATTEMPTS_EXHAUSTED'
      END;
    ELSE
      next_state := 'readback_pending'; readback_status := 'pending';
      readback_error := 'ASSISTED_READBACK_UNAVAILABLE';
    END IF;
  ELSE
    IF normalized_external_id IS NOT NULL OR normalized_external_url IS NOT NULL THEN
      RAISE EXCEPTION 'unconfirmed readback cannot persist external identity' USING ERRCODE = '23514';
    END IF;
    IF p_outcome = 'simulation_only' AND p_evidence_kind <> 'simulation' THEN
      RAISE EXCEPTION 'simulation-only readback requires simulation evidence' USING ERRCODE = '23514';
    END IF;
    IF p_outcome <> 'simulation_only' AND p_evidence_kind = 'simulation' THEN
      RAISE EXCEPTION 'simulation evidence must remain explicitly simulation-only' USING ERRCODE = '23514';
    END IF;
    next_state := 'needs_review'; readback_status := 'failed';
    readback_error := CASE p_outcome
      WHEN 'simulation_only' THEN 'SIMULATION_ONLY'
      WHEN 'mismatch' THEN 'ASSISTED_READBACK_MISMATCH'
      ELSE 'ASSISTED_READBACK_NOT_FOUND'
    END;
  END IF;

  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = next_state, readback_outcome = recorded_outcome,
      readback_evidence_kind = p_evidence_kind,
      readback_evidence_hash = p_evidence_hash, readback_observed_at = p_observed_at,
      readback_attempt_count = next_attempt_count,
      observed_payload_hash = p_observed_payload_hash,
      external_id = CASE WHEN next_state = 'confirmed' THEN normalized_external_id ELSE NULL END,
      external_url = CASE WHEN next_state = 'confirmed' THEN normalized_external_url ELSE NULL END,
      readback_owner_principal_id = NULL, readback_lease_expires_at = NULL,
      last_error_code = readback_error,
      last_error_message = CASE
        WHEN next_state = 'confirmed' THEN NULL
        WHEN readback_error = 'ASSISTED_READBACK_CONTENT_BINDING_MISMATCH' THEN 'Public content did not match the prepared content binding'
        WHEN readback_error IN ('ASSISTED_READBACK_DEADLINE_EXCEEDED', 'ASSISTED_READBACK_ATTEMPTS_EXHAUSTED') THEN 'Public readback budget was exhausted; operator review is required'
        WHEN p_outcome = 'simulation_only' THEN 'Simulator evidence cannot confirm a live publication'
        WHEN p_outcome = 'unavailable' THEN 'Public readback is temporarily unavailable'
        WHEN p_outcome = 'mismatch' THEN 'Public readback did not match the audited payload'
        ELSE 'Public publication was not found within the readback window'
      END
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id;

  UPDATE geo.publication_readbacks AS readback
  SET status = readback_status,
      completed_at = CASE WHEN readback_status IN ('succeeded', 'failed') THEN clock_timestamp() ELSE NULL END,
      last_error = readback_error
  WHERE readback.tenant_id = tenant_value AND readback.id = handoff.publication_readback_id;
  UPDATE geo.publication_jobs AS publication_job
  SET state = CASE
        WHEN next_state = 'confirmed' THEN 'confirmed'
        WHEN next_state = 'needs_review' THEN 'needs_review'
        ELSE 'uncertain'
      END,
      confirmed_at = CASE WHEN next_state = 'confirmed' THEN clock_timestamp() ELSE NULL END,
      last_error_code = readback_error
  WHERE publication_job.tenant_id = tenant_value AND publication_job.id = handoff.job_id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id, request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value,
    CASE next_state
      WHEN 'confirmed' THEN 'publication_assisted_handoff.confirmed'
      WHEN 'needs_review' THEN 'publication_assisted_handoff.needs_review'
      ELSE 'publication_assisted_handoff.readback_pending'
    END,
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    p_evidence_hash,
    jsonb_build_object(
      'reportedOutcome', p_outcome, 'outcome', recorded_outcome,
      'evidenceKind', p_evidence_kind, 'confirmed', next_state = 'confirmed',
      'attemptCount', next_attempt_count, 'attemptLimit', 20,
      'deadlineAt', handoff.readback_deadline_at, 'exhausted', exhausted,
      'externalIdHash', CASE WHEN normalized_external_id IS NULL THEN NULL ELSE encode(public.digest(normalized_external_id, 'sha256'), 'hex') END,
      'externalUrlHash', CASE WHEN normalized_external_url IS NULL THEN NULL ELSE encode(public.digest(normalized_external_url, 'sha256'), 'hex') END,
      'executionLevel', job.execution_level
    )
  );
  RETURN QUERY SELECT next_state,
    CASE WHEN next_state = 'confirmed' THEN normalized_external_id ELSE NULL END,
    CASE WHEN next_state = 'confirmed' THEN normalized_external_url ELSE NULL END;
END
$$;

CREATE INDEX publication_assisted_handoffs_readback_deadline
  ON geo.publication_assisted_handoffs (tenant_id, readback_deadline_at, id)
  WHERE state = 'readback_pending';

REVOKE ALL ON FUNCTION geo.record_publication_assisted_draft(
  uuid, geo.sha256_hex, geo.sha256_hex, geo.sha256_hex, geo.sha256_hex,
  geo.sha256_hex, text, timestamptz, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_draft(
  uuid, geo.sha256_hex, geo.sha256_hex, geo.sha256_hex, geo.sha256_hex,
  geo.sha256_hex, text, timestamptz, text, text
) TO geo_runtime;
REVOKE ALL ON FUNCTION geo.record_publication_assisted_readback(
  uuid, text, text, geo.sha256_hex, geo.sha256_hex, text, text, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_readback(
  uuid, text, text, geo.sha256_hex, geo.sha256_hex, text, text, timestamptz
) TO geo_runtime;
