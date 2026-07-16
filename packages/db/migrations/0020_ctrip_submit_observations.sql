ALTER TABLE geo.publication_assisted_handoffs
  ADD COLUMN submit_outcome text
    CHECK (submit_outcome IN ('accepted', 'uncertain', 'rejected')),
  ADD COLUMN submit_evidence_kind text
    CHECK (submit_evidence_kind IN ('simulation', 'browser')),
  ADD COLUMN submit_observed_at timestamptz,
  ADD COLUMN publication_receipt_id uuid,
  ADD COLUMN publication_readback_id uuid,
  ADD COLUMN readback_outcome text
    CHECK (readback_outcome IN (
      'confirmed', 'not_found', 'mismatch', 'unavailable', 'simulation_only'
    )),
  ADD COLUMN readback_evidence_kind text
    CHECK (readback_evidence_kind IN ('simulation', 'browser', 'platform_readback')),
  ADD COLUMN readback_evidence_hash geo.sha256_hex,
  ADD COLUMN readback_observed_at timestamptz,
  ADD COLUMN observed_payload_hash geo.sha256_hex,
  ADD CONSTRAINT publication_assisted_handoff_receipt_fk
    FOREIGN KEY (tenant_id, publication_receipt_id)
    REFERENCES geo.publication_receipts (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT publication_assisted_handoff_readback_fk
    FOREIGN KEY (tenant_id, publication_readback_id)
    REFERENCES geo.publication_readbacks (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT publication_assisted_handoff_submit_observation_complete
    CHECK (
      (submit_outcome IS NULL AND submit_evidence_kind IS NULL AND submit_observed_at IS NULL) OR
      (submit_outcome IS NOT NULL AND submit_evidence_kind IS NOT NULL AND submit_observed_at IS NOT NULL)
    ),
  ADD CONSTRAINT publication_assisted_handoff_delivery_evidence_complete
    CHECK (
      state NOT IN ('readback_pending', 'confirmed', 'needs_review') OR
      (publication_receipt_id IS NOT NULL AND publication_readback_id IS NOT NULL)
    ),
  ADD CONSTRAINT publication_assisted_handoff_readback_observation_complete
    CHECK (
      (readback_outcome IS NULL AND readback_evidence_kind IS NULL AND
       readback_evidence_hash IS NULL AND readback_observed_at IS NULL) OR
      (readback_outcome IS NOT NULL AND readback_evidence_kind IS NOT NULL AND
       readback_evidence_hash IS NOT NULL AND readback_observed_at IS NOT NULL)
    ),
  ADD CONSTRAINT publication_assisted_handoff_simulation_not_live
    CHECK (
      readback_evidence_kind IS DISTINCT FROM 'simulation' OR
      (state <> 'confirmed' AND external_id IS NULL AND external_url IS NULL)
    );

CREATE UNIQUE INDEX publication_assisted_handoffs_receipt_unique
  ON geo.publication_assisted_handoffs (tenant_id, publication_receipt_id)
  WHERE publication_receipt_id IS NOT NULL;

CREATE UNIQUE INDEX publication_assisted_handoffs_readback_unique
  ON geo.publication_assisted_handoffs (tenant_id, publication_readback_id)
  WHERE publication_readback_id IS NOT NULL;

CREATE OR REPLACE FUNCTION geo.record_publication_assisted_submit_observation(
  p_handoff_id uuid,
  p_outcome text,
  p_evidence_kind text,
  p_evidence_hash geo.sha256_hex,
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
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('accepted', 'uncertain', 'rejected')
     OR p_evidence_kind IS NULL OR p_evidence_kind NOT IN ('simulation', 'browser')
     OR p_observed_at IS NULL
     OR p_observed_at > statement_timestamp() + interval '1 minute'
     OR p_observed_at < statement_timestamp() - interval '30 minutes' THEN
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
RETURNS TABLE (
  state text,
  external_id text,
  external_url text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_bound_ctrip_bridge(p_handoff_id);
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  next_state text;
  readback_status text;
  readback_error text;
  normalized_external_id text := NULLIF(trim(p_external_id), '');
  normalized_external_url text := NULLIF(trim(p_external_url), '');
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN (
       'confirmed', 'not_found', 'mismatch', 'unavailable', 'simulation_only'
     )
     OR p_evidence_kind IS NULL OR p_evidence_kind NOT IN (
       'simulation', 'browser', 'platform_readback'
     )
     OR p_observed_at IS NULL
     OR p_observed_at > statement_timestamp() + interval '1 minute'
     OR p_observed_at < statement_timestamp() - interval '24 hours' THEN
    RAISE EXCEPTION 'invalid assisted readback observation' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id
  FOR UPDATE;

  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002';
  END IF;
  IF handoff.state <> 'readback_pending'
     OR handoff.publication_receipt_id IS NULL
     OR handoff.publication_readback_id IS NULL THEN
    RAISE EXCEPTION 'readback requires a pending assisted publication observation'
      USING ERRCODE = '55000';
  END IF;
  IF p_observed_at < handoff.submit_observed_at - interval '1 minute' THEN
    RAISE EXCEPTION 'readback predates the submit observation' USING ERRCODE = '22023';
  END IF;

  IF p_outcome = 'confirmed' THEN
    IF p_evidence_kind <> 'platform_readback'
       OR p_observed_payload_hash IS DISTINCT FROM handoff.payload_hash
       OR normalized_external_id IS NULL
       OR length(normalized_external_id) > 500
       OR normalized_external_url IS NULL
       OR length(normalized_external_url) > 2000
       OR normalized_external_url !~* '^https://([a-z0-9-]+\.)*ctrip\.com(?::443)?/' THEN
      RAISE EXCEPTION 'confirmed readback requires matching public Ctrip evidence'
        USING ERRCODE = '23514';
    END IF;
    next_state := 'confirmed';
    readback_status := 'succeeded';
    readback_error := NULL;
  ELSIF p_outcome = 'unavailable' THEN
    IF normalized_external_id IS NOT NULL OR normalized_external_url IS NOT NULL THEN
      RAISE EXCEPTION 'unavailable readback cannot claim external identity'
        USING ERRCODE = '23514';
    END IF;
    next_state := 'readback_pending';
    readback_status := 'pending';
    readback_error := 'ASSISTED_READBACK_UNAVAILABLE';
  ELSE
    IF normalized_external_id IS NOT NULL OR normalized_external_url IS NOT NULL THEN
      RAISE EXCEPTION 'unconfirmed readback cannot persist external identity'
        USING ERRCODE = '23514';
    END IF;
    IF p_outcome = 'simulation_only' AND p_evidence_kind <> 'simulation' THEN
      RAISE EXCEPTION 'simulation-only readback requires simulation evidence'
        USING ERRCODE = '23514';
    END IF;
    IF p_outcome <> 'simulation_only' AND p_evidence_kind = 'simulation' THEN
      RAISE EXCEPTION 'simulation evidence must remain explicitly simulation-only'
        USING ERRCODE = '23514';
    END IF;
    next_state := 'needs_review';
    readback_status := 'failed';
    readback_error := CASE p_outcome
      WHEN 'simulation_only' THEN 'SIMULATION_ONLY'
      WHEN 'mismatch' THEN 'ASSISTED_READBACK_MISMATCH'
      ELSE 'ASSISTED_READBACK_NOT_FOUND'
    END;
  END IF;

  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = next_state,
      readback_outcome = p_outcome,
      readback_evidence_kind = p_evidence_kind,
      readback_evidence_hash = p_evidence_hash,
      readback_observed_at = p_observed_at,
      observed_payload_hash = p_observed_payload_hash,
      external_id = CASE WHEN next_state = 'confirmed' THEN normalized_external_id ELSE NULL END,
      external_url = CASE WHEN next_state = 'confirmed' THEN normalized_external_url ELSE NULL END,
      last_error_code = readback_error,
      last_error_message = CASE
        WHEN next_state = 'confirmed' THEN NULL
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
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
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
      'outcome', p_outcome,
      'evidenceKind', p_evidence_kind,
      'confirmed', next_state = 'confirmed',
      'externalIdHash', CASE WHEN normalized_external_id IS NULL THEN NULL
        ELSE encode(public.digest(normalized_external_id, 'sha256'), 'hex') END,
      'externalUrlHash', CASE WHEN normalized_external_url IS NULL THEN NULL
        ELSE encode(public.digest(normalized_external_url, 'sha256'), 'hex') END
    )
  );

  RETURN QUERY
    SELECT next_state,
           CASE WHEN next_state = 'confirmed' THEN normalized_external_id ELSE NULL END,
           CASE WHEN next_state = 'confirmed' THEN normalized_external_url ELSE NULL END;
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
        'session_evidence_hash', 'draft_evidence_hash', 'submit_evidence_hash',
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
        'session_evidence_hash', 'draft_evidence_hash', 'submit_evidence_hash',
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

REVOKE ALL ON FUNCTION geo.record_publication_assisted_submit_observation(
  uuid, text, text, geo.sha256_hex, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.record_publication_assisted_readback(
  uuid, text, text, geo.sha256_hex, geo.sha256_hex, text, text, timestamptz
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_submit_observation(
  uuid, text, text, geo.sha256_hex, timestamptz
) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_readback(
  uuid, text, text, geo.sha256_hex, geo.sha256_hex, text, text, timestamptz
) TO geo_runtime;
