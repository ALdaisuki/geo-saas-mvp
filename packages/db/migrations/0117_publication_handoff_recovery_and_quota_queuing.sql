BEGIN;

-- Assisted browser handoffs must not permanently kill an account queue.
-- Account-level breakers opened by session loss, challenge, or adapter drift
-- now cool down for ten minutes and then allow a half-open recovery probe.
CREATE OR REPLACE FUNCTION geo.open_ctrip_session_required_circuit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, geo
AS $$
BEGIN
  INSERT INTO geo.circuit_breakers (
    tenant_id, scope_type, scope_key, state, failure_count,
    opened_at, retry_at, reason
  ) VALUES (
    NEW.tenant_id, 'account', NEW.channel_account_id::text, 'open', 1,
    statement_timestamp(), statement_timestamp() + interval '10 minutes',
    'ASSISTED_SESSION_REQUIRED'
  )
  ON CONFLICT (tenant_id, scope_type, scope_key) DO UPDATE
  SET state = 'open',
      failure_count = geo.circuit_breakers.failure_count + 1,
      opened_at = statement_timestamp(),
      retry_at = statement_timestamp() + interval '10 minutes',
      reason = 'ASSISTED_SESSION_REQUIRED',
      probe_attempt_id = NULL,
      probe_started_at = NULL,
      updated_at = clock_timestamp();
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION geo.open_ctrip_session_required_circuit() FROM PUBLIC;

CREATE OR REPLACE FUNCTION geo.record_publication_assisted_bridge_status(
  p_handoff_id uuid,
  p_status text,
  p_session_evidence_hash geo.sha256_hex,
  p_prepare_evidence_hash geo.sha256_hex,
  p_prepare_evidence_kind text,
  p_prepare_observed_at timestamptz,
  p_adapter_version text,
  p_error_code text DEFAULT NULL,
  p_error_message text DEFAULT NULL
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
  next_error_message text;
  next_prepare_outcome text;
BEGIN
  next_error_code := CASE
    WHEN p_status = 'session_required' THEN 'ASSISTED_SESSION_REQUIRED'
    WHEN p_status = 'challenge_required' THEN 'ASSISTED_CHALLENGE_REQUIRED'
    ELSE COALESCE(NULLIF(trim(p_error_code), ''), 'ASSISTED_ADAPTER_DRIFT')
  END;
  next_error_message := NULLIF(trim(p_error_message), '');
  next_prepare_outcome := CASE
    WHEN p_status = 'failed' AND next_error_code = 'CTRIP_PAYLOAD_INVALID' THEN 'payload_invalid'
    WHEN p_status = 'failed' THEN 'adapter_drift'
    ELSE p_status
  END;

  IF p_status NOT IN ('session_required', 'challenge_required', 'failed')
     OR p_session_evidence_hash IS NULL OR p_prepare_evidence_hash IS NULL
     OR p_prepare_evidence_kind IS NULL
     OR p_prepare_evidence_kind NOT IN ('simulation', 'browser')
     OR p_prepare_observed_at IS NULL
     OR p_prepare_observed_at > statement_timestamp() + interval '1 minute'
     OR p_prepare_observed_at < statement_timestamp() - interval '30 minutes'
     OR p_adapter_version IS NULL OR length(trim(p_adapter_version)) NOT BETWEEN 1 AND 100
     OR (p_status = 'failed' AND next_error_code NOT IN (
       'ASSISTED_ADAPTER_DRIFT', 'CTRIP_PAYLOAD_INVALID'
     ))
     OR (next_error_message IS NOT NULL AND (
       length(next_error_message) NOT BETWEEN 1 AND 160
       OR next_error_message !~ '^prepare:[a-z0-9:_-]+$'
     )) THEN
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
  IF handoff.draft_prepare_owner_principal_id <> actor_value
     OR handoff.draft_prepare_lease_expires_at < statement_timestamp() THEN
    RAISE EXCEPTION 'bridge status requires the current draft preparation lease'
      USING ERRCODE = '55006';
  END IF;
  IF handoff.state NOT IN ('handoff_pending', 'session_required', 'challenge_required') THEN
    RAISE EXCEPTION 'bridge status cannot be recorded in state %', handoff.state
      USING ERRCODE = '55000';
  END IF;
  IF handoff.adapter_version <> trim(p_adapter_version) THEN
    RAISE EXCEPTION 'bridge adapter version does not match the reviewed handoff'
      USING ERRCODE = '42501';
  END IF;

  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = p_status,
      session_evidence_hash = p_session_evidence_hash,
      prepare_outcome = next_prepare_outcome,
      prepare_evidence_hash = p_prepare_evidence_hash,
      prepare_evidence_kind = p_prepare_evidence_kind,
      prepare_observed_at = p_prepare_observed_at,
      media_manifest_hash = NULL,
      draft_prepare_owner_principal_id = NULL,
      draft_prepare_lease_expires_at = NULL,
      last_error_code = next_error_code,
      last_error_message = next_error_message,
      updated_at = clock_timestamp()
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id;

  IF p_status = 'challenge_required' OR next_error_code = 'ASSISTED_ADAPTER_DRIFT' THEN
    INSERT INTO geo.circuit_breakers (
      tenant_id, scope_type, scope_key, state, failure_count,
      opened_at, retry_at, reason
    ) VALUES (
      tenant_value, 'account', handoff.channel_account_id::text, 'open', 1,
      statement_timestamp(), statement_timestamp() + interval '10 minutes',
      next_error_code
    )
    ON CONFLICT (tenant_id, scope_type, scope_key) DO UPDATE
    SET state = 'open',
        failure_count = geo.circuit_breakers.failure_count + 1,
        opened_at = statement_timestamp(),
        retry_at = statement_timestamp() + interval '10 minutes',
        reason = next_error_code,
        probe_attempt_id = NULL,
        probe_started_at = NULL,
        updated_at = clock_timestamp();
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
      'prepareOutcome', next_prepare_outcome,
      'sessionEvidenceHash', p_session_evidence_hash,
      'evidenceKind', p_prepare_evidence_kind,
      'observedAt', p_prepare_observed_at,
      'errorCode', next_error_code,
      'diagnosticCode', next_error_message
    )
  );
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION geo.record_publication_assisted_bridge_status(
  uuid, text, geo.sha256_hex, geo.sha256_hex, text, timestamptz, text, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_bridge_status(
  uuid, text, geo.sha256_hex, geo.sha256_hex, text, timestamptz, text, text, text
) TO geo_runtime;

-- A successful browser draft clears the account recovery breaker; otherwise a
-- recovered session would stay flagged open even after the cooldown passes.
CREATE OR REPLACE FUNCTION geo.record_publication_assisted_draft(
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
     OR p_public_content_hash IS NULL
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
  IF handoff.draft_prepare_owner_principal_id <> actor_value
     OR handoff.draft_prepare_lease_expires_at < statement_timestamp() THEN
    RAISE EXCEPTION 'draft evidence requires the current draft preparation lease'
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

  PERFORM set_config('app.allow_account_half_open_probe', 'true', true);
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
      public_content_hash = p_public_content_hash,
      external_draft_id = trim(p_external_draft_id),
      draft_prepare_owner_principal_id = NULL,
      draft_prepare_lease_expires_at = NULL,
      last_error_code = NULL,
      last_error_message = NULL,
      updated_at = clock_timestamp()
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id;

  UPDATE geo.circuit_breakers AS circuit
  SET state = 'closed',
      failure_count = 0,
      opened_at = NULL,
      retry_at = NULL,
      reason = NULL,
      probe_attempt_id = NULL,
      probe_started_at = NULL,
      updated_at = clock_timestamp()
  WHERE circuit.tenant_id = tenant_value
    AND circuit.scope_type = 'account'
    AND circuit.scope_key = handoff.channel_account_id::text
    AND circuit.state IN ('open', 'half_open')
    AND circuit.reason IN (
      'ASSISTED_SESSION_REQUIRED',
      'ASSISTED_CHALLENGE_REQUIRED',
      'ASSISTED_ADAPTER_DRIFT'
    );

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
      'publicContentHash', p_public_content_hash,
      'evidenceKind', p_prepare_evidence_kind,
      'observedAt', p_prepare_observed_at,
      'externalDraftIdHash', encode(public.digest(trim(p_external_draft_id), 'sha256'), 'hex')
    )
  );
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION geo.record_publication_assisted_draft(
  uuid, geo.sha256_hex, geo.sha256_hex, geo.sha256_hex, geo.sha256_hex,
  geo.sha256_hex, text, timestamptz, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_draft(
  uuid, geo.sha256_hex, geo.sha256_hex, geo.sha256_hex, geo.sha256_hex,
  geo.sha256_hex, text, timestamptz, text, text
) TO geo_runtime;

-- Allow the bridge to retry a handoff once the account cooldown has elapsed
-- instead of treating every open breaker as an irreversible block.
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
  WHERE publication_job.tenant_id = tenant_value
    AND publication_job.id = p_job_id;

  IF job.id IS NULL THEN RETURN 'job_not_found'; END IF;
  IF job.execution_level NOT IN ('assisted', 'unattended') THEN
    RETURN 'job_execution_level_not_browser_assisted';
  END IF;
  IF job.platform NOT IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community') THEN
    RETURN 'job_platform_not_browser_assisted';
  END IF;
  IF job.state NOT IN ('dispatching', 'uncertain', 'reconciling') THEN
    RETURN 'job_state:' || job.state;
  END IF;

  SELECT * INTO publication_grant
  FROM geo.publication_grants AS grant_row
  WHERE grant_row.tenant_id = tenant_value
    AND grant_row.id = job.grant_id;

  IF publication_grant.id IS NULL
     OR publication_grant.status <> 'consumed'
     OR publication_grant.expires_at <= statement_timestamp()
     OR publication_grant.audit_artifact_id <> job.audit_artifact_id
     OR publication_grant.variant_id <> job.variant_id
     OR publication_grant.channel_account_id <> job.channel_account_id
     OR publication_grant.platform <> job.platform
     OR publication_grant.payload_hash <> job.payload_hash THEN
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
     OR account.platform <> job.platform
     OR account.capability <> 'browser_assisted'
     OR NOT (job.execution_level = ANY(account.supported_execution_levels)) THEN
    RETURN 'account_browser_capability_not_current';
  END IF;

  IF job.platform = 'ctrip_community'
     AND NOT geo.ctrip_protected_history_baseline_bound(job.channel_account_id) THEN
    RETURN 'ctrip_protected_history_baseline_missing';
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

  IF control.id IS NULL THEN RETURN 'control_missing:tenant:*'; END IF;
  IF control.kill_switch_enabled OR (
       job.execution_level = 'unattended' AND control.mode <> 'unattended'
     ) OR (
       job.execution_level = 'assisted' AND control.mode IN ('shadow', 'paused', 'stopped')
     ) THEN
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
    IF control.kill_switch_enabled OR (
         job.execution_level = 'unattended' AND control.mode <> 'unattended'
       ) OR (
         job.execution_level = 'assisted' AND control.mode IN ('shadow', 'paused', 'stopped')
       ) THEN
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
      (circuit.scope_type = 'account' AND circuit.scope_key = job.channel_account_id::text) OR
      (circuit.scope_type = 'campaign' AND content_item.id IS NOT NULL AND
        circuit.scope_key = content_item.campaign_id::text) OR
      (circuit.scope_type = 'topic' AND content_item.id IS NOT NULL AND
        circuit.scope_key = content_item.topic_key)
    )
    AND (
      (circuit.state = 'open' AND
        (circuit.retry_at IS NULL OR circuit.retry_at > statement_timestamp())) OR
      (circuit.state = 'half_open')
    )
    AND NOT (
      COALESCE(current_setting('app.allow_account_half_open_probe', true), '') = 'true'
      AND circuit.scope_type = 'account'
      AND circuit.state = 'half_open'
      AND circuit.reason IN (
        'ASSISTED_SESSION_REQUIRED',
        'ASSISTED_CHALLENGE_REQUIRED',
        'ASSISTED_ADAPTER_DRIFT'
      )
    )
  LIMIT 1;

  IF breaker.id IS NOT NULL THEN
    RETURN 'circuit_blocked:' || breaker.scope_type || ':' || breaker.scope_key;
  END IF;

  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION geo.publication_assisted_block_reason(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.publication_assisted_block_reason(uuid) TO geo_runtime;

-- Reclaim or expire assisted handoffs that were left in session/challenge
-- states without an active draft lease. Terminal sync marks the job/attempt
-- needs_review when a handoff can no longer be recovered in time.
CREATE OR REPLACE FUNCTION geo.expire_stale_publication_assisted_handoffs(
  p_max_count integer DEFAULT 100
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  stale_handoff record;
  expired_count integer := 0;
BEGIN
  IF p_max_count IS NULL OR p_max_count NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'stale handoff sweep count must be between 1 and 500'
      USING ERRCODE = '22023';
  END IF;

  FOR stale_handoff IN
    SELECT candidate.id, candidate.state AS state_before, candidate.preview_hash
    FROM geo.publication_assisted_handoffs AS candidate
    WHERE candidate.tenant_id = tenant_value
      AND candidate.state IN ('handoff_pending', 'session_required', 'challenge_required')
      AND candidate.expires_at <= statement_timestamp()
    ORDER BY candidate.created_at, candidate.id
    LIMIT p_max_count
    FOR UPDATE OF candidate SKIP LOCKED
  LOOP
    UPDATE geo.publication_assisted_handoffs AS handoff
    SET state = 'expired',
        lease_owner_actor_id = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NULL,
        draft_prepare_owner_principal_id = NULL,
        draft_prepare_lease_expires_at = NULL,
        submit_permit_hash = NULL,
        submit_permit_expires_at = NULL,
        submit_permit_consumed_at = NULL,
        submit_permit_issued_by_actor_id = NULL,
        submit_permit_consumed_by_principal_id = NULL,
        last_error_code = COALESCE(
          NULLIF(trim(handoff.last_error_code), ''),
          'ASSISTED_HANDOFF_EXPIRED'
        ),
        last_error_message = COALESCE(
          NULLIF(trim(handoff.last_error_message), ''),
          'assisted handoff expired before preparation completed'
        ),
        updated_at = clock_timestamp()
    WHERE handoff.tenant_id = tenant_value AND handoff.id = stale_handoff.id
      AND handoff.state IN ('handoff_pending', 'session_required', 'challenge_required')
      AND handoff.expires_at <= statement_timestamp();

    IF FOUND THEN
      INSERT INTO geo.audit_log (
        tenant_id, actor_id, action, resource_type, resource_id,
        request_id, after_hash, details
      ) VALUES (
        tenant_value,
        actor_value,
        'publication_assisted_handoff.expired_stale',
        'publication_assisted_handoff',
        stale_handoff.id,
        COALESCE(NULLIF(current_setting('app.request_id', true), ''), stale_handoff.id::text),
        stale_handoff.preview_hash,
        jsonb_build_object(
          'handoffStateBefore', stale_handoff.state_before
        )
      );
      expired_count := expired_count + 1;
    END IF;
  END LOOP;

  RETURN expired_count;
END
$$;

REVOKE ALL ON FUNCTION geo.expire_stale_publication_assisted_handoffs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.expire_stale_publication_assisted_handoffs(integer) TO geo_runtime;

-- Claim next now includes recovered session/challenge handoffs and sweeps
-- expired work first so the bridge does not permanently strand a handoff.
CREATE OR REPLACE FUNCTION geo.claim_next_publication_assisted_draft_prepare(
  p_lease_seconds integer DEFAULT 300
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  lease_expiry timestamptz;
  account_breaker_id uuid;
  account_breaker_state text;
  account_breaker_retry_at timestamptz;
BEGIN
  IF p_lease_seconds NOT BETWEEN 30 AND 600 THEN
    RAISE EXCEPTION 'draft preparation lease must be between 30 and 600 seconds'
      USING ERRCODE = '22023';
  END IF;
  PERFORM geo.require_ctrip_bridge_principal(actor_value);
  PERFORM geo.expire_stale_publication_assisted_handoffs(100);
  -- The claim itself is the recovery probe: let the candidate pass a stale
  -- half-open account breaker so a crashed probe can be re-armed below.
  PERFORM set_config('app.allow_account_half_open_probe', 'true', true);

  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS candidate
  WHERE candidate.tenant_id = tenant_value
    AND candidate.bridge_service_principal_id = actor_value
    AND candidate.state IN ('handoff_pending', 'session_required', 'challenge_required')
    AND candidate.expires_at > statement_timestamp()
    AND (
      candidate.draft_prepare_owner_principal_id IS NULL OR
      candidate.draft_prepare_lease_expires_at < statement_timestamp()
    )
    AND geo.publication_assisted_block_reason(candidate.job_id) IS NULL
  ORDER BY candidate.created_at, candidate.id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF handoff.id IS NULL THEN
    RETURN NULL;
  END IF;

  -- A recovered assisted handoff starts a half-open probe. Lock the account
  -- breaker so concurrent bridge pollers cannot claim a second handoff for the
  -- same account while this probe is in flight.
  SELECT circuit.id, circuit.state, circuit.retry_at
  INTO account_breaker_id, account_breaker_state, account_breaker_retry_at
  FROM geo.circuit_breakers AS circuit
  WHERE circuit.tenant_id = tenant_value
    AND circuit.scope_type = 'account'
    AND circuit.scope_key = handoff.channel_account_id::text
    AND circuit.state IN ('open', 'half_open')
    AND circuit.reason IN (
      'ASSISTED_SESSION_REQUIRED',
      'ASSISTED_CHALLENGE_REQUIRED',
      'ASSISTED_ADAPTER_DRIFT'
    )
  FOR UPDATE;

  IF account_breaker_id IS NOT NULL THEN
    IF account_breaker_state = 'open' THEN
      IF account_breaker_retry_at IS NULL
         OR account_breaker_retry_at > statement_timestamp() THEN
        RETURN NULL;
      END IF;
      UPDATE geo.circuit_breakers AS circuit
      SET state = 'half_open',
          retry_at = NULL,
          probe_attempt_id = handoff.attempt_id,
          probe_started_at = statement_timestamp(),
          updated_at = clock_timestamp()
      WHERE circuit.tenant_id = tenant_value
        AND circuit.id = account_breaker_id
        AND circuit.state = 'open'
        AND circuit.reason IN (
          'ASSISTED_SESSION_REQUIRED',
          'ASSISTED_CHALLENGE_REQUIRED',
          'ASSISTED_ADAPTER_DRIFT'
        );
    ELSIF account_breaker_state = 'half_open' THEN
      -- A prior probe left the breaker half-open. Re-arm it only when no other
      -- handoff for this account still holds an active draft preparation lease.
      IF EXISTS (
        SELECT 1
        FROM geo.publication_assisted_handoffs AS active_probe
        WHERE active_probe.tenant_id = tenant_value
          AND active_probe.channel_account_id = handoff.channel_account_id
          AND active_probe.id <> handoff.id
          AND active_probe.state IN (
            'handoff_pending', 'session_required', 'challenge_required'
          )
          AND active_probe.draft_prepare_owner_principal_id IS NOT NULL
          AND active_probe.draft_prepare_lease_expires_at > statement_timestamp()
      ) THEN
        RETURN NULL;
      END IF;
      UPDATE geo.circuit_breakers AS circuit
      SET retry_at = NULL,
          probe_attempt_id = handoff.attempt_id,
          probe_started_at = statement_timestamp(),
          updated_at = clock_timestamp()
      WHERE circuit.tenant_id = tenant_value
        AND circuit.id = account_breaker_id
        AND circuit.state = 'half_open'
        AND circuit.reason IN (
          'ASSISTED_SESSION_REQUIRED',
          'ASSISTED_CHALLENGE_REQUIRED',
          'ASSISTED_ADAPTER_DRIFT'
        );
    END IF;
  END IF;

  lease_expiry := LEAST(
    handoff.expires_at,
    statement_timestamp() + make_interval(secs => p_lease_seconds)
  );
  UPDATE geo.publication_assisted_handoffs AS claimed
  SET draft_prepare_owner_principal_id = actor_value,
      draft_prepare_lease_expires_at = lease_expiry,
      updated_at = clock_timestamp()
  WHERE claimed.tenant_id = tenant_value AND claimed.id = handoff.id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.draft_prepare_claimed',
    'publication_assisted_handoff', handoff.id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), handoff.id::text),
    handoff.preview_hash,
    jsonb_build_object(
      'leaseExpiresAt', lease_expiry,
      'claimMode', 'next',
      'probeArmed', account_breaker_id IS NOT NULL,
      'recoveredState', handoff.state
    )
  );

  RETURN handoff.id;
END
$$;

REVOKE ALL ON FUNCTION geo.claim_next_publication_assisted_draft_prepare(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.claim_next_publication_assisted_draft_prepare(integer) TO geo_runtime;

CREATE OR REPLACE FUNCTION geo.claim_next_publication_assisted_draft_prepare(
  p_lease_seconds integer,
  p_execution_level text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  lease_expiry timestamptz;
  account_breaker_id uuid;
  account_breaker_state text;
  account_breaker_retry_at timestamptz;
BEGIN
  IF p_lease_seconds NOT BETWEEN 30 AND 600 THEN
    RAISE EXCEPTION 'draft preparation lease must be between 30 and 600 seconds'
      USING ERRCODE = '22023';
  END IF;
  IF p_execution_level NOT IN ('assisted', 'unattended') THEN
    RAISE EXCEPTION 'unsupported draft preparation execution level'
      USING ERRCODE = '22023';
  END IF;
  PERFORM geo.require_ctrip_bridge_principal(actor_value);
  PERFORM geo.expire_stale_publication_assisted_handoffs(100);
  -- The claim itself is the recovery probe: let the candidate pass a stale
  -- half-open account breaker so a crashed probe can be re-armed below.
  PERFORM set_config('app.allow_account_half_open_probe', 'true', true);

  SELECT candidate.* INTO handoff
  FROM geo.publication_assisted_handoffs AS candidate
  JOIN geo.publication_jobs AS job
    ON job.tenant_id = candidate.tenant_id AND job.id = candidate.job_id
  WHERE candidate.tenant_id = tenant_value
    AND candidate.bridge_service_principal_id = actor_value
    AND job.execution_level = p_execution_level
    AND candidate.state IN ('handoff_pending', 'session_required', 'challenge_required')
    AND candidate.expires_at > statement_timestamp()
    AND (
      candidate.draft_prepare_owner_principal_id IS NULL OR
      candidate.draft_prepare_lease_expires_at < statement_timestamp()
    )
    AND geo.publication_assisted_block_reason(candidate.job_id) IS NULL
  ORDER BY candidate.created_at, candidate.id
  FOR UPDATE OF candidate SKIP LOCKED
  LIMIT 1;

  IF handoff.id IS NULL THEN
    RETURN NULL;
  END IF;

  -- A recovered assisted handoff starts a half-open probe. Lock the account
  -- breaker so concurrent bridge pollers cannot claim a second handoff for the
  -- same account while this probe is in flight.
  SELECT circuit.id, circuit.state, circuit.retry_at
  INTO account_breaker_id, account_breaker_state, account_breaker_retry_at
  FROM geo.circuit_breakers AS circuit
  WHERE circuit.tenant_id = tenant_value
    AND circuit.scope_type = 'account'
    AND circuit.scope_key = handoff.channel_account_id::text
    AND circuit.state IN ('open', 'half_open')
    AND circuit.reason IN (
      'ASSISTED_SESSION_REQUIRED',
      'ASSISTED_CHALLENGE_REQUIRED',
      'ASSISTED_ADAPTER_DRIFT'
    )
  FOR UPDATE;

  IF account_breaker_id IS NOT NULL THEN
    IF account_breaker_state = 'open' THEN
      IF account_breaker_retry_at IS NULL
         OR account_breaker_retry_at > statement_timestamp() THEN
        RETURN NULL;
      END IF;
      UPDATE geo.circuit_breakers AS circuit
      SET state = 'half_open',
          retry_at = NULL,
          probe_attempt_id = handoff.attempt_id,
          probe_started_at = statement_timestamp(),
          updated_at = clock_timestamp()
      WHERE circuit.tenant_id = tenant_value
        AND circuit.id = account_breaker_id
        AND circuit.state = 'open'
        AND circuit.reason IN (
          'ASSISTED_SESSION_REQUIRED',
          'ASSISTED_CHALLENGE_REQUIRED',
          'ASSISTED_ADAPTER_DRIFT'
        );
    ELSIF account_breaker_state = 'half_open' THEN
      -- A prior probe left the breaker half-open. Re-arm it only when no other
      -- handoff for this account still holds an active draft preparation lease.
      IF EXISTS (
        SELECT 1
        FROM geo.publication_assisted_handoffs AS active_probe
        WHERE active_probe.tenant_id = tenant_value
          AND active_probe.channel_account_id = handoff.channel_account_id
          AND active_probe.id <> handoff.id
          AND active_probe.state IN (
            'handoff_pending', 'session_required', 'challenge_required'
          )
          AND active_probe.draft_prepare_owner_principal_id IS NOT NULL
          AND active_probe.draft_prepare_lease_expires_at > statement_timestamp()
      ) THEN
        RETURN NULL;
      END IF;
      UPDATE geo.circuit_breakers AS circuit
      SET retry_at = NULL,
          probe_attempt_id = handoff.attempt_id,
          probe_started_at = statement_timestamp(),
          updated_at = clock_timestamp()
      WHERE circuit.tenant_id = tenant_value
        AND circuit.id = account_breaker_id
        AND circuit.state = 'half_open'
        AND circuit.reason IN (
          'ASSISTED_SESSION_REQUIRED',
          'ASSISTED_CHALLENGE_REQUIRED',
          'ASSISTED_ADAPTER_DRIFT'
        );
    END IF;
  END IF;

  lease_expiry := LEAST(
    handoff.expires_at,
    statement_timestamp() + make_interval(secs => p_lease_seconds)
  );
  UPDATE geo.publication_assisted_handoffs AS claimed
  SET draft_prepare_owner_principal_id = actor_value,
      draft_prepare_lease_expires_at = lease_expiry,
      updated_at = clock_timestamp()
  WHERE claimed.tenant_id = tenant_value AND claimed.id = handoff.id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.draft_prepare_claimed',
    'publication_assisted_handoff', handoff.id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), handoff.id::text),
    handoff.preview_hash,
    jsonb_build_object(
      'leaseExpiresAt', lease_expiry,
      'claimMode', 'next',
      'executionLevel', p_execution_level,
      'probeArmed', account_breaker_id IS NOT NULL,
      'recoveredState', handoff.state
    )
  );

  RETURN handoff.id;
END
$$;

REVOKE ALL ON FUNCTION geo.claim_next_publication_assisted_draft_prepare(integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.claim_next_publication_assisted_draft_prepare(integer, text) TO geo_runtime;

-- Operator heartbeats must survive the half-open probe window. The bridge
-- holds the draft preparation lease while probing, so let that job heartbeat
-- through the account breaker until the probe reports draft or failure.
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

  IF handoff.draft_prepare_owner_principal_id IS NOT NULL
     AND handoff.draft_prepare_lease_expires_at > statement_timestamp() THEN
    PERFORM set_config('app.allow_account_half_open_probe', 'true', true);
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

REVOKE ALL ON FUNCTION geo.heartbeat_publication_assisted_handoff(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.heartbeat_publication_assisted_handoff(uuid, integer) TO geo_runtime;

-- Repair already-open account breakers that were created with an infinite
-- cooldown so the next bridge poll can recover them.
UPDATE geo.circuit_breakers AS circuit
SET retry_at = clock_timestamp() + interval '10 minutes',
    updated_at = clock_timestamp()
WHERE circuit.state = 'open'
  AND circuit.scope_type = 'account'
  AND circuit.retry_at IS NULL
  AND circuit.reason IN (
    'ASSISTED_ADAPTER_DRIFT',
    'ASSISTED_SESSION_REQUIRED',
    'ASSISTED_CHALLENGE_REQUIRED'
  );

COMMIT;
