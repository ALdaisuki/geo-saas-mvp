BEGIN;

CREATE OR REPLACE FUNCTION geo.browser_publication_identity_allowed(
  p_platform text,
  p_external_id text,
  p_external_url text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
SET search_path = pg_catalog, geo
AS $$
  SELECT CASE p_platform
    WHEN 'toutiao' THEN
      p_external_id ~ '^[0-9]{10,30}$'
      AND p_external_url =
        'https://www.toutiao.com/article/' || p_external_id || '/'
    WHEN 'sohu' THEN
      p_external_id ~ '^[1-9][0-9]{0,29}_[1-9][0-9]{0,29}$'
      AND p_external_url = 'https://www.sohu.com/a/' || p_external_id
    WHEN 'baijiahao' THEN
      p_external_id ~ '^[0-9]{10,30}$'
      AND p_external_url = 'https://baijiahao.baidu.com/s?id=' || p_external_id
    WHEN 'netease' THEN
      p_external_id ~ '^[A-Z0-9]{8,32}$'
      AND p_external_url =
        'https://www.163.com/dy/article/' || p_external_id || '.html'
    WHEN 'ctrip_community' THEN
      p_external_id ~ '^[0-9]{1,20}$'
      AND p_external_url =
        'https://m.ctrip.com/webapp/you/community/detail?articleId=' || p_external_id
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION geo.publication_public_url_matches_platform(
  p_platform text,
  p_url text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, geo
AS $$
  SELECT CASE p_platform
    WHEN 'ctrip_community' THEN
      p_url ~ '^https://m\.ctrip\.com/webapp/you/community/detail\?articleId=[0-9]{1,20}$'
    WHEN 'toutiao' THEN
      p_url ~ '^https://www\.toutiao\.com/article/[0-9]{10,30}/$'
    WHEN 'sohu' THEN
      p_url ~ '^https://www\.sohu\.com/a/[1-9][0-9]{0,29}_[1-9][0-9]{0,29}$'
    WHEN 'baijiahao' THEN
      p_url ~ '^https://baijiahao\.baidu\.com/s\?id=[0-9]{10,30}$'
    WHEN 'netease' THEN
      p_url ~ '^https://www\.163\.com/dy/article/[A-Z0-9]{8,32}\.html$'
    ELSE false
  END
$$;

ALTER TABLE geo.publication_assisted_handoffs
  DROP CONSTRAINT IF EXISTS publication_assisted_handoff_submit_candidate_external_url_check;

ALTER TABLE geo.publication_assisted_handoffs
  ADD CONSTRAINT publication_assisted_handoff_submit_candidate_external_url_check
    CHECK (
      submit_candidate_external_url IS NULL OR (
        length(submit_candidate_external_url) BETWEEN 1 AND 2000
        AND geo.publication_public_url_matches_platform(
          platform,
          submit_candidate_external_url
        )
      )
    ) NOT VALID;

ALTER TABLE geo.publication_assisted_handoffs
  VALIDATE CONSTRAINT publication_assisted_handoff_submit_candidate_external_url_check;

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
  IF p_outcome IS NULL OR p_outcome NOT IN ('accepted', 'uncertain', 'rejected')
     OR p_evidence_kind IS NULL OR p_evidence_kind NOT IN ('simulation', 'browser')
     OR p_observed_at IS NULL OR p_observed_at > statement_timestamp() + interval '1 minute'
     OR p_observed_at < statement_timestamp() - interval '30 minutes'
     OR (normalized_candidate_id IS NULL) <> (normalized_candidate_url IS NULL)
     OR (normalized_candidate_id IS NOT NULL AND (
       length(normalized_candidate_id) > 500 OR length(normalized_candidate_url) > 2000
     ))
     OR (p_evidence_kind = 'simulation' AND normalized_candidate_id IS NOT NULL)
     OR (p_outcome = 'rejected' AND normalized_candidate_id IS NOT NULL) THEN
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
  IF p_outcome IS NULL OR p_outcome NOT IN (
       'confirmed', 'not_found', 'mismatch', 'unavailable', 'simulation_only'
     )
     OR p_evidence_kind IS NULL
     OR p_evidence_kind NOT IN ('simulation', 'browser', 'platform_readback')
     OR p_observed_at IS NULL
     OR p_observed_at > statement_timestamp() + interval '1 minute'
     OR p_observed_at < statement_timestamp() - interval '24 hours' THEN
    RAISE EXCEPTION 'invalid assisted readback observation' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id
  FOR UPDATE;

  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO job
  FROM geo.publication_jobs AS publication_job
  WHERE publication_job.tenant_id = tenant_value
    AND publication_job.id = handoff.job_id;

  IF job.id IS NULL OR job.platform <> handoff.platform
     OR job.channel_account_id <> handoff.channel_account_id
     OR job.variant_id <> handoff.variant_id
     OR job.payload_hash <> handoff.payload_hash
     OR NOT EXISTS (
       SELECT 1
       FROM geo.publication_receipts AS receipt
       WHERE receipt.tenant_id = tenant_value
         AND receipt.id = handoff.publication_receipt_id
         AND receipt.job_id = handoff.job_id
         AND receipt.attempt_id = handoff.attempt_id
         AND receipt.platform = handoff.platform
     ) THEN
    RAISE EXCEPTION 'readback handoff lineage does not match its publication job'
      USING ERRCODE = '55000';
  END IF;
  IF handoff.state <> 'readback_pending'
     OR handoff.publication_receipt_id IS NULL
     OR handoff.publication_readback_id IS NULL
     OR handoff.readback_deadline_at IS NULL THEN
    RAISE EXCEPTION 'readback requires a pending browser publication observation'
      USING ERRCODE = '55000';
  END IF;
  IF job.execution_level = 'unattended' AND (
       handoff.readback_owner_principal_id <> actor_value OR
       handoff.readback_lease_expires_at < statement_timestamp()
     ) THEN
    RAISE EXCEPTION 'unattended readback requires the current bridge lease'
      USING ERRCODE = '55006';
  END IF;
  IF p_observed_at < handoff.submit_observed_at - interval '1 minute' THEN
    RAISE EXCEPTION 'readback predates the submit observation' USING ERRCODE = '22023';
  END IF;

  next_attempt_count := handoff.readback_attempt_count + 1;
  IF p_outcome = 'confirmed' THEN
    IF p_evidence_kind <> 'platform_readback'
       OR normalized_external_id IS NULL OR length(normalized_external_id) > 500
       OR normalized_external_url IS NULL OR length(normalized_external_url) > 2000
       OR NOT geo.browser_publication_identity_allowed(
         handoff.platform,
         normalized_external_id,
         normalized_external_url
       ) THEN
      RAISE EXCEPTION 'confirmed readback requires a platform-bound public identity'
        USING ERRCODE = '23514';
    END IF;
    IF handoff.public_content_hash IS NULL
       OR p_observed_payload_hash IS DISTINCT FROM handoff.public_content_hash THEN
      next_state := 'needs_review';
      readback_status := 'failed';
      readback_error := 'ASSISTED_READBACK_CONTENT_BINDING_MISMATCH';
      recorded_outcome := 'mismatch';
    ELSE
      next_state := 'confirmed';
      readback_status := 'succeeded';
      readback_error := NULL;
    END IF;
  ELSIF p_outcome = 'unavailable' THEN
    IF normalized_external_id IS NOT NULL OR normalized_external_url IS NOT NULL THEN
      RAISE EXCEPTION 'unavailable readback cannot claim external identity'
        USING ERRCODE = '23514';
    END IF;
    exhausted := next_attempt_count >= 60
      OR p_observed_at >= handoff.readback_deadline_at;
    IF exhausted THEN
      next_state := 'needs_review';
      readback_status := 'failed';
      readback_error := CASE
        WHEN p_observed_at >= handoff.readback_deadline_at
          THEN 'ASSISTED_READBACK_DEADLINE_EXCEEDED'
        ELSE 'ASSISTED_READBACK_ATTEMPTS_EXHAUSTED'
      END;
    ELSE
      next_state := 'readback_pending';
      readback_status := 'pending';
      readback_error := 'ASSISTED_READBACK_UNAVAILABLE';
    END IF;
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
      readback_outcome = recorded_outcome,
      readback_evidence_kind = p_evidence_kind,
      readback_evidence_hash = p_evidence_hash,
      readback_observed_at = p_observed_at,
      readback_attempt_count = next_attempt_count,
      observed_payload_hash = p_observed_payload_hash,
      external_id = CASE WHEN next_state = 'confirmed' THEN normalized_external_id ELSE NULL END,
      external_url = CASE WHEN next_state = 'confirmed' THEN normalized_external_url ELSE NULL END,
      readback_owner_principal_id = NULL,
      readback_lease_expires_at = NULL,
      last_error_code = readback_error,
      last_error_message = CASE
        WHEN next_state = 'confirmed' THEN NULL
        WHEN readback_error = 'ASSISTED_READBACK_CONTENT_BINDING_MISMATCH'
          THEN 'Public content did not match the prepared content binding'
        WHEN readback_error IN (
          'ASSISTED_READBACK_DEADLINE_EXCEEDED',
          'ASSISTED_READBACK_ATTEMPTS_EXHAUSTED'
        ) THEN 'Public readback budget was exhausted; operator review is required'
        WHEN p_outcome = 'simulation_only'
          THEN 'Simulator evidence cannot confirm a live publication'
        WHEN p_outcome = 'unavailable' THEN 'Public readback is temporarily unavailable'
        WHEN p_outcome = 'mismatch' THEN 'Public readback did not match the audited payload'
        ELSE 'Public publication was not found within the readback window'
      END
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id;

  UPDATE geo.publication_readbacks AS readback
  SET status = readback_status,
      completed_at = CASE
        WHEN readback_status IN ('succeeded', 'failed') THEN clock_timestamp()
        ELSE NULL
      END,
      last_error = readback_error
  WHERE readback.tenant_id = tenant_value
    AND readback.id = handoff.publication_readback_id;

  UPDATE geo.publication_jobs AS publication_job
  SET state = CASE
        WHEN next_state = 'confirmed' THEN 'confirmed'
        WHEN next_state = 'needs_review' THEN 'needs_review'
        ELSE 'uncertain'
      END,
      confirmed_at = CASE WHEN next_state = 'confirmed' THEN clock_timestamp() ELSE NULL END,
      last_error_code = readback_error
  WHERE publication_job.tenant_id = tenant_value
    AND publication_job.id = handoff.job_id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value,
    actor_value,
    CASE next_state
      WHEN 'confirmed' THEN 'publication_assisted_handoff.confirmed'
      WHEN 'needs_review' THEN 'publication_assisted_handoff.needs_review'
      ELSE 'publication_assisted_handoff.readback_pending'
    END,
    'publication_assisted_handoff',
    p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    p_evidence_hash,
    jsonb_build_object(
      'platform', handoff.platform,
      'reportedOutcome', p_outcome,
      'outcome', recorded_outcome,
      'evidenceKind', p_evidence_kind,
      'confirmed', next_state = 'confirmed',
      'attemptCount', next_attempt_count,
      'attemptLimit', 60,
      'deadlineAt', handoff.readback_deadline_at,
      'exhausted', exhausted,
      'externalIdHash', CASE WHEN normalized_external_id IS NULL THEN NULL
        ELSE encode(public.digest(normalized_external_id, 'sha256'), 'hex') END,
      'externalUrlHash', CASE WHEN normalized_external_url IS NULL THEN NULL
        ELSE encode(public.digest(normalized_external_url, 'sha256'), 'hex') END,
      'executionLevel', job.execution_level
    )
  );

  RETURN QUERY SELECT
    next_state,
    CASE WHEN next_state = 'confirmed' THEN normalized_external_id ELSE NULL END,
    CASE WHEN next_state = 'confirmed' THEN normalized_external_url ELSE NULL END;
END
$$;

REVOKE ALL ON FUNCTION geo.publication_public_url_matches_platform(text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.browser_publication_identity_allowed(text, text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.record_publication_assisted_submit_observation(
  uuid, text, text, geo.sha256_hex, text, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.record_publication_assisted_readback(
  uuid, text, text, geo.sha256_hex, geo.sha256_hex, text, text, timestamptz
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION geo.publication_public_url_matches_platform(text, text)
  TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_submit_observation(
  uuid, text, text, geo.sha256_hex, text, text, timestamptz
) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_readback(
  uuid, text, text, geo.sha256_hex, geo.sha256_hex, text, text, timestamptz
) TO geo_runtime;

COMMIT;
