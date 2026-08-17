ALTER TABLE geo.publication_assisted_handoffs
  ADD COLUMN submit_candidate_external_id text
    CHECK (
      submit_candidate_external_id IS NULL OR
      length(submit_candidate_external_id) BETWEEN 1 AND 500
    ),
  ADD COLUMN submit_candidate_external_url text
    CHECK (
      submit_candidate_external_url IS NULL OR
      (
        length(submit_candidate_external_url) BETWEEN 1 AND 2000 AND
        submit_candidate_external_url ~* '^https://([a-z0-9-]+\.)*ctrip\.com(?::443)?/[^[:space:]?#]*$'
      )
    ),
  ADD CONSTRAINT publication_assisted_handoff_submit_candidate_complete
    CHECK (
      (submit_candidate_external_id IS NULL AND submit_candidate_external_url IS NULL) OR
      (submit_candidate_external_id IS NOT NULL AND submit_candidate_external_url IS NOT NULL AND
       submit_outcome IN ('accepted', 'uncertain') AND submit_evidence_kind = 'browser')
    ) NOT VALID,
  ADD CONSTRAINT publication_assisted_handoff_confirmed_candidate_match
    CHECK (
      state <> 'confirmed' OR submit_candidate_external_id IS NULL OR
      (external_id = submit_candidate_external_id AND
       external_url = submit_candidate_external_url)
    ) NOT VALID;

REVOKE ALL ON FUNCTION geo.record_publication_assisted_submit_observation(
  uuid, text, text, geo.sha256_hex, timestamptz
) FROM PUBLIC, geo_runtime;

DROP FUNCTION geo.record_publication_assisted_submit_observation(
  uuid, text, text, geo.sha256_hex, timestamptz
);

CREATE OR REPLACE FUNCTION geo.record_publication_assisted_submit_observation(
  p_handoff_id uuid,
  p_outcome text,
  p_evidence_kind text,
  p_evidence_hash geo.sha256_hex,
  p_candidate_external_id text,
  p_candidate_external_url text,
  p_observed_at timestamptz
)
RETURNS TABLE (
  publication_receipt_id uuid,
  publication_readback_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_bound_ctrip_bridge(p_handoff_id);
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  attempt geo.publication_attempts%ROWTYPE;
  receipt_value uuid;
  readback_value uuid;
  attempt_error_code text;
  attempt_error_message text;
  normalized_candidate_id text := NULLIF(trim(p_candidate_external_id), '');
  normalized_candidate_url text := NULLIF(trim(p_candidate_external_url), '');
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('accepted', 'uncertain', 'rejected')
     OR p_evidence_kind IS NULL OR p_evidence_kind NOT IN ('simulation', 'browser')
     OR p_observed_at IS NULL
     OR p_observed_at > statement_timestamp() + interval '1 minute'
     OR p_observed_at < statement_timestamp() - interval '30 minutes'
     OR (normalized_candidate_id IS NULL) <> (normalized_candidate_url IS NULL)
     OR (normalized_candidate_id IS NOT NULL AND (
       length(normalized_candidate_id) > 500 OR
       length(normalized_candidate_url) > 2000 OR
       normalized_candidate_url !~* '^https://([a-z0-9-]+\.)*ctrip\.com(?::443)?/[^[:space:]?#]*$'
     ))
     OR (p_evidence_kind = 'simulation' AND normalized_candidate_id IS NOT NULL)
     OR (p_outcome = 'rejected' AND normalized_candidate_id IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid assisted submit observation' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id
  FOR UPDATE;

  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002';
  END IF;

  IF handoff.submit_outcome IS NOT NULL THEN
    IF handoff.submit_outcome <> p_outcome
       OR handoff.submit_evidence_kind <> p_evidence_kind
       OR handoff.submit_evidence_hash <> p_evidence_hash
       OR handoff.submit_candidate_external_id IS DISTINCT FROM normalized_candidate_id
       OR handoff.submit_candidate_external_url IS DISTINCT FROM normalized_candidate_url
       OR handoff.submit_observed_at <> p_observed_at
       OR handoff.publication_receipt_id IS NULL
       OR handoff.publication_readback_id IS NULL THEN
      RAISE EXCEPTION 'assisted submit observation conflicts with durable evidence'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT handoff.publication_receipt_id, handoff.publication_readback_id;
    RETURN;
  END IF;

  IF handoff.state <> 'awaiting_operator_submit'
     OR handoff.submit_permit_consumed_at IS NULL
     OR handoff.submit_permit_consumed_by_principal_id <> actor_value
     OR handoff.submit_permit_issued_by_actor_id IS NULL
     OR handoff.submit_evidence_hash IS NOT NULL THEN
    RAISE EXCEPTION 'submit observation requires one consumed bound permit'
      USING ERRCODE = '55000';
  END IF;
  IF p_observed_at < handoff.submit_permit_consumed_at - interval '1 minute' THEN
    RAISE EXCEPTION 'submit observation predates permit consumption' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO attempt
  FROM geo.publication_attempts AS publication_attempt
  WHERE publication_attempt.tenant_id = tenant_value
    AND publication_attempt.id = handoff.attempt_id
    AND publication_attempt.job_id = handoff.job_id
  FOR UPDATE;

  IF attempt.id IS NULL OR attempt.state <> 'started' THEN
    RAISE EXCEPTION 'submit observation requires the active publication attempt'
      USING ERRCODE = '55000';
  END IF;

  receipt_value := gen_random_uuid();
  readback_value := gen_random_uuid();
  attempt_error_code := CASE p_outcome
    WHEN 'accepted' THEN 'ASSISTED_READBACK_REQUIRED'
    WHEN 'uncertain' THEN 'ASSISTED_SUBMIT_UNCERTAIN'
    ELSE 'ASSISTED_SUBMIT_REJECTED'
  END;
  attempt_error_message := CASE p_outcome
    WHEN 'accepted' THEN 'Bridge observed submit acknowledgement; independent readback is required'
    WHEN 'uncertain' THEN 'Bridge crossed the submit boundary but could not classify the outcome'
    ELSE 'Bridge observed a submit rejection; operator review is required before any new attempt'
  END;

  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = 'submitted_unconfirmed',
      submit_evidence_hash = p_evidence_hash,
      submit_outcome = p_outcome,
      submit_evidence_kind = p_evidence_kind,
      submit_observed_at = p_observed_at,
      submit_candidate_external_id = normalized_candidate_id,
      submit_candidate_external_url = normalized_candidate_url,
      last_error_code = attempt_error_code,
      last_error_message = attempt_error_message
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id;

  UPDATE geo.publication_attempts AS publication_attempt
  SET state = 'uncertain',
      response_hash = p_evidence_hash,
      error_code = attempt_error_code,
      error_message = attempt_error_message,
      finished_at = clock_timestamp()
  WHERE publication_attempt.tenant_id = tenant_value AND publication_attempt.id = handoff.attempt_id;

  UPDATE geo.publication_jobs AS publication_job
  SET state = 'uncertain',
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error_code = attempt_error_code
  WHERE publication_job.tenant_id = tenant_value AND publication_job.id = handoff.job_id;

  INSERT INTO geo.publication_receipts (
    tenant_id, id, job_id, attempt_id, platform, execution_level,
    evidence_type, request_hash, response_hash, external_id, external_url,
    published_at, recorded_at, confirmed, payload
  ) VALUES (
    tenant_value, receipt_value, handoff.job_id, handoff.attempt_id,
    'ctrip_community', 'assisted',
    CASE p_evidence_kind WHEN 'simulation' THEN 'fixture' ELSE 'browser_screenshot' END,
    attempt.request_hash, p_evidence_hash, NULL, NULL, NULL,
    clock_timestamp(), false,
    jsonb_build_object(
      'schemaVersion', 'geo.ctrip-assisted-receipt.v1',
      'outcome', p_outcome,
      'evidenceKind', p_evidence_kind,
      'previewHash', handoff.preview_hash,
      'candidateExternalIdHash', CASE WHEN normalized_candidate_id IS NULL THEN NULL
        ELSE encode(public.digest(normalized_candidate_id, 'sha256'), 'hex') END,
      'candidateExternalUrlHash', CASE WHEN normalized_candidate_url IS NULL THEN NULL
        ELSE encode(public.digest(normalized_candidate_url, 'sha256'), 'hex') END,
      'confirmed', false,
      'simulation', p_evidence_kind = 'simulation',
      'readback', jsonb_build_object(
        'required', true,
        'status', 'pending',
        'reason', 'assisted_publication_unconfirmed'
      )
    )
  );

  INSERT INTO geo.publication_readbacks (
    tenant_id, id, job_id, receipt_id, execution_level, status, required,
    reason, scheduled_for, completed_at, last_error
  ) VALUES (
    tenant_value, readback_value, handoff.job_id, receipt_value, 'assisted',
    'pending', true, 'assisted_publication_unconfirmed', clock_timestamp(), NULL, NULL
  );

  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = 'readback_pending',
      publication_receipt_id = receipt_value,
      publication_readback_id = readback_value
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES
  (
    tenant_value, actor_value, 'publication_assisted_handoff.submit_observed',
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    p_evidence_hash,
    jsonb_build_object(
      'outcome', p_outcome,
      'evidenceKind', p_evidence_kind,
      'candidateExternalIdHash', CASE WHEN normalized_candidate_id IS NULL THEN NULL
        ELSE encode(public.digest(normalized_candidate_id, 'sha256'), 'hex') END,
      'candidateExternalUrlHash', CASE WHEN normalized_candidate_url IS NULL THEN NULL
        ELSE encode(public.digest(normalized_candidate_url, 'sha256'), 'hex') END,
      'confirmed', false,
      'receiptId', receipt_value,
      'readbackId', readback_value
    )
  ),
  (
    tenant_value, actor_value, 'publication_readback.required',
    'publication_readback', readback_value,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    p_evidence_hash,
    jsonb_build_object(
      'jobId', handoff.job_id,
      'receiptId', receipt_value,
      'required', true,
      'reason', 'assisted_publication_unconfirmed'
    )
  );

  RETURN QUERY SELECT receipt_value, readback_value;
END
$$;

CREATE OR REPLACE FUNCTION geo.recover_publication_assisted_submit_uncertain(
  p_handoff_id uuid,
  p_evidence_kind text
)
RETURNS TABLE (
  publication_receipt_id uuid,
  publication_readback_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_bound_ctrip_bridge(p_handoff_id);
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  evidence_hash_value geo.sha256_hex;
  receipt_value uuid;
  readback_value uuid;
BEGIN
  IF p_evidence_kind IS NULL OR p_evidence_kind NOT IN ('simulation', 'browser') THEN
    RAISE EXCEPTION 'invalid assisted submit recovery evidence kind'
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

  IF handoff.submit_outcome IS NOT NULL THEN
    IF handoff.publication_receipt_id IS NULL OR handoff.publication_readback_id IS NULL THEN
      RAISE EXCEPTION 'durable submit observation is missing reconciliation evidence'
        USING ERRCODE = '55000';
    END IF;
    RETURN QUERY SELECT handoff.publication_receipt_id, handoff.publication_readback_id;
    RETURN;
  END IF;

  IF handoff.state <> 'awaiting_operator_submit'
     OR handoff.submit_permit_consumed_at IS NULL
     OR handoff.submit_permit_consumed_by_principal_id <> actor_value
     OR handoff.submit_permit_issued_by_actor_id IS NULL
     OR handoff.submit_evidence_hash IS NOT NULL THEN
    RAISE EXCEPTION 'submit recovery requires one consumed bound permit'
      USING ERRCODE = '55000';
  END IF;

  evidence_hash_value := encode(public.digest(
    'geo.ctrip-submit-recovery.v1|' || handoff.id::text || '|' ||
    handoff.preview_hash::text || '|' ||
    extract(epoch from handoff.submit_permit_consumed_at)::text || '|' ||
    handoff.adapter_version || '|' || p_evidence_kind,
    'sha256'
  ), 'hex');

  SELECT observed.publication_receipt_id, observed.publication_readback_id
  INTO receipt_value, readback_value
  FROM geo.record_publication_assisted_submit_observation(
    p_handoff_id,
    'uncertain',
    p_evidence_kind,
    evidence_hash_value,
    NULL,
    NULL,
    statement_timestamp()
  ) AS observed;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value,
    'publication_assisted_handoff.submit_observation_recovered',
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    evidence_hash_value,
    jsonb_build_object(
      'outcome', 'uncertain',
      'evidenceKind', p_evidence_kind,
      'permitConsumedAt', handoff.submit_permit_consumed_at,
      'receiptId', receipt_value,
      'readbackId', readback_value,
      'retryForbidden', true
    )
  );

  RETURN QUERY SELECT receipt_value, readback_value;
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
        'submit_candidate_external_id', 'submit_candidate_external_url',
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
        'submit_candidate_external_id', 'submit_candidate_external_url',
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

REVOKE ALL ON FUNCTION geo.record_publication_assisted_submit_observation(
  uuid, text, text, geo.sha256_hex, text, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.recover_publication_assisted_submit_uncertain(
  uuid, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_submit_observation(
  uuid, text, text, geo.sha256_hex, text, text, timestamptz
) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.recover_publication_assisted_submit_uncertain(
  uuid, text
) TO geo_runtime;
