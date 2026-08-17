BEGIN;

-- A creator-center match in the draft list is definitive evidence that the
-- editor retained the draft and the platform did not accept the publish
-- attempt. It is neither a public-readback delay nor a safe automatic retry.
ALTER TABLE geo.publication_assisted_handoffs
  DROP CONSTRAINT IF EXISTS publication_assisted_handoffs_submit_outcome_check;

ALTER TABLE geo.publication_assisted_handoffs
  ADD CONSTRAINT publication_assisted_handoffs_submit_outcome_check
    CHECK (submit_outcome IN ('accepted', 'uncertain', 'rejected', 'not_accepted'));

ALTER TABLE geo.publication_assisted_handoffs
  DROP CONSTRAINT IF EXISTS publication_assisted_handoff_delivery_evidence_complete;

ALTER TABLE geo.publication_assisted_handoffs
  ADD CONSTRAINT publication_assisted_handoff_delivery_evidence_complete
    CHECK (
      state NOT IN ('readback_pending', 'confirmed', 'needs_review') OR
      (publication_receipt_id IS NOT NULL AND publication_readback_id IS NOT NULL) OR
      (
        state = 'needs_review'
        AND submit_outcome = 'not_accepted'
        AND publication_receipt_id IS NULL
        AND publication_readback_id IS NULL
      )
    );

ALTER TABLE geo.publication_assisted_handoffs
  ADD CONSTRAINT publication_assisted_handoff_not_accepted_without_readback
    CHECK (
      submit_outcome IS DISTINCT FROM 'not_accepted' OR (
        submit_evidence_kind = 'browser'
        AND submit_evidence_hash IS NOT NULL
        AND submit_observed_at IS NOT NULL
        AND submit_candidate_external_id IS NULL
        AND submit_candidate_external_url IS NULL
        AND publication_receipt_id IS NULL
        AND publication_readback_id IS NULL
        AND readback_outcome IS NULL
        AND readback_evidence_kind IS NULL
        AND readback_evidence_hash IS NULL
        AND readback_observed_at IS NULL
        AND observed_payload_hash IS NULL
        AND external_id IS NULL
        AND external_url IS NULL
      )
    );

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
    (OLD.state = 'awaiting_operator_submit' AND NEW.state IN ('submitted_unconfirmed', 'needs_review', 'cancelled', 'expired', 'failed')) OR
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

CREATE OR REPLACE FUNCTION geo.record_publication_assisted_submit_observation(
  p_handoff_id uuid,
  p_outcome text,
  p_evidence_kind text,
  p_evidence_hash geo.sha256_hex,
  p_candidate_external_id text,
  p_candidate_external_url text,
  p_observed_at timestamptz
)
RETURNS TABLE (publication_receipt_id uuid, publication_readback_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_bound_ctrip_bridge(p_handoff_id);
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  attempt geo.publication_attempts%ROWTYPE;
  job geo.publication_jobs%ROWTYPE;
  receipt_value uuid;
  readback_value uuid;
  attempt_error_code text;
  attempt_error_message text;
  normalized_candidate_id text := NULLIF(trim(p_candidate_external_id), '');
  normalized_candidate_url text := NULLIF(trim(p_candidate_external_url), '');
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('accepted', 'uncertain', 'rejected', 'not_accepted')
     OR p_evidence_kind IS NULL OR p_evidence_kind NOT IN ('simulation', 'browser')
     OR p_observed_at IS NULL OR p_observed_at > statement_timestamp() + interval '1 minute'
     OR p_observed_at < statement_timestamp() - interval '30 minutes'
     OR (normalized_candidate_id IS NULL) <> (normalized_candidate_url IS NULL)
     OR (normalized_candidate_id IS NOT NULL AND (
       length(normalized_candidate_id) > 500 OR length(normalized_candidate_url) > 2000
     ))
     OR (p_evidence_kind = 'simulation' AND normalized_candidate_id IS NOT NULL)
     OR (p_outcome IN ('rejected', 'not_accepted') AND normalized_candidate_id IS NOT NULL)
     OR (p_outcome = 'not_accepted' AND p_evidence_kind <> 'browser') THEN
    RAISE EXCEPTION 'invalid assisted submit observation' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id
  FOR UPDATE;

  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002';
  END IF;
  IF normalized_candidate_id IS NOT NULL
     AND (
       NOT geo.browser_publication_identity_allowed(
         handoff.platform,
         normalized_candidate_id,
         normalized_candidate_url
       )
       OR NOT geo.publication_public_url_matches_platform(
         handoff.platform,
         normalized_candidate_url
       )
     ) THEN
    RAISE EXCEPTION 'candidate public URL does not match the handoff platform'
      USING ERRCODE = '22023';
  END IF;
  IF handoff.submit_outcome IS NOT NULL THEN
    IF handoff.submit_outcome <> p_outcome
       OR handoff.submit_evidence_kind <> p_evidence_kind
       OR handoff.submit_evidence_hash <> p_evidence_hash
       OR handoff.submit_candidate_external_id IS DISTINCT FROM normalized_candidate_id
       OR handoff.submit_candidate_external_url IS DISTINCT FROM normalized_candidate_url
       OR handoff.submit_observed_at <> p_observed_at
       OR (
         p_outcome = 'not_accepted'
         AND (
           handoff.state <> 'needs_review'
           OR handoff.publication_receipt_id IS NOT NULL
           OR handoff.publication_readback_id IS NOT NULL
         )
       )
       OR (
         p_outcome <> 'not_accepted'
         AND (
           handoff.publication_receipt_id IS NULL
           OR handoff.publication_readback_id IS NULL
         )
       ) THEN
      RAISE EXCEPTION 'assisted submit observation conflicts with durable evidence'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT handoff.publication_receipt_id, handoff.publication_readback_id;
    RETURN;
  END IF;
  IF handoff.state <> 'awaiting_operator_submit'
     OR handoff.submit_permit_consumed_at IS NULL
     OR handoff.submit_permit_consumed_by_principal_id <> actor_value
     OR handoff.submit_evidence_hash IS NOT NULL THEN
    RAISE EXCEPTION 'submit observation requires one consumed bound permit'
      USING ERRCODE = '55000';
  END IF;
  IF p_observed_at < handoff.submit_permit_consumed_at - interval '1 minute' THEN
    RAISE EXCEPTION 'submit observation predates permit consumption'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO attempt
  FROM geo.publication_attempts AS publication_attempt
  WHERE publication_attempt.tenant_id = tenant_value
    AND publication_attempt.id = handoff.attempt_id
    AND publication_attempt.job_id = handoff.job_id
  FOR UPDATE;

  SELECT * INTO job
  FROM geo.publication_jobs AS publication_job
  WHERE publication_job.tenant_id = tenant_value
    AND publication_job.id = handoff.job_id;

  IF attempt.id IS NULL OR attempt.state <> 'started'
     OR job.id IS NULL OR job.platform <> handoff.platform
     OR job.channel_account_id <> handoff.channel_account_id
     OR job.variant_id <> handoff.variant_id
     OR job.payload_hash <> handoff.payload_hash THEN
    RAISE EXCEPTION 'submit observation requires the active bound publication attempt'
      USING ERRCODE = '55000';
  END IF;

  IF p_outcome = 'not_accepted' THEN
    UPDATE geo.publication_assisted_handoffs AS assisted_handoff
    SET state = 'needs_review',
        submit_evidence_hash = p_evidence_hash,
        submit_outcome = p_outcome,
        submit_evidence_kind = p_evidence_kind,
        submit_observed_at = p_observed_at,
        submit_candidate_external_id = NULL,
        submit_candidate_external_url = NULL,
        readback_owner_principal_id = NULL,
        readback_lease_expires_at = NULL,
        last_error_code = 'ASSISTED_SUBMIT_NOT_ACCEPTED_DRAFT_RETAINED',
        last_error_message = 'Platform did not accept the publish attempt; creator management still shows a retained draft'
    WHERE assisted_handoff.tenant_id = tenant_value
      AND assisted_handoff.id = p_handoff_id;

    INSERT INTO geo.audit_log (
      tenant_id, actor_id, action, resource_type, resource_id,
      request_id, after_hash, details
    ) VALUES (
      tenant_value,
      actor_value,
      'publication_assisted_handoff.submit_not_accepted_draft_retained',
      'publication_assisted_handoff',
      p_handoff_id,
      COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
      p_evidence_hash,
      jsonb_build_object(
        'platform', handoff.platform,
        'outcome', p_outcome,
        'evidenceKind', p_evidence_kind,
        'submitBoundaryCrossed', true,
        'creatorManagementState', 'draft_retained',
        'publicReadbackCreated', false,
        'automaticRetryAllowed', false
      )
    );

    RETURN QUERY SELECT NULL::uuid, NULL::uuid;
    RETURN;
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
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id;

  UPDATE geo.publication_attempts AS publication_attempt
  SET state = 'uncertain', response_hash = p_evidence_hash,
      error_code = attempt_error_code, error_message = attempt_error_message,
      finished_at = clock_timestamp()
  WHERE publication_attempt.tenant_id = tenant_value
    AND publication_attempt.id = handoff.attempt_id;

  UPDATE geo.publication_jobs AS publication_job
  SET state = 'uncertain', lease_owner = NULL, lease_expires_at = NULL,
      last_error_code = attempt_error_code
  WHERE publication_job.tenant_id = tenant_value
    AND publication_job.id = handoff.job_id;

  INSERT INTO geo.publication_receipts (
    tenant_id, id, job_id, attempt_id, platform, execution_level, evidence_type,
    request_hash, response_hash, external_id, external_url, published_at,
    recorded_at, confirmed, payload
  ) VALUES (
    tenant_value, receipt_value, handoff.job_id, handoff.attempt_id,
    handoff.platform, job.execution_level,
    CASE p_evidence_kind WHEN 'simulation' THEN 'fixture' ELSE 'browser_screenshot' END,
    attempt.request_hash, p_evidence_hash, NULL, NULL, NULL, clock_timestamp(), false,
    jsonb_build_object(
      'schemaVersion', 'geo.browser-assisted-receipt.v1',
      'platform', handoff.platform,
      'outcome', p_outcome,
      'evidenceKind', p_evidence_kind,
      'previewHash', handoff.preview_hash,
      'confirmed', false,
      'simulation', p_evidence_kind = 'simulation',
      'executionLevel', job.execution_level,
      'candidateExternalIdHash', CASE WHEN normalized_candidate_id IS NULL THEN NULL
        ELSE encode(public.digest(normalized_candidate_id, 'sha256'), 'hex') END,
      'candidateExternalUrlHash', CASE WHEN normalized_candidate_url IS NULL THEN NULL
        ELSE encode(public.digest(normalized_candidate_url, 'sha256'), 'hex') END,
      'readback', jsonb_build_object(
        'required', true,
        'status', 'pending',
        'reason', 'browser_publication_unconfirmed'
      )
    )
  );

  INSERT INTO geo.publication_readbacks (
    tenant_id, id, job_id, receipt_id, execution_level, status, required,
    reason, scheduled_for, completed_at, last_error
  ) VALUES (
    tenant_value, readback_value, handoff.job_id, receipt_value,
    job.execution_level, 'pending', true, 'browser_publication_unconfirmed',
    clock_timestamp(), NULL, NULL
  );

  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = 'readback_pending', publication_receipt_id = receipt_value,
      publication_readback_id = readback_value
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id;

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
        'platform', handoff.platform,
        'outcome', p_outcome,
        'evidenceKind', p_evidence_kind,
        'confirmed', false,
        'receiptId', receipt_value,
        'readbackId', readback_value,
        'executionLevel', job.execution_level
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
        'platform', handoff.platform,
        'required', true,
        'reason', 'browser_publication_unconfirmed',
        'executionLevel', job.execution_level
      )
    );

  RETURN QUERY SELECT receipt_value, readback_value;
END
$$;

CREATE OR REPLACE FUNCTION geo.sync_ctrip_handoff_terminal_job()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  terminal_at timestamptz := clock_timestamp();
  terminal_error text;
  attempt_outcome text;
  target_job_state text;
  publisher_rejected boolean :=
    NEW.state = 'needs_review' AND NEW.readback_outcome = 'publisher_rejected';
  retained_draft boolean :=
    NEW.state = 'needs_review' AND NEW.submit_outcome = 'not_accepted';
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state
     OR NEW.state NOT IN ('confirmed', 'needs_review', 'failed', 'expired', 'cancelled') THEN
    RETURN NEW;
  END IF;

  terminal_error := COALESCE(
    NULLIF(trim(NEW.last_error_code), ''),
    CASE
      WHEN retained_draft THEN 'ASSISTED_SUBMIT_NOT_ACCEPTED_DRAFT_RETAINED'
      WHEN publisher_rejected THEN 'ASSISTED_PUBLISHER_REJECTED'
      WHEN NEW.state = 'expired' THEN 'ASSISTED_HANDOFF_EXPIRED'
      WHEN NEW.state = 'cancelled' THEN 'ASSISTED_HANDOFF_CANCELLED'
      WHEN NEW.state = 'needs_review' THEN 'ASSISTED_HANDOFF_NEEDS_REVIEW'
      WHEN NEW.state = 'failed' THEN 'ASSISTED_HANDOFF_FAILED'
      ELSE NULL
    END
  );
  attempt_outcome := CASE
    WHEN NEW.state = 'confirmed' THEN 'succeeded'
    WHEN publisher_rejected THEN 'failed'
    WHEN retained_draft THEN 'failed'
    WHEN NEW.state = 'needs_review' THEN 'uncertain'
    ELSE 'failed'
  END;
  target_job_state := CASE
    WHEN NEW.state = 'confirmed' THEN 'confirmed'
    WHEN NEW.state = 'cancelled' THEN 'cancelled'
    WHEN publisher_rejected THEN 'permanent_failure'
    WHEN retained_draft THEN 'permanent_failure'
    ELSE 'needs_review'
  END;

  UPDATE geo.publication_attempts AS attempt
  SET state = attempt_outcome,
      response_hash = COALESCE(
        attempt.response_hash,
        (
          SELECT receipt.response_hash
          FROM geo.publication_receipts AS receipt
          WHERE receipt.tenant_id = NEW.tenant_id
            AND receipt.id = NEW.publication_receipt_id
        ),
        NEW.submit_evidence_hash
      ),
      error_code = CASE WHEN attempt_outcome = 'succeeded' THEN NULL ELSE terminal_error END,
      error_message = CASE
        WHEN attempt_outcome = 'succeeded' THEN NULL
        ELSE left(COALESCE(NULLIF(trim(NEW.last_error_message), ''), terminal_error), 4000)
      END,
      finished_at = terminal_at,
      governance_finished_at = terminal_at
  WHERE attempt.tenant_id = NEW.tenant_id
    AND attempt.id = NEW.attempt_id
    AND attempt.job_id = NEW.job_id
    AND attempt.state = 'started';

  UPDATE geo.publication_jobs AS job
  SET state = target_job_state,
      lease_owner = NULL,
      lease_expires_at = NULL,
      confirmed_at = CASE WHEN target_job_state = 'confirmed'
        THEN COALESCE(NEW.readback_observed_at, terminal_at)
        ELSE NULL
      END,
      cancelled_at = CASE WHEN target_job_state = 'cancelled'
        THEN COALESCE(NEW.cancelled_at, terminal_at)
        ELSE job.cancelled_at
      END,
      cancelled_by_actor_id = CASE WHEN target_job_state = 'cancelled'
        THEN NEW.cancelled_by_actor_id
        ELSE job.cancelled_by_actor_id
      END,
      cancellation_reason = CASE WHEN target_job_state = 'cancelled'
        THEN COALESCE(NEW.cancellation_reason, 'Ctrip handoff cancelled')
        ELSE job.cancellation_reason
      END,
      last_error_code = CASE WHEN target_job_state = 'confirmed' THEN NULL ELSE terminal_error END,
      updated_at = terminal_at
  WHERE job.tenant_id = NEW.tenant_id
    AND job.id = NEW.job_id
    AND job.state IN (
      'queued', 'dispatching', 'retry_wait', 'uncertain', 'reconciling', 'needs_review'
    );

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, before_hash, after_hash, details
  )
  SELECT
    NEW.tenant_id,
    NEW.bridge_service_principal_id,
    'publication_assisted_handoff.job_terminal_synced',
    'publication_job',
    NEW.job_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), NEW.id::text),
    job.request_hash,
    COALESCE(NEW.readback_evidence_hash, NEW.prepare_evidence_hash, NEW.submit_evidence_hash),
    jsonb_build_object(
      'handoffId', NEW.id,
      'attemptId', NEW.attempt_id,
      'handoffState', NEW.state,
      'jobState', target_job_state,
      'attemptOutcome', attempt_outcome,
      'errorCode', terminal_error,
      'publisherRejected', publisher_rejected,
      'retainedDraft', retained_draft
    )
  FROM geo.publication_jobs AS job
  WHERE job.tenant_id = NEW.tenant_id AND job.id = NEW.job_id;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION geo.record_publication_assisted_submit_observation(
  uuid, text, text, geo.sha256_hex, text, text, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_submit_observation(
  uuid, text, text, geo.sha256_hex, text, text, timestamptz
) TO geo_runtime;

COMMENT ON FUNCTION geo.record_publication_assisted_submit_observation(
  uuid, text, text, geo.sha256_hex, text, text, timestamptz
) IS
  'Records one consumed submit permit observation; a creator-confirmed retained draft is terminal needs_review without receipts or public readback';

COMMIT;
