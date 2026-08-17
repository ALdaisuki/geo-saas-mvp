ALTER TABLE geo.service_principals
  DROP CONSTRAINT service_principals_profile_known;

ALTER TABLE geo.service_principals
  ADD CONSTRAINT service_principals_profile_known
    CHECK (profile IN ('custom', 'automation_producer', 'ctrip_bridge')),
  ADD CONSTRAINT service_principals_ctrip_bridge_scope
    CHECK (
      profile <> 'ctrip_bridge' OR (
        kind = 'integration' AND
        capabilities @> '["tenant:read","content:read","publish:bridge"]'::jsonb AND
        capabilities <@ '["tenant:read","content:read","publish:bridge"]'::jsonb
      )
    );

ALTER TABLE geo.publication_assisted_handoffs
  ADD COLUMN bridge_service_principal_id uuid,
  ADD COLUMN external_draft_id text,
  ADD COLUMN submit_permit_issued_by_actor_id uuid,
  ADD COLUMN submit_permit_consumed_by_principal_id uuid,
  ADD CONSTRAINT publication_assisted_handoff_bridge_principal_fk
    FOREIGN KEY (tenant_id, bridge_service_principal_id)
    REFERENCES geo.service_principals (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT publication_assisted_handoff_permit_issuer_fk
    FOREIGN KEY (tenant_id, submit_permit_issued_by_actor_id)
    REFERENCES geo.tenant_memberships (tenant_id, user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT publication_assisted_handoff_permit_consumer_fk
    FOREIGN KEY (tenant_id, submit_permit_consumed_by_principal_id)
    REFERENCES geo.service_principals (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT publication_assisted_handoff_external_draft_id_length
    CHECK (external_draft_id IS NULL OR length(trim(external_draft_id)) BETWEEN 1 AND 500),
  ADD CONSTRAINT publication_assisted_handoff_permit_actor_consistency
    CHECK (
      (submit_permit_hash IS NULL AND submit_permit_issued_by_actor_id IS NULL) OR
      (submit_permit_hash IS NOT NULL AND submit_permit_issued_by_actor_id IS NOT NULL)
    ) NOT VALID,
  ADD CONSTRAINT publication_assisted_handoff_permit_consumer_consistency
    CHECK (
      (submit_permit_consumed_at IS NULL AND
        submit_permit_consumed_by_principal_id IS NULL) OR
      (submit_permit_consumed_at IS NOT NULL AND
        submit_permit_consumed_by_principal_id IS NOT NULL)
    ) NOT VALID;

CREATE OR REPLACE FUNCTION geo.require_publication_operator()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM geo.tenant_memberships AS membership
    WHERE membership.tenant_id = tenant_value
      AND membership.user_id = actor_value
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'admin', 'publisher')
      AND membership.capabilities @> '["publish:request"]'::jsonb
  ) THEN
    RAISE EXCEPTION 'an active publication operator is required' USING ERRCODE = '42501';
  END IF;
  RETURN actor_value;
END
$$;

CREATE OR REPLACE FUNCTION geo.require_ctrip_bridge_principal(p_principal_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
BEGIN
  IF p_principal_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM geo.service_principals AS principal
    WHERE principal.tenant_id = tenant_value
      AND principal.id = p_principal_id
      AND principal.kind = 'integration'
      AND principal.profile = 'ctrip_bridge'
      AND principal.status = 'active'
      AND principal.capabilities @> '["publish:bridge"]'::jsonb
      AND principal.capabilities <@ '["tenant:read","content:read","publish:bridge"]'::jsonb
  ) THEN
    RAISE EXCEPTION 'an active tenant Ctrip bridge principal is required'
      USING ERRCODE = '42501';
  END IF;
  RETURN p_principal_id;
END
$$;

CREATE OR REPLACE FUNCTION geo.require_bound_ctrip_bridge(p_handoff_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  bridge_principal_id uuid;
BEGIN
  SELECT handoff.bridge_service_principal_id INTO bridge_principal_id
  FROM geo.publication_assisted_handoffs AS handoff
  WHERE handoff.tenant_id = tenant_value AND handoff.id = p_handoff_id;

  IF bridge_principal_id IS NULL OR bridge_principal_id <> actor_value THEN
    RAISE EXCEPTION 'the current actor is not the handoff Ctrip bridge principal'
      USING ERRCODE = '42501';
  END IF;
  PERFORM geo.require_ctrip_bridge_principal(actor_value);
  RETURN actor_value;
END
$$;

CREATE OR REPLACE FUNCTION geo.create_publication_assisted_handoff(
  p_handoff_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_bridge_service_principal_id uuid,
  p_preview_hash geo.sha256_hex,
  p_adapter_version text,
  p_idempotency_key text,
  p_expires_at timestamptz
)
RETURNS TABLE (
  publication_assisted_handoff_id uuid,
  was_created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  job geo.publication_jobs%ROWTYPE;
  attempt geo.publication_attempts%ROWTYPE;
  artifact geo.audit_artifacts%ROWTYPE;
  existing geo.publication_assisted_handoffs%ROWTYPE;
  block_reason text;
BEGIN
  IF p_handoff_id IS NULL OR p_job_id IS NULL OR p_attempt_id IS NULL
     OR p_adapter_version IS NULL OR length(trim(p_adapter_version)) NOT BETWEEN 1 AND 100
     OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 200
     OR p_expires_at <= statement_timestamp()
     OR p_expires_at > statement_timestamp() + interval '2 hours' THEN
    RAISE EXCEPTION 'invalid assisted handoff arguments' USING ERRCODE = '22023';
  END IF;
  PERFORM geo.require_ctrip_bridge_principal(p_bridge_service_principal_id);

  PERFORM pg_advisory_xact_lock(hashtextextended(
    tenant_value::text || ':assisted-handoff:' || p_job_id::text,
    0
  ));

  SELECT * INTO existing
  FROM geo.publication_assisted_handoffs AS handoff
  WHERE handoff.tenant_id = tenant_value AND handoff.job_id = p_job_id;

  IF existing.id IS NOT NULL THEN
    IF existing.id <> p_handoff_id
       OR existing.attempt_id <> p_attempt_id
       OR existing.bridge_service_principal_id <> p_bridge_service_principal_id
       OR existing.preview_hash <> p_preview_hash
       OR existing.adapter_version <> trim(p_adapter_version)
       OR existing.idempotency_key <> p_idempotency_key THEN
      RAISE EXCEPTION 'assisted handoff idempotency conflict' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT existing.id, false;
    RETURN;
  END IF;

  block_reason := geo.publication_assisted_block_reason(p_job_id);
  IF block_reason IS NOT NULL THEN
    RAISE EXCEPTION 'assisted handoff blocked: %', block_reason USING ERRCODE = '42501';
  END IF;

  SELECT * INTO job
  FROM geo.publication_jobs AS publication_job
  WHERE publication_job.tenant_id = tenant_value AND publication_job.id = p_job_id
  FOR UPDATE;

  SELECT * INTO attempt
  FROM geo.publication_attempts AS publication_attempt
  WHERE publication_attempt.tenant_id = tenant_value
    AND publication_attempt.id = p_attempt_id
    AND publication_attempt.job_id = p_job_id
  FOR UPDATE;

  SELECT * INTO artifact
  FROM geo.audit_artifacts AS audit_artifact
  WHERE audit_artifact.tenant_id = tenant_value
    AND audit_artifact.id = job.audit_artifact_id;

  IF job.id IS NULL
     OR job.state <> 'dispatching'
     OR job.lease_owner IS NULL
     OR job.lease_expires_at < statement_timestamp()
     OR attempt.id IS NULL
     OR attempt.state <> 'started'
     OR attempt.request_hash <> job.request_hash
     OR artifact.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff requires an active audited publication attempt'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO geo.publication_assisted_handoffs (
    tenant_id, id, job_id, attempt_id, bridge_service_principal_id,
    channel_account_id, variant_id, platform, state, payload_hash, audit_hash,
    preview_hash, adapter_version, idempotency_key, expires_at, created_by_actor_id
  ) VALUES (
    tenant_value, p_handoff_id, job.id, attempt.id, p_bridge_service_principal_id,
    job.channel_account_id, job.variant_id, 'ctrip_community', 'handoff_pending',
    job.payload_hash, artifact.audit_hash, p_preview_hash, trim(p_adapter_version),
    p_idempotency_key, p_expires_at, actor_value
  );

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.created',
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_idempotency_key),
    p_preview_hash,
    jsonb_build_object(
      'jobId', job.id,
      'attemptId', attempt.id,
      'bridgePrincipalId', p_bridge_service_principal_id,
      'adapterVersion', trim(p_adapter_version),
      'expiresAt', p_expires_at
    )
  );

  RETURN QUERY SELECT p_handoff_id, true;
END
$$;

CREATE OR REPLACE FUNCTION geo.record_publication_assisted_bridge_status(
  p_handoff_id uuid,
  p_status text,
  p_session_evidence_hash geo.sha256_hex,
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
      last_error_code = next_error_code,
      last_error_message = NULL
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
    p_session_evidence_hash,
    jsonb_build_object('status', p_status, 'errorCode', next_error_code)
  );
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION geo.record_publication_assisted_draft(
  p_handoff_id uuid,
  p_session_evidence_hash geo.sha256_hex,
  p_draft_evidence_hash geo.sha256_hex,
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
  IF p_external_draft_id IS NULL OR length(trim(p_external_draft_id)) NOT BETWEEN 1 AND 500
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
      external_draft_id = trim(p_external_draft_id),
      last_error_code = NULL,
      last_error_message = NULL
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.draft_prepared',
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    p_draft_evidence_hash,
    jsonb_build_object(
      'sessionEvidenceHash', p_session_evidence_hash,
      'externalDraftIdHash', encode(public.digest(trim(p_external_draft_id), 'sha256'), 'hex')
    )
  );
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION geo.issue_publication_assisted_submit_permit(p_handoff_id uuid)
RETURNS TABLE (
  submit_permit text,
  submit_permit_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_publication_operator();
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  block_reason text;
  permit_value text;
  permit_hash geo.sha256_hex;
  permit_expiry timestamptz;
BEGIN
  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id
  FOR UPDATE;

  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002';
  END IF;
  IF handoff.bridge_service_principal_id IS NULL OR handoff.external_draft_id IS NULL THEN
    RAISE EXCEPTION 'submit permit requires a bridge-bound prepared draft'
      USING ERRCODE = '55000';
  END IF;
  IF handoff.state <> 'draft_prepared' THEN
    RAISE EXCEPTION 'submit permit requires draft_prepared state' USING ERRCODE = '55000';
  END IF;
  IF handoff.lease_owner_actor_id <> actor_value
     OR handoff.lease_expires_at < statement_timestamp() THEN
    RAISE EXCEPTION 'submit permit requires the current operator lease'
      USING ERRCODE = '55006';
  END IF;
  IF handoff.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'assisted handoff has expired' USING ERRCODE = '55000';
  END IF;
  PERFORM geo.require_ctrip_bridge_principal(handoff.bridge_service_principal_id);

  block_reason := geo.publication_assisted_block_reason(handoff.job_id);
  IF block_reason IS NOT NULL THEN
    RAISE EXCEPTION 'submit permit blocked: %', block_reason USING ERRCODE = '42501';
  END IF;

  permit_value := encode(public.gen_random_bytes(32), 'hex');
  permit_hash := encode(public.digest(permit_value, 'sha256'), 'hex');
  permit_expiry := LEAST(
    handoff.expires_at,
    handoff.lease_expires_at,
    statement_timestamp() + interval '5 minutes'
  );

  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = 'awaiting_operator_submit',
      submit_permit_hash = permit_hash,
      submit_permit_expires_at = permit_expiry,
      submit_permit_consumed_at = NULL,
      submit_permit_issued_by_actor_id = actor_value,
      submit_permit_consumed_by_principal_id = NULL
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.submit_permit_issued',
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    permit_hash,
    jsonb_build_object('expiresAt', permit_expiry, 'bridgePrincipalId', handoff.bridge_service_principal_id)
  );

  RETURN QUERY SELECT permit_value, permit_expiry;
END
$$;

CREATE OR REPLACE FUNCTION geo.consume_publication_assisted_submit_permit(
  p_handoff_id uuid,
  p_submit_permit text
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
  permit_hash geo.sha256_hex;
  block_reason text;
BEGIN
  IF p_submit_permit IS NULL OR p_submit_permit !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid submit permit' USING ERRCODE = '22023';
  END IF;
  permit_hash := encode(public.digest(p_submit_permit, 'sha256'), 'hex');

  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id
  FOR UPDATE;

  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002';
  END IF;
  IF handoff.lease_owner_actor_id IS NULL
     OR handoff.lease_expires_at < statement_timestamp()
     OR handoff.submit_permit_issued_by_actor_id <> handoff.lease_owner_actor_id THEN
    RAISE EXCEPTION 'submit permit requires its current issuing operator lease'
      USING ERRCODE = '55006';
  END IF;
  IF handoff.state <> 'awaiting_operator_submit'
     OR handoff.submit_permit_hash <> permit_hash
     OR handoff.submit_permit_expires_at <= statement_timestamp()
     OR handoff.submit_permit_consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'submit permit is invalid, expired, or already consumed'
      USING ERRCODE = '42501';
  END IF;

  block_reason := geo.publication_assisted_block_reason(handoff.job_id);
  IF block_reason IS NOT NULL THEN
    RAISE EXCEPTION 'submit permit blocked: %', block_reason USING ERRCODE = '42501';
  END IF;

  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET submit_permit_consumed_at = statement_timestamp(),
      submit_permit_consumed_by_principal_id = actor_value
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id
    AND assisted_handoff.submit_permit_consumed_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'submit permit was concurrently consumed' USING ERRCODE = '40001';
  END IF;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.submit_permit_consumed',
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    permit_hash,
    jsonb_build_object('confirmed', false, 'externalWriteObserved', false)
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
        'session_evidence_hash', 'draft_evidence_hash', 'submit_evidence_hash',
        'submit_permit_hash', 'submit_permit_expires_at', 'submit_permit_consumed_at',
        'submit_permit_issued_by_actor_id', 'submit_permit_consumed_by_principal_id',
        'external_draft_id', 'external_id', 'external_url', 'cancelled_at',
        'cancelled_by_actor_id', 'cancellation_reason', 'last_error_code',
        'last_error_message', 'updated_at'
      ]) IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY[
        'state', 'lease_owner_actor_id', 'lease_expires_at', 'heartbeat_at',
        'session_evidence_hash', 'draft_evidence_hash', 'submit_evidence_hash',
        'submit_permit_hash', 'submit_permit_expires_at', 'submit_permit_consumed_at',
        'submit_permit_issued_by_actor_id', 'submit_permit_consumed_by_principal_id',
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

REVOKE ALL ON FUNCTION geo.require_publication_operator() FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.require_ctrip_bridge_principal(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.require_bound_ctrip_bridge(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.create_publication_assisted_handoff(
  uuid, uuid, uuid, uuid, geo.sha256_hex, text, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.record_publication_assisted_bridge_status(
  uuid, text, geo.sha256_hex, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.record_publication_assisted_draft(
  uuid, geo.sha256_hex, geo.sha256_hex, text, text
) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION geo.create_publication_assisted_handoff(
  uuid, uuid, uuid, geo.sha256_hex, text, text, timestamptz
) FROM geo_runtime;
REVOKE EXECUTE ON FUNCTION geo.record_publication_assisted_draft(
  uuid, geo.sha256_hex, geo.sha256_hex
) FROM geo_runtime;

GRANT EXECUTE ON FUNCTION geo.create_publication_assisted_handoff(
  uuid, uuid, uuid, uuid, geo.sha256_hex, text, text, timestamptz
) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_bridge_status(
  uuid, text, geo.sha256_hex, text, text
) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_draft(
  uuid, geo.sha256_hex, geo.sha256_hex, text, text
) TO geo_runtime;
