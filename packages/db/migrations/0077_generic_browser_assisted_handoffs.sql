BEGIN;

-- The browser handoff lineage is shared by all priority article platforms.
-- Platform remains server-derived: admission copies the grant platform and
-- handoff creation copies the already validated publication job platform.
ALTER TABLE geo.publication_assisted_handoffs
  DROP CONSTRAINT IF EXISTS publication_assisted_handoffs_platform_check;

ALTER TABLE geo.publication_assisted_handoffs
  ALTER COLUMN platform DROP DEFAULT,
  ADD CONSTRAINT publication_assisted_handoffs_platform_check
    CHECK (platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community'))
    NOT VALID;

ALTER TABLE geo.publication_assisted_handoffs
  VALIDATE CONSTRAINT publication_assisted_handoffs_platform_check;

COMMENT ON TABLE geo.publication_assisted_handoffs IS
  'Tenant-scoped browser publication handoffs; platform is derived from the audited publication job';

-- A commissioned bridge is tenant-level authority. The runtime binding keeps
-- each account/profile isolated and proves that the selected principal is the
-- one commissioned for the tenant.
CREATE OR REPLACE FUNCTION geo.enforce_commissioned_ctrip_bridge_handoff()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM geo.ctrip_bridge_commissioning_receipts AS receipt
    WHERE receipt.tenant_id = NEW.tenant_id
  ) AND NOT EXISTS (
    SELECT 1
    FROM geo.ctrip_account_runtime_bindings AS binding
    JOIN geo.channel_accounts AS account
      ON account.tenant_id = binding.tenant_id
     AND account.id = binding.channel_account_id
     AND account.platform = binding.platform
     AND account.platform = NEW.platform
     AND account.status = 'active'
    JOIN geo.ctrip_bridge_commissioning_receipts AS receipt
      ON receipt.tenant_id = binding.tenant_id
     AND receipt.bridge_service_principal_id = binding.bridge_principal_id
    JOIN geo.service_principals AS principal
      ON principal.tenant_id = receipt.tenant_id
     AND principal.id = receipt.bridge_service_principal_id
     AND principal.name = receipt.principal_name
     AND principal.kind = 'integration'
     AND principal.profile = 'ctrip_bridge'
     AND principal.status = 'active'
     AND principal.capabilities @> '["tenant:read","content:read","publish:bridge"]'::jsonb
     AND principal.capabilities <@ '["tenant:read","content:read","publish:bridge"]'::jsonb
    WHERE binding.tenant_id = NEW.tenant_id
      AND binding.channel_account_id = NEW.channel_account_id
      AND binding.platform = NEW.platform
      AND binding.bridge_principal_id = NEW.bridge_service_principal_id
      AND binding.session_state <> 'disabled'
  ) THEN
    RAISE EXCEPTION 'browser handoff account runtime does not match the commissioned bridge'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION geo.enforce_commissioned_ctrip_bridge_handoff() FROM PUBLIC;

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
  IF job.execution_level = 'unattended' AND job.platform <> 'ctrip_community' THEN
    RETURN 'job_platform_unattended_not_supported';
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
  LIMIT 1;

  IF breaker.id IS NOT NULL THEN
    RETURN 'circuit_blocked:' || breaker.scope_type || ':' || breaker.scope_key;
  END IF;

  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION geo.consume_browser_assisted_publication_grant(
  p_grant_id uuid,
  p_token_hash geo.sha256_hex,
  p_idempotency_key text,
  p_request_hash geo.sha256_hex,
  p_execution_level text,
  p_scheduled_for timestamptz
)
RETURNS TABLE (
  publication_job_id uuid,
  publication_outbox_event_id uuid,
  was_created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  grant_row geo.publication_grants%ROWTYPE;
  artifact_row geo.audit_artifacts%ROWTYPE;
  variant_row geo.publication_variants%ROWTYPE;
  account_row geo.channel_accounts%ROWTYPE;
  content_item_row geo.content_items%ROWTYPE;
  control_row geo.automation_controls%ROWTYPE;
  scoped_control geo.automation_controls%ROWTYPE;
  job_value uuid;
  outbox_value uuid;
  scheduled_value timestamptz := COALESCE(p_scheduled_for, statement_timestamp());
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'idempotency key must contain 1 to 200 characters'
      USING ERRCODE = '22023';
  END IF;
  IF p_execution_level NOT IN ('assisted', 'unattended') THEN
    RAISE EXCEPTION 'browser admission requires assisted or unattended execution'
      USING ERRCODE = '0A000';
  END IF;
  IF scheduled_value < statement_timestamp() - interval '1 second' THEN
    RAISE EXCEPTION 'scheduled publication time cannot be in the past'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    tenant_value::text || ':' || p_idempotency_key,
    0
  ));

  SELECT job.id, event.id INTO job_value, outbox_value
  FROM geo.publication_jobs AS job
  JOIN geo.outbox_events AS event
    ON event.tenant_id = job.tenant_id
   AND event.aggregate_id = job.id
   AND event.topic = 'publication.requested'
  WHERE job.tenant_id = tenant_value
    AND job.idempotency_key = p_idempotency_key;

  IF job_value IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM geo.publication_jobs AS job
      JOIN geo.publication_grants AS publication_grant
        ON publication_grant.tenant_id = job.tenant_id
       AND publication_grant.id = job.grant_id
      JOIN geo.channel_accounts AS account
        ON account.tenant_id = job.tenant_id
       AND account.id = job.channel_account_id
      WHERE job.tenant_id = tenant_value
        AND job.id = job_value
        AND job.grant_id = p_grant_id
        AND job.request_hash = p_request_hash
        AND job.execution_level = p_execution_level
        AND job.audit_artifact_id = publication_grant.audit_artifact_id
        AND job.variant_id = publication_grant.variant_id
        AND job.channel_account_id = publication_grant.channel_account_id
        AND job.platform = publication_grant.platform
        AND job.payload_hash = publication_grant.payload_hash
        AND account.platform = publication_grant.platform
    ) THEN
      RAISE EXCEPTION 'idempotency key conflicts with another publication request'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT job_value, outbox_value, false;
    RETURN;
  END IF;

  SELECT * INTO grant_row
  FROM geo.publication_grants AS publication_grant
  WHERE publication_grant.tenant_id = tenant_value
    AND publication_grant.id = p_grant_id
  FOR UPDATE;

  IF grant_row.id IS NULL
     OR grant_row.status <> 'issued'
     OR grant_row.expires_at <= statement_timestamp()
     OR grant_row.token_hash <> p_token_hash THEN
    RAISE EXCEPTION 'publication grant is invalid, expired, consumed, revoked, or mismatched'
      USING ERRCODE = '42501';
  END IF;
  IF grant_row.platform NOT IN (
    'toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community'
  ) THEN
    RAISE EXCEPTION 'publication grant platform is not browser-assisted'
      USING ERRCODE = '42501';
  END IF;
  IF p_execution_level = 'unattended' AND grant_row.platform <> 'ctrip_community' THEN
    RAISE EXCEPTION 'unattended browser admission is not enabled for this platform'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO artifact_row
  FROM geo.audit_artifacts AS artifact
  WHERE artifact.tenant_id = tenant_value
    AND artifact.id = grant_row.audit_artifact_id;

  SELECT * INTO variant_row
  FROM geo.publication_variants AS variant
  WHERE variant.tenant_id = tenant_value
    AND variant.id = grant_row.variant_id;

  SELECT item.* INTO content_item_row
  FROM geo.content_versions AS version
  JOIN geo.content_items AS item
    ON item.tenant_id = version.tenant_id
   AND item.id = version.content_item_id
  WHERE version.tenant_id = tenant_value
    AND version.id = variant_row.content_version_id;

  SELECT * INTO account_row
  FROM geo.channel_accounts AS account
  WHERE account.tenant_id = tenant_value
    AND account.id = grant_row.channel_account_id;

  IF artifact_row.id IS NULL
     OR artifact_row.status <> 'passed'
     OR artifact_row.expires_at <= statement_timestamp()
     OR artifact_row.variant_id <> grant_row.variant_id
     OR artifact_row.channel_account_id <> grant_row.channel_account_id
     OR artifact_row.platform <> grant_row.platform
     OR artifact_row.payload_hash <> grant_row.payload_hash
     OR artifact_row.audit_hash <> grant_row.audit_hash THEN
    RAISE EXCEPTION 'publication audit is no longer valid'
      USING ERRCODE = '42501';
  END IF;

  IF variant_row.id IS NULL
     OR variant_row.state <> 'frozen'
     OR variant_row.channel_account_id <> grant_row.channel_account_id
     OR variant_row.platform <> grant_row.platform
     OR variant_row.payload_hash <> grant_row.payload_hash
     OR content_item_row.id IS NULL THEN
    RAISE EXCEPTION 'publication variant is no longer valid'
      USING ERRCODE = '42501';
  END IF;

  IF scheduled_value >= grant_row.expires_at
     OR scheduled_value >= artifact_row.expires_at THEN
    RAISE EXCEPTION 'scheduled publication must start before its grant and audit expire'
      USING ERRCODE = '22023';
  END IF;

  IF account_row.id IS NULL
     OR account_row.status <> 'active'
     OR account_row.platform <> grant_row.platform
     OR account_row.capability <> 'browser_assisted'
     OR NOT (p_execution_level = ANY(account_row.supported_execution_levels)) THEN
    RAISE EXCEPTION 'account browser-assisted capability is not current'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO control_row
  FROM geo.automation_controls AS control
  WHERE control.tenant_id = tenant_value
    AND control.scope_type = 'tenant'
    AND control.scope_key = '*';

  IF control_row.id IS NULL
     OR control_row.kill_switch_enabled
     OR (p_execution_level = 'unattended' AND control_row.mode <> 'unattended')
     OR (p_execution_level = 'assisted' AND
       control_row.mode IN ('shadow', 'paused', 'stopped')) THEN
    RAISE EXCEPTION 'tenant automation control blocks browser handoff'
      USING ERRCODE = '42501';
  END IF;

  FOR scoped_control IN
    SELECT control.*
    FROM geo.automation_controls AS control
    WHERE control.tenant_id = tenant_value
      AND (
        (control.scope_type = 'platform' AND control.scope_key = grant_row.platform) OR
        (control.scope_type = 'account' AND
          control.scope_key = grant_row.channel_account_id::text) OR
        (control.scope_type = 'campaign' AND
          control.scope_key = content_item_row.campaign_id::text) OR
        (control.scope_type = 'topic' AND
          control.scope_key = content_item_row.topic_key)
      )
  LOOP
    IF scoped_control.kill_switch_enabled
       OR (p_execution_level = 'unattended' AND scoped_control.mode <> 'unattended')
       OR (p_execution_level = 'assisted' AND
         scoped_control.mode IN ('shadow', 'paused', 'stopped')) THEN
      RAISE EXCEPTION 'scoped automation control blocks browser handoff'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM geo.circuit_breakers AS breaker
    WHERE breaker.tenant_id = tenant_value
      AND breaker.state IN ('open', 'half_open')
      AND (
        (breaker.scope_type = 'tenant' AND breaker.scope_key = '*') OR
        (breaker.scope_type = 'platform' AND breaker.scope_key = grant_row.platform) OR
        (breaker.scope_type = 'account' AND
          breaker.scope_key = grant_row.channel_account_id::text) OR
        (breaker.scope_type = 'campaign' AND
          breaker.scope_key = content_item_row.campaign_id::text) OR
        (breaker.scope_type = 'topic' AND breaker.scope_key = content_item_row.topic_key)
      )
  ) THEN
    RAISE EXCEPTION 'a circuit breaker blocks browser handoff'
      USING ERRCODE = '42501';
  END IF;

  job_value := gen_random_uuid();
  outbox_value := gen_random_uuid();

  UPDATE geo.publication_grants AS publication_grant
  SET status = 'consumed',
      consumed_at = clock_timestamp(),
      consumed_by_actor_id = actor_value
  WHERE publication_grant.tenant_id = tenant_value
    AND publication_grant.id = grant_row.id
    AND publication_grant.status = 'issued';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'publication grant was concurrently consumed'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO geo.publication_jobs (
    tenant_id, id, grant_id, audit_artifact_id, variant_id, channel_account_id,
    platform, execution_level, state, idempotency_key, request_hash, payload_hash,
    available_at, scheduled_for
  ) VALUES (
    tenant_value, job_value, grant_row.id, grant_row.audit_artifact_id,
    grant_row.variant_id, grant_row.channel_account_id, grant_row.platform,
    p_execution_level, 'queued', p_idempotency_key, p_request_hash,
    grant_row.payload_hash, scheduled_value, scheduled_value
  );

  INSERT INTO geo.idempotency_records (
    tenant_id, scope, idempotency_key, request_hash,
    response_resource_type, response_resource_id, expires_at
  ) VALUES (
    tenant_value, 'publication_request', p_idempotency_key, p_request_hash,
    'publication_job', job_value, statement_timestamp() + interval '30 days'
  );

  INSERT INTO geo.outbox_events (
    tenant_id, id, aggregate_type, aggregate_id, topic, payload,
    request_hash, idempotency_key, available_at
  ) VALUES (
    tenant_value, outbox_value, 'publication_job', job_value,
    'publication.requested',
    jsonb_build_object(
      'tenantId', tenant_value,
      'jobId', job_value,
      'variantId', grant_row.variant_id,
      'channelAccountId', grant_row.channel_account_id,
      'platform', grant_row.platform,
      'executionLevel', p_execution_level,
      'payloadHash', grant_row.payload_hash,
      'scheduledFor', scheduled_value
    ),
    p_request_hash,
    'publication-job:' || job_value::text,
    scheduled_value
  );

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_grant.browser_assisted_consumed',
    'publication_job', job_value,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_idempotency_key),
    p_request_hash,
    jsonb_build_object(
      'grantId', grant_row.id,
      'outboxEventId', outbox_value,
      'platform', grant_row.platform,
      'executionLevel', p_execution_level,
      'scheduledFor', scheduled_value
    )
  );

  RETURN QUERY SELECT job_value, outbox_value, true;
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
     OR p_adapter_version IS NULL
     OR length(trim(p_adapter_version)) NOT BETWEEN 1 AND 100
     OR p_idempotency_key IS NULL
     OR length(p_idempotency_key) NOT BETWEEN 1 AND 200
     OR p_expires_at <= statement_timestamp()
     OR p_expires_at > statement_timestamp() + interval '2 hours' THEN
    RAISE EXCEPTION 'invalid assisted handoff arguments'
      USING ERRCODE = '22023';
  END IF;

  PERFORM geo.require_ctrip_bridge_principal(p_bridge_service_principal_id);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    tenant_value::text || ':assisted-handoff:' || p_job_id::text,
    0
  ));

  SELECT * INTO job
  FROM geo.publication_jobs AS publication_job
  WHERE publication_job.tenant_id = tenant_value
    AND publication_job.id = p_job_id;

  SELECT * INTO existing
  FROM geo.publication_assisted_handoffs AS handoff
  WHERE handoff.tenant_id = tenant_value
    AND handoff.job_id = p_job_id;

  IF existing.id IS NOT NULL THEN
    IF job.id IS NULL
       OR existing.id <> p_handoff_id
       OR existing.attempt_id <> p_attempt_id
       OR existing.bridge_service_principal_id <> p_bridge_service_principal_id
       OR existing.preview_hash <> p_preview_hash
       OR existing.adapter_version <> trim(p_adapter_version)
       OR existing.idempotency_key <> p_idempotency_key
       OR existing.channel_account_id <> job.channel_account_id
       OR existing.variant_id <> job.variant_id
       OR existing.platform <> job.platform
       OR existing.payload_hash <> job.payload_hash THEN
      RAISE EXCEPTION 'assisted handoff idempotency conflict'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT existing.id, false;
    RETURN;
  END IF;

  block_reason := geo.publication_assisted_block_reason(p_job_id);
  IF block_reason IS NOT NULL THEN
    RAISE EXCEPTION 'assisted handoff blocked: %', block_reason
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO job
  FROM geo.publication_jobs AS publication_job
  WHERE publication_job.tenant_id = tenant_value
    AND publication_job.id = p_job_id
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
     OR job.platform NOT IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community')
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
    job.channel_account_id, job.variant_id, job.platform, 'handoff_pending',
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
      'platform', job.platform,
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
  job geo.publication_jobs%ROWTYPE;
  block_reason text;
  lease_expiry timestamptz;
BEGIN
  IF p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'handoff lease must be between 30 and 300 seconds'
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

  SELECT * INTO job
  FROM geo.publication_jobs AS publication_job
  WHERE publication_job.tenant_id = tenant_value
    AND publication_job.id = handoff.job_id;

  IF job.id IS NULL
     OR handoff.channel_account_id <> job.channel_account_id
     OR handoff.variant_id <> job.variant_id
     OR handoff.platform <> job.platform
     OR handoff.payload_hash <> job.payload_hash THEN
    RAISE EXCEPTION 'assisted handoff lineage does not match its publication job'
      USING ERRCODE = '55000';
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
    RAISE EXCEPTION 'assisted handoff claim blocked: %', block_reason
      USING ERRCODE = '42501';
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
    jsonb_build_object(
      'leaseExpiresAt', lease_expiry,
      'platform', handoff.platform
    )
  );

  RETURN true;
END
$$;

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
      p_external_url ~* '^https://([a-z0-9-]+\.)*ctrip\.com(?::443)?/'
    ELSE false
  END
$$;

REVOKE ALL ON FUNCTION geo.browser_publication_identity_allowed(text, text, text)
  FROM PUBLIC;

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
     OR p_observed_at IS NULL
     OR p_observed_at > statement_timestamp() + interval '1 minute'
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

  SELECT * INTO job
  FROM geo.publication_jobs AS publication_job
  WHERE publication_job.tenant_id = tenant_value
    AND publication_job.id = handoff.job_id;

  IF job.id IS NULL
     OR handoff.channel_account_id <> job.channel_account_id
     OR handoff.variant_id <> job.variant_id
     OR handoff.platform <> job.platform
     OR handoff.payload_hash <> job.payload_hash THEN
    RAISE EXCEPTION 'assisted handoff lineage does not match its publication job'
      USING ERRCODE = '55000';
  END IF;

  IF normalized_candidate_id IS NOT NULL AND (
       NOT geo.browser_publication_identity_allowed(
         handoff.platform,
         normalized_candidate_id,
         normalized_candidate_url
       ) OR (
         handoff.platform = 'ctrip_community'
         AND normalized_candidate_url !~*
           '^https://([a-z0-9-]+\.)*ctrip\.com(?::443)?/[^[:space:]?#]*$'
       )
     ) THEN
    RAISE EXCEPTION 'submit candidate URL is not allowed for handoff platform %',
      handoff.platform USING ERRCODE = '22023';
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
    RETURN QUERY
      SELECT handoff.publication_receipt_id, handoff.publication_readback_id;
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
    WHEN 'accepted' THEN
      'Bridge observed submit acknowledgement; independent readback is required'
    WHEN 'uncertain' THEN
      'Bridge crossed the submit boundary but could not classify the outcome'
    ELSE
      'Bridge observed a submit rejection; operator review is required before any new attempt'
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
  SET state = 'uncertain',
      response_hash = p_evidence_hash,
      error_code = attempt_error_code,
      error_message = attempt_error_message,
      finished_at = clock_timestamp()
  WHERE publication_attempt.tenant_id = tenant_value
    AND publication_attempt.id = handoff.attempt_id;

  UPDATE geo.publication_jobs AS publication_job
  SET state = 'uncertain',
      lease_owner = NULL,
      lease_expires_at = NULL,
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
      'schemaVersion', CASE
        WHEN handoff.platform = 'ctrip_community' THEN 'geo.ctrip-browser-receipt.v2'
        ELSE 'geo.browser-publication-receipt.v1'
      END,
      'platform', handoff.platform,
      'outcome', p_outcome,
      'evidenceKind', p_evidence_kind,
      'previewHash', handoff.preview_hash,
      'confirmed', false,
      'simulation', p_evidence_kind = 'simulation',
      'executionLevel', job.execution_level,
      'candidateExternalIdHash', CASE
        WHEN normalized_candidate_id IS NULL THEN NULL
        ELSE encode(public.digest(normalized_candidate_id, 'sha256'), 'hex')
      END,
      'candidateExternalUrlHash', CASE
        WHEN normalized_candidate_url IS NULL THEN NULL
        ELSE encode(public.digest(normalized_candidate_url, 'sha256'), 'hex')
      END,
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
  SET state = 'readback_pending',
      publication_receipt_id = receipt_value,
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
        'outcome', p_outcome,
        'evidenceKind', p_evidence_kind,
        'confirmed', false,
        'receiptId', receipt_value,
        'readbackId', readback_value,
        'platform', handoff.platform,
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
        'required', true,
        'reason', 'browser_publication_unconfirmed',
        'platform', handoff.platform,
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
  IF p_outcome IS NULL
     OR p_outcome NOT IN (
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

  IF job.id IS NULL
     OR handoff.channel_account_id <> job.channel_account_id
     OR handoff.variant_id <> job.variant_id
     OR handoff.platform <> job.platform
     OR handoff.payload_hash <> job.payload_hash
     OR NOT EXISTS (
       SELECT 1
       FROM geo.publication_receipts AS receipt
       WHERE receipt.tenant_id = tenant_value
         AND receipt.id = handoff.publication_receipt_id
         AND receipt.job_id = handoff.job_id
         AND receipt.attempt_id = handoff.attempt_id
         AND receipt.platform = handoff.platform
     ) THEN
    RAISE EXCEPTION 'assisted handoff readback lineage is inconsistent'
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
       handoff.readback_owner_principal_id <> actor_value
       OR handoff.readback_lease_expires_at < statement_timestamp()
     ) THEN
    RAISE EXCEPTION 'unattended readback requires the current bridge lease'
      USING ERRCODE = '55006';
  END IF;
  IF p_observed_at < handoff.submit_observed_at - interval '1 minute' THEN
    RAISE EXCEPTION 'readback predates the submit observation'
      USING ERRCODE = '22023';
  END IF;

  next_attempt_count := handoff.readback_attempt_count + 1;
  IF p_outcome = 'confirmed' THEN
    IF p_evidence_kind <> 'platform_readback'
       OR normalized_external_id IS NULL
       OR length(normalized_external_id) > 500
       OR normalized_external_url IS NULL
       OR length(normalized_external_url) > 2000
       OR NOT geo.browser_publication_identity_allowed(
         handoff.platform,
         normalized_external_id,
         normalized_external_url
       ) THEN
      RAISE EXCEPTION 'confirmed readback identity is not allowed for platform %',
        handoff.platform USING ERRCODE = '23514';
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
      external_id = CASE
        WHEN next_state = 'confirmed' THEN normalized_external_id ELSE NULL
      END,
      external_url = CASE
        WHEN next_state = 'confirmed' THEN normalized_external_url ELSE NULL
      END,
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
        WHEN p_outcome = 'mismatch'
          THEN 'Public readback did not match the audited payload'
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
      confirmed_at = CASE
        WHEN next_state = 'confirmed' THEN clock_timestamp() ELSE NULL
      END,
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
      'reportedOutcome', p_outcome,
      'outcome', recorded_outcome,
      'evidenceKind', p_evidence_kind,
      'confirmed', next_state = 'confirmed',
      'attemptCount', next_attempt_count,
      'attemptLimit', 60,
      'deadlineAt', handoff.readback_deadline_at,
      'exhausted', exhausted,
      'platform', handoff.platform,
      'externalIdHash', CASE
        WHEN normalized_external_id IS NULL THEN NULL
        ELSE encode(public.digest(normalized_external_id, 'sha256'), 'hex')
      END,
      'externalUrlHash', CASE
        WHEN normalized_external_url IS NULL THEN NULL
        ELSE encode(public.digest(normalized_external_url, 'sha256'), 'hex')
      END,
      'executionLevel', job.execution_level
    )
  );

  RETURN QUERY SELECT
    next_state,
    CASE WHEN next_state = 'confirmed' THEN normalized_external_id ELSE NULL END,
    CASE WHEN next_state = 'confirmed' THEN normalized_external_url ELSE NULL END;
END
$$;

REVOKE ALL ON FUNCTION geo.publication_assisted_block_reason(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.consume_browser_assisted_publication_grant(
  uuid, geo.sha256_hex, text, geo.sha256_hex, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.create_publication_assisted_handoff(
  uuid, uuid, uuid, uuid, geo.sha256_hex, text, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.claim_publication_assisted_handoff(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.record_publication_assisted_submit_observation(
  uuid, text, text, geo.sha256_hex, text, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.record_publication_assisted_readback(
  uuid, text, text, geo.sha256_hex, geo.sha256_hex, text, text, timestamptz
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION geo.publication_assisted_block_reason(uuid) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.consume_browser_assisted_publication_grant(
  uuid, geo.sha256_hex, text, geo.sha256_hex, text, timestamptz
) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.create_publication_assisted_handoff(
  uuid, uuid, uuid, uuid, geo.sha256_hex, text, text, timestamptz
) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.claim_publication_assisted_handoff(uuid, integer)
  TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_submit_observation(
  uuid, text, text, geo.sha256_hex, text, text, timestamptz
) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_readback(
  uuid, text, text, geo.sha256_hex, geo.sha256_hex, text, text, timestamptz
) TO geo_runtime;

COMMIT;
