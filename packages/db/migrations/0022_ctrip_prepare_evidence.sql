ALTER TABLE geo.publication_assisted_handoffs
  ADD COLUMN prepare_outcome text
    CHECK (prepare_outcome IN (
      'prepared', 'session_required', 'challenge_required', 'adapter_drift'
    )),
  ADD COLUMN prepare_evidence_kind text
    CHECK (prepare_evidence_kind IN ('simulation', 'browser')),
  ADD COLUMN prepare_evidence_hash geo.sha256_hex,
  ADD COLUMN prepare_observed_at timestamptz,
  ADD COLUMN media_manifest_hash geo.sha256_hex,
  ADD CONSTRAINT publication_assisted_handoff_prepare_observation_complete
    CHECK (
      (prepare_outcome IS NULL AND prepare_evidence_kind IS NULL AND
       prepare_evidence_hash IS NULL AND prepare_observed_at IS NULL AND
       media_manifest_hash IS NULL) OR
      (prepare_outcome IS NOT NULL AND prepare_evidence_kind IS NOT NULL AND
       prepare_evidence_hash IS NOT NULL AND prepare_observed_at IS NOT NULL AND
       session_evidence_hash IS NOT NULL AND (
         (prepare_outcome = 'prepared' AND media_manifest_hash IS NOT NULL AND
          draft_evidence_hash IS NOT NULL AND external_draft_id IS NOT NULL) OR
         (prepare_outcome <> 'prepared' AND media_manifest_hash IS NULL)
       ))
    ) NOT VALID;

REVOKE ALL ON FUNCTION geo.record_publication_assisted_bridge_status(
  uuid, text, geo.sha256_hex, text, text
) FROM PUBLIC, geo_runtime;
REVOKE ALL ON FUNCTION geo.record_publication_assisted_draft(
  uuid, geo.sha256_hex, geo.sha256_hex, text, text
) FROM PUBLIC, geo_runtime;

DROP FUNCTION geo.record_publication_assisted_bridge_status(
  uuid, text, geo.sha256_hex, text, text
);
DROP FUNCTION geo.record_publication_assisted_draft(
  uuid, geo.sha256_hex, geo.sha256_hex, text, text
);

CREATE OR REPLACE FUNCTION geo.record_publication_assisted_bridge_status(
  p_handoff_id uuid,
  p_status text,
  p_session_evidence_hash geo.sha256_hex,
  p_prepare_evidence_hash geo.sha256_hex,
  p_prepare_evidence_kind text,
  p_prepare_observed_at timestamptz,
  p_adapter_version text,
  p_error_code text DEFAULT NULL
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
BEGIN
  IF p_status NOT IN ('session_required', 'challenge_required', 'failed')
     OR p_session_evidence_hash IS NULL OR p_prepare_evidence_hash IS NULL
     OR p_prepare_evidence_kind IS NULL
     OR p_prepare_evidence_kind NOT IN ('simulation', 'browser')
     OR p_prepare_observed_at IS NULL
     OR p_prepare_observed_at > statement_timestamp() + interval '1 minute'
     OR p_prepare_observed_at < statement_timestamp() - interval '30 minutes'
     OR p_adapter_version IS NULL OR length(trim(p_adapter_version)) NOT BETWEEN 1 AND 100
     OR (p_status = 'failed' AND
       COALESCE(NULLIF(trim(p_error_code), ''), 'ASSISTED_ADAPTER_DRIFT') <>
         'ASSISTED_ADAPTER_DRIFT') THEN
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
  IF handoff.lease_owner_actor_id IS NULL
     OR handoff.lease_expires_at < statement_timestamp() THEN
    RAISE EXCEPTION 'bridge status requires a current operator lease' USING ERRCODE = '55006';
  END IF;
  IF handoff.state NOT IN ('handoff_pending', 'session_required', 'challenge_required') THEN
    RAISE EXCEPTION 'bridge status cannot be recorded in state %', handoff.state
      USING ERRCODE = '55000';
  END IF;
  IF handoff.adapter_version <> trim(p_adapter_version) THEN
    RAISE EXCEPTION 'bridge adapter version does not match the reviewed handoff'
      USING ERRCODE = '42501';
  END IF;

  next_error_code := CASE
    WHEN p_status = 'session_required' THEN 'ASSISTED_SESSION_REQUIRED'
    WHEN p_status = 'challenge_required' THEN 'ASSISTED_CHALLENGE_REQUIRED'
    ELSE COALESCE(NULLIF(trim(p_error_code), ''), 'ASSISTED_ADAPTER_DRIFT')
  END;

  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = p_status,
      session_evidence_hash = p_session_evidence_hash,
      prepare_outcome = CASE
        WHEN p_status = 'failed' THEN 'adapter_drift'
        ELSE p_status
      END,
      prepare_evidence_hash = p_prepare_evidence_hash,
      prepare_evidence_kind = p_prepare_evidence_kind,
      prepare_observed_at = p_prepare_observed_at,
      media_manifest_hash = NULL,
      last_error_code = next_error_code,
      last_error_message = NULL,
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
      'prepareOutcome', CASE WHEN p_status = 'failed' THEN 'adapter_drift' ELSE p_status END,
      'sessionEvidenceHash', p_session_evidence_hash,
      'evidenceKind', p_prepare_evidence_kind,
      'observedAt', p_prepare_observed_at,
      'errorCode', next_error_code
    )
  );
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION geo.record_publication_assisted_draft(
  p_handoff_id uuid,
  p_session_evidence_hash geo.sha256_hex,
  p_draft_evidence_hash geo.sha256_hex,
  p_prepare_evidence_hash geo.sha256_hex,
  p_media_manifest_hash geo.sha256_hex,
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
     OR p_prepare_evidence_kind IS NULL
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

  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002';
  END IF;
  IF handoff.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'assisted handoff has expired' USING ERRCODE = '55000';
  END IF;
  IF handoff.lease_owner_actor_id IS NULL
     OR handoff.lease_expires_at < statement_timestamp() THEN
    RAISE EXCEPTION 'draft evidence requires a current operator lease'
      USING ERRCODE = '55006';
  END IF;
  IF handoff.state NOT IN ('handoff_pending', 'session_required', 'challenge_required') THEN
    RAISE EXCEPTION 'draft evidence cannot be recorded in state %', handoff.state
      USING ERRCODE = '55000';
  END IF;
  IF handoff.adapter_version <> trim(p_adapter_version) THEN
    RAISE EXCEPTION 'draft adapter version does not match the reviewed handoff'
      USING ERRCODE = '42501';
  END IF;

  block_reason := geo.publication_assisted_block_reason(handoff.job_id);
  IF block_reason IS NOT NULL THEN
    RAISE EXCEPTION 'draft preparation blocked: %', block_reason USING ERRCODE = '42501';
  END IF;

  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = 'draft_prepared',
      session_evidence_hash = p_session_evidence_hash,
      draft_evidence_hash = p_draft_evidence_hash,
      prepare_outcome = 'prepared',
      prepare_evidence_hash = p_prepare_evidence_hash,
      prepare_evidence_kind = p_prepare_evidence_kind,
      prepare_observed_at = p_prepare_observed_at,
      media_manifest_hash = p_media_manifest_hash,
      external_draft_id = trim(p_external_draft_id),
      last_error_code = NULL,
      last_error_message = NULL,
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
      'prepareOutcome', 'prepared',
      'sessionEvidenceHash', p_session_evidence_hash,
      'draftEvidenceHash', p_draft_evidence_hash,
      'mediaManifestHash', p_media_manifest_hash,
      'evidenceKind', p_prepare_evidence_kind,
      'observedAt', p_prepare_observed_at,
      'externalDraftIdHash', encode(public.digest(trim(p_external_draft_id), 'sha256'), 'hex')
    )
  );
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION geo.enforce_publication_assisted_handoff_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'publication assisted handoffs cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.lease_owner_actor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM geo.tenant_memberships AS membership
    WHERE membership.tenant_id = NEW.tenant_id
      AND membership.user_id = NEW.lease_owner_actor_id
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'admin', 'publisher')
      AND membership.capabilities @> '["publish:request"]'::jsonb
  ) THEN
    RAISE EXCEPTION 'handoff lease owner must be an active publication operator'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.cancelled_by_actor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM geo.tenant_memberships AS membership
    WHERE membership.tenant_id = NEW.tenant_id
      AND membership.user_id = NEW.cancelled_by_actor_id
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'admin', 'publisher')
      AND membership.capabilities @> '["publish:cancel"]'::jsonb
  ) THEN
    RAISE EXCEPTION 'handoff cancellation requires an active publication operator'
      USING ERRCODE = '42501';
  END IF;

  IF (to_jsonb(OLD) - ARRAY[
        'state', 'lease_owner_actor_id', 'lease_expires_at', 'heartbeat_at',
        'session_evidence_hash', 'draft_evidence_hash',
        'prepare_outcome', 'prepare_evidence_kind', 'prepare_evidence_hash',
        'prepare_observed_at', 'media_manifest_hash', 'submit_evidence_hash',
        'submit_permit_hash', 'submit_permit_expires_at', 'submit_permit_consumed_at',
        'submit_permit_issued_by_actor_id', 'submit_permit_consumed_by_principal_id',
        'submit_outcome', 'submit_evidence_kind', 'submit_observed_at',
        'publication_receipt_id', 'publication_readback_id',
        'readback_outcome', 'readback_evidence_kind', 'readback_evidence_hash',
        'readback_observed_at', 'observed_payload_hash',
        'external_draft_id', 'external_id', 'external_url', 'cancelled_at',
        'cancelled_by_actor_id', 'cancellation_reason', 'last_error_code',
        'last_error_message', 'updated_at'
      ]) IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY[
        'state', 'lease_owner_actor_id', 'lease_expires_at', 'heartbeat_at',
        'session_evidence_hash', 'draft_evidence_hash',
        'prepare_outcome', 'prepare_evidence_kind', 'prepare_evidence_hash',
        'prepare_observed_at', 'media_manifest_hash', 'submit_evidence_hash',
        'submit_permit_hash', 'submit_permit_expires_at', 'submit_permit_consumed_at',
        'submit_permit_issued_by_actor_id', 'submit_permit_consumed_by_principal_id',
        'submit_outcome', 'submit_evidence_kind', 'submit_observed_at',
        'publication_receipt_id', 'publication_readback_id',
        'readback_outcome', 'readback_evidence_kind', 'readback_evidence_hash',
        'readback_observed_at', 'observed_payload_hash',
        'external_draft_id', 'external_id', 'external_url', 'cancelled_at',
        'cancelled_by_actor_id', 'cancellation_reason', 'last_error_code',
        'last_error_message', 'updated_at'
      ]) THEN
    RAISE EXCEPTION 'publication assisted handoff request fields are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NOT (
    NEW.state = OLD.state OR
    (OLD.state = 'handoff_pending' AND NEW.state IN (
      'session_required', 'challenge_required', 'draft_prepared',
      'cancelled', 'expired', 'failed'
    )) OR
    (OLD.state IN ('session_required', 'challenge_required') AND NEW.state IN (
      'handoff_pending', 'session_required', 'challenge_required',
      'draft_prepared', 'cancelled', 'expired', 'failed'
    )) OR
    (OLD.state = 'draft_prepared' AND NEW.state IN (
      'awaiting_operator_submit', 'cancelled', 'expired', 'failed'
    )) OR
    (OLD.state = 'awaiting_operator_submit' AND NEW.state IN (
      'submitted_unconfirmed', 'cancelled', 'expired', 'failed'
    )) OR
    (OLD.state = 'submitted_unconfirmed' AND NEW.state IN (
      'readback_pending', 'needs_review', 'failed'
    )) OR
    (OLD.state = 'readback_pending' AND NEW.state IN (
      'confirmed', 'needs_review', 'failed'
    ))
  ) THEN
    RAISE EXCEPTION 'invalid publication assisted handoff transition from % to %',
      OLD.state, NEW.state USING ERRCODE = '55000';
  END IF;

  IF OLD.state IN ('confirmed', 'needs_review', 'cancelled', 'expired', 'failed')
     AND to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
    RAISE EXCEPTION 'terminal publication assisted handoffs are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION geo.record_publication_assisted_bridge_status(
  uuid, text, geo.sha256_hex, geo.sha256_hex, text, timestamptz, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.record_publication_assisted_draft(
  uuid, geo.sha256_hex, geo.sha256_hex, geo.sha256_hex, geo.sha256_hex,
  text, timestamptz, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_bridge_status(
  uuid, text, geo.sha256_hex, geo.sha256_hex, text, timestamptz, text, text
) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_draft(
  uuid, geo.sha256_hex, geo.sha256_hex, geo.sha256_hex, geo.sha256_hex,
  text, timestamptz, text, text
) TO geo_runtime;
