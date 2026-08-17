CREATE TABLE geo.publication_assisted_handoffs (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'ctrip_community'
    CHECK (platform = 'ctrip_community'),
  state text NOT NULL DEFAULT 'handoff_pending'
    CHECK (state IN (
      'handoff_pending', 'session_required', 'challenge_required',
      'draft_prepared', 'awaiting_operator_submit', 'submitted_unconfirmed',
      'readback_pending', 'confirmed', 'needs_review', 'cancelled', 'expired', 'failed'
    )),
  payload_hash geo.sha256_hex NOT NULL,
  audit_hash geo.sha256_hex NOT NULL,
  preview_hash geo.sha256_hex NOT NULL,
  adapter_version text NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 100),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  lease_owner_actor_id uuid,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  session_evidence_hash geo.sha256_hex,
  draft_evidence_hash geo.sha256_hex,
  submit_evidence_hash geo.sha256_hex,
  submit_permit_hash geo.sha256_hex,
  submit_permit_expires_at timestamptz,
  submit_permit_consumed_at timestamptz,
  external_id text,
  external_url text,
  expires_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  cancelled_by_actor_id uuid,
  cancellation_reason text,
  last_error_code text,
  last_error_message text,
  created_by_actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, job_id),
  UNIQUE (tenant_id, attempt_id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, job_id)
    REFERENCES geo.publication_jobs (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id, job_id)
    REFERENCES geo.publication_attempts (tenant_id, id, job_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, channel_account_id, platform)
    REFERENCES geo.channel_accounts (tenant_id, id, platform) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, variant_id)
    REFERENCES geo.publication_variants (tenant_id, id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK (
    (lease_owner_actor_id IS NULL AND lease_expires_at IS NULL AND heartbeat_at IS NULL) OR
    (lease_owner_actor_id IS NOT NULL AND lease_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL)
  ),
  CHECK (
    (submit_permit_hash IS NULL AND submit_permit_expires_at IS NULL AND
      submit_permit_consumed_at IS NULL) OR
    (submit_permit_hash IS NOT NULL AND submit_permit_expires_at IS NOT NULL)
  ),
  CHECK (submit_permit_expires_at IS NULL OR submit_permit_expires_at <= expires_at),
  CHECK (
    state <> 'cancelled' OR (
      cancelled_at IS NOT NULL AND cancelled_by_actor_id IS NOT NULL AND
      cancellation_reason IS NOT NULL AND length(trim(cancellation_reason)) > 0
    )
  ),
  CHECK (
    state NOT IN ('draft_prepared', 'awaiting_operator_submit') OR
    (session_evidence_hash IS NOT NULL AND draft_evidence_hash IS NOT NULL)
  ),
  CHECK (
    state NOT IN ('submitted_unconfirmed', 'readback_pending', 'confirmed', 'needs_review') OR
    (submit_permit_consumed_at IS NOT NULL AND submit_evidence_hash IS NOT NULL)
  ),
  CHECK (
    state <> 'confirmed' OR
    (external_id IS NOT NULL AND external_url IS NOT NULL)
  )
);

CREATE INDEX publication_assisted_handoffs_operator_queue
  ON geo.publication_assisted_handoffs (tenant_id, state, created_at, id)
  WHERE state IN (
    'handoff_pending', 'session_required', 'challenge_required',
    'draft_prepared', 'awaiting_operator_submit'
  );

CREATE OR REPLACE FUNCTION geo.publication_assisted_block_reason(p_job_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  job geo.publication_jobs%ROWTYPE;
  publication_grant geo.publication_grants%ROWTYPE;
  artifact geo.audit_artifacts%ROWTYPE;
  variant geo.publication_variants%ROWTYPE;
  account geo.channel_accounts%ROWTYPE;
  content_item geo.content_items%ROWTYPE;
  control geo.automation_controls%ROWTYPE;
  breaker geo.circuit_breakers%ROWTYPE;
BEGIN
  PERFORM geo.require_actor_id();

  SELECT * INTO job
  FROM geo.publication_jobs AS publication_job
  WHERE publication_job.tenant_id = tenant_value AND publication_job.id = p_job_id;

  IF job.id IS NULL THEN
    RETURN 'job_not_found';
  END IF;
  IF job.execution_level <> 'assisted' THEN
    RETURN 'job_execution_level_not_assisted';
  END IF;
  IF job.platform <> 'ctrip_community' THEN
    RETURN 'job_platform_not_ctrip_community';
  END IF;
  IF job.state NOT IN ('dispatching', 'uncertain', 'reconciling') THEN
    RETURN 'job_state:' || job.state;
  END IF;

  SELECT * INTO publication_grant
  FROM geo.publication_grants AS grant_row
  WHERE grant_row.tenant_id = tenant_value AND grant_row.id = job.grant_id;

  IF publication_grant.id IS NULL
     OR publication_grant.status <> 'consumed'
     OR publication_grant.expires_at <= statement_timestamp() THEN
    RETURN 'authorization_grant_not_current';
  END IF;

  SELECT * INTO artifact
  FROM geo.audit_artifacts AS audit_artifact
  WHERE audit_artifact.tenant_id = tenant_value
    AND audit_artifact.id = job.audit_artifact_id;

  IF artifact.id IS NULL
     OR artifact.status <> 'passed'
     OR artifact.expires_at <= statement_timestamp()
     OR artifact.variant_id <> job.variant_id
     OR artifact.channel_account_id <> job.channel_account_id
     OR artifact.platform <> job.platform
     OR artifact.payload_hash <> job.payload_hash
     OR artifact.audit_hash <> publication_grant.audit_hash THEN
    RETURN 'authorization_audit_not_current';
  END IF;

  SELECT * INTO variant
  FROM geo.publication_variants AS publication_variant
  WHERE publication_variant.tenant_id = tenant_value
    AND publication_variant.id = job.variant_id;

  IF variant.id IS NULL
     OR variant.state <> 'frozen'
     OR variant.channel_account_id <> job.channel_account_id
     OR variant.platform <> job.platform
     OR variant.payload_hash <> job.payload_hash THEN
    RETURN 'authorization_variant_not_current';
  END IF;

  SELECT * INTO account
  FROM geo.channel_accounts AS channel_account
  WHERE channel_account.tenant_id = tenant_value
    AND channel_account.id = job.channel_account_id;

  IF account.id IS NULL
     OR account.status <> 'active'
     OR account.platform <> 'ctrip_community'
     OR account.capability <> 'browser_assisted'
     OR NOT ('assisted' = ANY(account.supported_execution_levels))
     OR account.last_verified_at IS NULL
     OR account.last_verified_at < statement_timestamp() - interval '24 hours' THEN
    RETURN 'account_browser_assisted_capability_not_current';
  END IF;

  SELECT item.* INTO content_item
  FROM geo.publication_variants AS publication_variant
  JOIN geo.content_versions AS version
    ON version.tenant_id = publication_variant.tenant_id
   AND version.id = publication_variant.content_version_id
  JOIN geo.content_items AS item
    ON item.tenant_id = version.tenant_id
   AND item.id = version.content_item_id
  WHERE publication_variant.tenant_id = tenant_value
    AND publication_variant.id = job.variant_id;

  SELECT * INTO control
  FROM geo.automation_controls AS automation_control
  WHERE automation_control.tenant_id = tenant_value
    AND automation_control.scope_type = 'tenant'
    AND automation_control.scope_key = '*';

  IF control.id IS NULL THEN
    RETURN 'control_missing:tenant:*';
  END IF;
  IF control.kill_switch_enabled OR control.mode IN ('shadow', 'paused', 'stopped') THEN
    RETURN 'control_blocked:tenant:*';
  END IF;

  FOR control IN
    SELECT automation_control.*
    FROM geo.automation_controls AS automation_control
    WHERE automation_control.tenant_id = tenant_value
      AND (
        (automation_control.scope_type = 'platform' AND
          automation_control.scope_key = job.platform) OR
        (automation_control.scope_type = 'account' AND
          automation_control.scope_key = job.channel_account_id::text) OR
        (automation_control.scope_type = 'campaign' AND content_item.id IS NOT NULL AND
          automation_control.scope_key = content_item.campaign_id::text) OR
        (automation_control.scope_type = 'topic' AND content_item.id IS NOT NULL AND
          automation_control.scope_key = content_item.topic_key)
      )
  LOOP
    IF control.kill_switch_enabled OR control.mode IN ('shadow', 'paused', 'stopped') THEN
      RETURN 'control_blocked:' || control.scope_type || ':' || control.scope_key;
    END IF;
  END LOOP;

  SELECT * INTO breaker
  FROM geo.circuit_breakers AS circuit
  WHERE circuit.tenant_id = tenant_value
    AND circuit.state IN ('open', 'half_open')
    AND (
      (circuit.scope_type = 'tenant' AND circuit.scope_key = '*') OR
      (circuit.scope_type = 'platform' AND circuit.scope_key = job.platform) OR
      (circuit.scope_type = 'account' AND
        circuit.scope_key = job.channel_account_id::text) OR
      (circuit.scope_type = 'campaign' AND content_item.id IS NOT NULL AND
        circuit.scope_key = content_item.campaign_id::text) OR
      (circuit.scope_type = 'topic' AND content_item.id IS NOT NULL AND
        circuit.scope_key = content_item.topic_key)
    )
  LIMIT 1;

  IF breaker.id IS NOT NULL THEN
    RETURN 'circuit_blocked:' || breaker.scope_type || ':' || breaker.scope_key;
  END IF;

  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION geo.create_publication_assisted_handoff(
  p_handoff_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
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
    tenant_id, id, job_id, attempt_id, channel_account_id, variant_id,
    platform, state, payload_hash, audit_hash, preview_hash, adapter_version,
    idempotency_key, expires_at, created_by_actor_id
  ) VALUES (
    tenant_value, p_handoff_id, job.id, attempt.id, job.channel_account_id,
    job.variant_id, 'ctrip_community', 'handoff_pending', job.payload_hash,
    artifact.audit_hash, p_preview_hash, trim(p_adapter_version),
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
      'adapterVersion', trim(p_adapter_version),
      'expiresAt', p_expires_at
    )
  );

  RETURN QUERY SELECT p_handoff_id, true;
END
$$;

CREATE OR REPLACE FUNCTION geo.claim_publication_assisted_handoff(
  p_handoff_id uuid,
  p_lease_seconds integer DEFAULT 120
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  block_reason text;
  lease_expiry timestamptz;
BEGIN
  IF p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'handoff lease must be between 30 and 300 seconds' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id
  FOR UPDATE;

  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002';
  END IF;
  IF handoff.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'assisted handoff has expired' USING ERRCODE = '55000';
  END IF;
  IF handoff.state NOT IN (
    'handoff_pending', 'session_required', 'challenge_required',
    'draft_prepared', 'awaiting_operator_submit'
  ) THEN
    RAISE EXCEPTION 'assisted handoff cannot be claimed in state %', handoff.state
      USING ERRCODE = '55000';
  END IF;
  IF handoff.lease_owner_actor_id IS NOT NULL
     AND handoff.lease_owner_actor_id <> actor_value
     AND handoff.lease_expires_at >= statement_timestamp() THEN
    RAISE EXCEPTION 'assisted handoff has an active operator lease'
      USING ERRCODE = '55006';
  END IF;

  block_reason := geo.publication_assisted_block_reason(handoff.job_id);
  IF block_reason IS NOT NULL THEN
    RAISE EXCEPTION 'assisted handoff claim blocked: %', block_reason USING ERRCODE = '42501';
  END IF;

  lease_expiry := LEAST(
    handoff.expires_at,
    statement_timestamp() + make_interval(secs => p_lease_seconds)
  );

  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET lease_owner_actor_id = actor_value,
      lease_expires_at = lease_expiry,
      heartbeat_at = statement_timestamp()
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.claimed',
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    handoff.preview_hash,
    jsonb_build_object('leaseExpiresAt', lease_expiry)
  );

  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION geo.heartbeat_publication_assisted_handoff(
  p_handoff_id uuid,
  p_lease_seconds integer DEFAULT 120
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  block_reason text;
  lease_expiry timestamptz;
BEGIN
  IF p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'handoff lease must be between 30 and 300 seconds' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id
  FOR UPDATE;

  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002';
  END IF;
  IF handoff.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'assisted handoff has expired' USING ERRCODE = '55000';
  END IF;
  IF handoff.lease_owner_actor_id <> actor_value
     OR handoff.lease_expires_at < statement_timestamp() THEN
    RAISE EXCEPTION 'assisted handoff heartbeat requires the current operator lease'
      USING ERRCODE = '55006';
  END IF;
  IF handoff.state NOT IN (
    'handoff_pending', 'session_required', 'challenge_required',
    'draft_prepared', 'awaiting_operator_submit'
  ) THEN
    RAISE EXCEPTION 'assisted handoff cannot heartbeat in state %', handoff.state
      USING ERRCODE = '55000';
  END IF;

  block_reason := geo.publication_assisted_block_reason(handoff.job_id);
  IF block_reason IS NOT NULL THEN
    RAISE EXCEPTION 'assisted handoff heartbeat blocked: %', block_reason
      USING ERRCODE = '42501';
  END IF;

  lease_expiry := LEAST(
    handoff.expires_at,
    statement_timestamp() + make_interval(secs => p_lease_seconds)
  );

  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET lease_expires_at = lease_expiry,
      heartbeat_at = statement_timestamp()
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id;

  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION geo.record_publication_assisted_draft(
  p_handoff_id uuid,
  p_session_evidence_hash geo.sha256_hex,
  p_draft_evidence_hash geo.sha256_hex
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  handoff geo.publication_assisted_handoffs%ROWTYPE;
BEGIN
  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id
  FOR UPDATE;

  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002';
  END IF;
  IF handoff.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'assisted handoff has expired' USING ERRCODE = '55000';
  END IF;
  IF handoff.lease_owner_actor_id <> actor_value
     OR handoff.lease_expires_at < statement_timestamp() THEN
    RAISE EXCEPTION 'draft evidence requires the current operator lease'
      USING ERRCODE = '55006';
  END IF;
  IF handoff.state NOT IN ('handoff_pending', 'session_required', 'challenge_required') THEN
    RAISE EXCEPTION 'draft evidence cannot be recorded in state %', handoff.state
      USING ERRCODE = '55000';
  END IF;

  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = 'draft_prepared',
      session_evidence_hash = p_session_evidence_hash,
      draft_evidence_hash = p_draft_evidence_hash
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.draft_prepared',
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    p_draft_evidence_hash,
    jsonb_build_object('sessionEvidenceHash', p_session_evidence_hash)
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
  actor_value uuid := geo.require_actor_id();
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  block_reason text;
  permit_value text;
  permit_hash geo.sha256_hex;
  permit_expiry timestamptz;
BEGIN
  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id
  FOR UPDATE;

  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002';
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
      submit_permit_consumed_at = NULL
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.submit_permit_issued',
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    permit_hash,
    jsonb_build_object('expiresAt', permit_expiry)
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
  actor_value uuid := geo.require_actor_id();
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
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id
  FOR UPDATE;

  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002';
  END IF;
  IF handoff.lease_owner_actor_id <> actor_value
     OR handoff.lease_expires_at < statement_timestamp() THEN
    RAISE EXCEPTION 'submit permit consumption requires the current operator lease'
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
  SET submit_permit_consumed_at = statement_timestamp()
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

CREATE OR REPLACE FUNCTION geo.cancel_publication_assisted_handoff(
  p_handoff_id uuid,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  handoff geo.publication_assisted_handoffs%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 5 AND 1000 THEN
    RAISE EXCEPTION 'cancellation reason must contain 5 to 1000 characters'
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
  IF handoff.state = 'cancelled' THEN
    RETURN false;
  END IF;
  IF handoff.state IN (
    'submitted_unconfirmed', 'readback_pending', 'confirmed',
    'needs_review', 'expired', 'failed'
  ) THEN
    RAISE EXCEPTION 'assisted handoff cannot be cancelled in state %', handoff.state
      USING ERRCODE = '55000';
  END IF;
  IF handoff.submit_permit_consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a consumed submit permit requires reconciliation, not cancellation'
      USING ERRCODE = '55000';
  END IF;

  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = 'cancelled',
      lease_owner_actor_id = NULL,
      lease_expires_at = NULL,
      heartbeat_at = NULL,
      submit_permit_hash = NULL,
      submit_permit_expires_at = NULL,
      submit_permit_consumed_at = NULL,
      cancelled_at = statement_timestamp(),
      cancelled_by_actor_id = actor_value,
      cancellation_reason = trim(p_reason)
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.cancelled',
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    handoff.preview_hash,
    jsonb_build_object('reason', trim(p_reason), 'previousState', handoff.state)
  );

  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION geo.enforce_publication_assisted_handoff_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'publication assisted handoffs cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF (to_jsonb(OLD) - ARRAY[
        'state', 'lease_owner_actor_id', 'lease_expires_at', 'heartbeat_at',
        'session_evidence_hash', 'draft_evidence_hash', 'submit_evidence_hash',
        'submit_permit_hash', 'submit_permit_expires_at', 'submit_permit_consumed_at',
        'external_id', 'external_url', 'cancelled_at', 'cancelled_by_actor_id',
        'cancellation_reason', 'last_error_code', 'last_error_message', 'updated_at'
      ]) IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY[
        'state', 'lease_owner_actor_id', 'lease_expires_at', 'heartbeat_at',
        'session_evidence_hash', 'draft_evidence_hash', 'submit_evidence_hash',
        'submit_permit_hash', 'submit_permit_expires_at', 'submit_permit_consumed_at',
        'external_id', 'external_url', 'cancelled_at', 'cancelled_by_actor_id',
        'cancellation_reason', 'last_error_code', 'last_error_message', 'updated_at'
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

CREATE TRIGGER publication_assisted_handoffs_transition_only
BEFORE UPDATE OR DELETE ON geo.publication_assisted_handoffs
FOR EACH ROW EXECUTE FUNCTION geo.enforce_publication_assisted_handoff_transition();

CREATE TRIGGER publication_assisted_handoffs_set_updated_at
BEFORE UPDATE ON geo.publication_assisted_handoffs
FOR EACH ROW EXECUTE FUNCTION geo.set_updated_at();

ALTER TABLE geo.publication_assisted_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.publication_assisted_handoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON geo.publication_assisted_handoffs TO geo_runtime
  USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

REVOKE ALL ON TABLE geo.publication_assisted_handoffs
  FROM PUBLIC, geo_dispatcher, geo_identity, geo_runtime;
GRANT SELECT ON TABLE geo.publication_assisted_handoffs TO geo_runtime;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE geo.publication_assisted_handoffs FROM geo_runtime;

REVOKE ALL ON FUNCTION geo.publication_assisted_block_reason(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.create_publication_assisted_handoff(
  uuid, uuid, uuid, geo.sha256_hex, text, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.claim_publication_assisted_handoff(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.heartbeat_publication_assisted_handoff(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.record_publication_assisted_draft(
  uuid, geo.sha256_hex, geo.sha256_hex
) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.issue_publication_assisted_submit_permit(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.consume_publication_assisted_submit_permit(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.cancel_publication_assisted_handoff(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.enforce_publication_assisted_handoff_transition() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION geo.publication_assisted_block_reason(uuid) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.create_publication_assisted_handoff(
  uuid, uuid, uuid, geo.sha256_hex, text, text, timestamptz
) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.claim_publication_assisted_handoff(uuid, integer) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.heartbeat_publication_assisted_handoff(uuid, integer) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_draft(
  uuid, geo.sha256_hex, geo.sha256_hex
) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.issue_publication_assisted_submit_permit(uuid) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.consume_publication_assisted_submit_permit(uuid, text) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.cancel_publication_assisted_handoff(uuid, text) TO geo_runtime;
