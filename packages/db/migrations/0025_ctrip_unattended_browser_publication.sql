-- Ctrip unattended browser publication is admitted only after a reviewed,
-- platform-readback-backed adapter capability has been recorded for the account.

ALTER TABLE geo.channel_accounts
  DROP CONSTRAINT IF EXISTS channel_accounts_check,
  DROP CONSTRAINT IF EXISTS channel_accounts_manual_execution_scope;

ALTER TABLE geo.channel_accounts
  ADD CONSTRAINT channel_accounts_ctrip_unattended_scope
    CHECK (
      NOT ('unattended' = ANY(supported_execution_levels)) OR (
        platform = 'ctrip_community' AND
        capability = 'browser_assisted' AND
        capability_evidence_type = 'platform_readback'
      )
    );

ALTER TABLE geo.publication_assisted_handoffs
  ADD COLUMN submit_permit_issued_by_principal_id uuid,
  ADD COLUMN readback_owner_principal_id uuid,
  ADD COLUMN readback_lease_expires_at timestamptz,
  ADD CONSTRAINT publication_assisted_handoff_permit_principal_fk
    FOREIGN KEY (tenant_id, submit_permit_issued_by_principal_id)
    REFERENCES geo.service_principals (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT publication_assisted_handoff_readback_principal_fk
    FOREIGN KEY (tenant_id, readback_owner_principal_id)
    REFERENCES geo.service_principals (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT publication_assisted_handoff_readback_lease_complete
    CHECK (
      (readback_owner_principal_id IS NULL AND readback_lease_expires_at IS NULL) OR
      (readback_owner_principal_id IS NOT NULL AND readback_lease_expires_at IS NOT NULL AND
       readback_lease_expires_at <= expires_at)
    ) NOT VALID;

ALTER TABLE geo.publication_assisted_handoffs
  DROP CONSTRAINT IF EXISTS publication_assisted_handoff_permit_actor_consistency;

ALTER TABLE geo.publication_assisted_handoffs
  ADD CONSTRAINT publication_assisted_handoff_permit_issuer_consistency
    CHECK (
      submit_permit_hash IS NULL OR
      (
        (submit_permit_issued_by_actor_id IS NOT NULL AND
         submit_permit_issued_by_principal_id IS NULL) OR
        (submit_permit_issued_by_actor_id IS NULL AND
         submit_permit_issued_by_principal_id IS NOT NULL)
      )
    ) NOT VALID;

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
  unattended_marker text := 'adapter:ctrip-community-browser-unattended-v1';
BEGIN
  PERFORM geo.require_actor_id();

  SELECT * INTO job
  FROM geo.publication_jobs AS publication_job
  WHERE publication_job.tenant_id = tenant_value AND publication_job.id = p_job_id;
  IF job.id IS NULL THEN RETURN 'job_not_found'; END IF;
  IF job.execution_level NOT IN ('assisted', 'unattended') THEN
    RETURN 'job_execution_level_not_ctrip_browser';
  END IF;
  IF job.platform <> 'ctrip_community' THEN RETURN 'job_platform_not_ctrip_community'; END IF;
  IF job.state NOT IN ('dispatching', 'uncertain', 'reconciling') THEN
    RETURN 'job_state:' || job.state;
  END IF;

  SELECT * INTO publication_grant
  FROM geo.publication_grants AS grant_row
  WHERE grant_row.tenant_id = tenant_value AND grant_row.id = job.grant_id;
  IF publication_grant.id IS NULL OR publication_grant.status <> 'consumed'
     OR publication_grant.expires_at <= statement_timestamp() THEN
    RETURN 'authorization_grant_not_current';
  END IF;

  SELECT * INTO artifact
  FROM geo.audit_artifacts AS audit_artifact
  WHERE audit_artifact.tenant_id = tenant_value AND audit_artifact.id = job.audit_artifact_id;
  IF artifact.id IS NULL OR artifact.status <> 'passed'
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
  WHERE publication_variant.tenant_id = tenant_value AND publication_variant.id = job.variant_id;
  IF variant.id IS NULL OR variant.state <> 'frozen'
     OR variant.channel_account_id <> job.channel_account_id
     OR variant.platform <> job.platform OR variant.payload_hash <> job.payload_hash THEN
    RETURN 'authorization_variant_not_current';
  END IF;

  SELECT * INTO account
  FROM geo.channel_accounts AS channel_account
  WHERE channel_account.tenant_id = tenant_value AND channel_account.id = job.channel_account_id;
  IF account.id IS NULL OR account.status <> 'active'
     OR account.platform <> 'ctrip_community'
     OR account.capability <> 'browser_assisted'
     OR NOT (job.execution_level = ANY(account.supported_execution_levels))
     OR account.last_verified_at IS NULL
     OR account.last_verified_at < statement_timestamp() - interval '24 hours' THEN
    RETURN 'account_browser_capability_not_current';
  END IF;
  IF job.execution_level = 'unattended' AND (
       account.capability_evidence_type <> 'platform_readback' OR
       NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(account.capability_evidence_refs) AS ref(value)
         WHERE ref.value = unattended_marker
       )
     ) THEN
    RETURN 'account_unattended_adapter_evidence_not_current';
  END IF;

  SELECT item.* INTO content_item
  FROM geo.publication_variants AS publication_variant
  JOIN geo.content_versions AS version
    ON version.tenant_id = publication_variant.tenant_id AND version.id = publication_variant.content_version_id
  JOIN geo.content_items AS item
    ON item.tenant_id = version.tenant_id AND item.id = version.content_item_id
  WHERE publication_variant.tenant_id = tenant_value AND publication_variant.id = job.variant_id;

  SELECT * INTO control
  FROM geo.automation_controls AS automation_control
  WHERE automation_control.tenant_id = tenant_value
    AND automation_control.scope_type = 'tenant' AND automation_control.scope_key = '*';
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
    WHERE automation_control.tenant_id = tenant_value AND (
      (automation_control.scope_type = 'platform' AND automation_control.scope_key = job.platform) OR
      (automation_control.scope_type = 'account' AND automation_control.scope_key = job.channel_account_id::text) OR
      (automation_control.scope_type = 'campaign' AND content_item.id IS NOT NULL AND automation_control.scope_key = content_item.campaign_id::text) OR
      (automation_control.scope_type = 'topic' AND content_item.id IS NOT NULL AND automation_control.scope_key = content_item.topic_key)
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
      (circuit.scope_type = 'campaign' AND content_item.id IS NOT NULL AND circuit.scope_key = content_item.campaign_id::text) OR
      (circuit.scope_type = 'topic' AND content_item.id IS NOT NULL AND circuit.scope_key = content_item.topic_key)
    )
  LIMIT 1;
  IF breaker.id IS NOT NULL THEN
    RETURN 'circuit_blocked:' || breaker.scope_type || ':' || breaker.scope_key;
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION geo.consume_ctrip_assisted_publication_grant(
  p_grant_id uuid,
  p_token_hash geo.sha256_hex,
  p_idempotency_key text,
  p_request_hash geo.sha256_hex,
  p_execution_level text,
  p_scheduled_for timestamptz
)
RETURNS TABLE (publication_job_id uuid, publication_outbox_event_id uuid, was_created boolean)
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
  unattended_marker text := 'adapter:ctrip-community-browser-unattended-v1';
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'idempotency key must contain 1 to 200 characters' USING ERRCODE = '22023';
  END IF;
  IF p_execution_level NOT IN ('assisted', 'unattended') THEN
    RAISE EXCEPTION 'Ctrip browser admission requires assisted or unattended execution' USING ERRCODE = '0A000';
  END IF;
  IF scheduled_value < statement_timestamp() - interval '1 second' THEN
    RAISE EXCEPTION 'scheduled publication time cannot be in the past' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(tenant_value::text || ':' || p_idempotency_key, 0));

  SELECT job.id, event.id INTO job_value, outbox_value
  FROM geo.publication_jobs AS job
  JOIN geo.outbox_events AS event
    ON event.tenant_id = job.tenant_id AND event.aggregate_id = job.id AND event.topic = 'publication.requested'
  WHERE job.tenant_id = tenant_value AND job.idempotency_key = p_idempotency_key;
  IF job_value IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM geo.publication_jobs AS job
      WHERE job.tenant_id = tenant_value AND job.id = job_value
        AND job.grant_id = p_grant_id AND job.request_hash = p_request_hash
        AND job.platform = 'ctrip_community' AND job.execution_level = p_execution_level
    ) THEN
      RAISE EXCEPTION 'idempotency key conflicts with another publication request' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT job_value, outbox_value, false;
    RETURN;
  END IF;

  SELECT * INTO grant_row FROM geo.publication_grants AS publication_grant
  WHERE publication_grant.tenant_id = tenant_value AND publication_grant.id = p_grant_id FOR UPDATE;
  IF grant_row.id IS NULL OR grant_row.status <> 'issued'
     OR grant_row.expires_at <= statement_timestamp() OR grant_row.token_hash <> p_token_hash THEN
    RAISE EXCEPTION 'publication grant is invalid, expired, consumed, revoked, or mismatched' USING ERRCODE = '42501';
  END IF;
  IF grant_row.platform <> 'ctrip_community' THEN
    RAISE EXCEPTION 'Ctrip browser admission requires a Ctrip Community grant' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO artifact_row FROM geo.audit_artifacts AS artifact
  WHERE artifact.tenant_id = tenant_value AND artifact.id = grant_row.audit_artifact_id;
  SELECT * INTO variant_row FROM geo.publication_variants AS variant
  WHERE variant.tenant_id = tenant_value AND variant.id = grant_row.variant_id;
  SELECT item.* INTO content_item_row
  FROM geo.content_versions AS version
  JOIN geo.content_items AS item ON item.tenant_id = version.tenant_id AND item.id = version.content_item_id
  WHERE version.tenant_id = tenant_value AND version.id = variant_row.content_version_id;
  SELECT * INTO account_row FROM geo.channel_accounts AS account
  WHERE account.tenant_id = tenant_value AND account.id = grant_row.channel_account_id;

  IF artifact_row.id IS NULL OR artifact_row.status <> 'passed'
     OR artifact_row.expires_at <= statement_timestamp()
     OR artifact_row.variant_id <> grant_row.variant_id
     OR artifact_row.channel_account_id <> grant_row.channel_account_id
     OR artifact_row.platform <> grant_row.platform
     OR artifact_row.payload_hash <> grant_row.payload_hash
     OR artifact_row.audit_hash <> grant_row.audit_hash THEN
    RAISE EXCEPTION 'publication audit is no longer valid' USING ERRCODE = '42501';
  END IF;
  IF variant_row.id IS NULL OR variant_row.state <> 'frozen'
     OR variant_row.channel_account_id <> grant_row.channel_account_id
     OR variant_row.platform <> grant_row.platform OR variant_row.payload_hash <> grant_row.payload_hash
     OR content_item_row.id IS NULL THEN
    RAISE EXCEPTION 'publication variant is no longer valid' USING ERRCODE = '42501';
  END IF;
  IF scheduled_value >= grant_row.expires_at OR scheduled_value >= artifact_row.expires_at THEN
    RAISE EXCEPTION 'scheduled publication must start before its grant and audit expire' USING ERRCODE = '22023';
  END IF;
  IF account_row.id IS NULL OR account_row.status <> 'active'
     OR account_row.platform <> 'ctrip_community' OR account_row.capability <> 'browser_assisted'
     OR NOT (p_execution_level = ANY(account_row.supported_execution_levels))
     OR account_row.last_verified_at IS NULL
     OR account_row.last_verified_at < statement_timestamp() - interval '24 hours' THEN
    RAISE EXCEPTION 'Ctrip browser-assisted capability is not current' USING ERRCODE = '42501';
  END IF;
  IF p_execution_level = 'unattended' AND (
       account_row.capability_evidence_type <> 'platform_readback' OR
       NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(account_row.capability_evidence_refs) AS ref(value)
         WHERE ref.value = unattended_marker
       )
     ) THEN
    RAISE EXCEPTION 'Ctrip unattended adapter evidence is not current' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO control_row FROM geo.automation_controls AS control
  WHERE control.tenant_id = tenant_value AND control.scope_type = 'tenant' AND control.scope_key = '*';
  IF control_row.id IS NULL OR control_row.kill_switch_enabled OR
     (p_execution_level = 'unattended' AND control_row.mode <> 'unattended') OR
     (p_execution_level = 'assisted' AND control_row.mode IN ('shadow', 'paused', 'stopped')) THEN
    RAISE EXCEPTION 'tenant automation control blocks Ctrip browser handoff' USING ERRCODE = '42501';
  END IF;
  FOR scoped_control IN
    SELECT control.* FROM geo.automation_controls AS control
    WHERE control.tenant_id = tenant_value AND (
      (control.scope_type = 'platform' AND control.scope_key = grant_row.platform) OR
      (control.scope_type = 'account' AND control.scope_key = grant_row.channel_account_id::text) OR
      (control.scope_type = 'campaign' AND control.scope_key = content_item_row.campaign_id::text) OR
      (control.scope_type = 'topic' AND control.scope_key = content_item_row.topic_key)
    )
  LOOP
    IF scoped_control.kill_switch_enabled OR
       (p_execution_level = 'unattended' AND scoped_control.mode <> 'unattended') OR
       (p_execution_level = 'assisted' AND scoped_control.mode IN ('shadow', 'paused', 'stopped')) THEN
      RAISE EXCEPTION 'scoped automation control blocks Ctrip browser handoff' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM geo.circuit_breakers AS breaker
    WHERE breaker.tenant_id = tenant_value AND breaker.state IN ('open', 'half_open') AND (
      (breaker.scope_type = 'tenant' AND breaker.scope_key = '*') OR
      (breaker.scope_type = 'platform' AND breaker.scope_key = grant_row.platform) OR
      (breaker.scope_type = 'account' AND breaker.scope_key = grant_row.channel_account_id::text) OR
      (breaker.scope_type = 'campaign' AND breaker.scope_key = content_item_row.campaign_id::text) OR
      (breaker.scope_type = 'topic' AND breaker.scope_key = content_item_row.topic_key)
    )
  ) THEN
    RAISE EXCEPTION 'a circuit breaker blocks Ctrip browser handoff' USING ERRCODE = '42501';
  END IF;

  job_value := gen_random_uuid();
  outbox_value := gen_random_uuid();
  UPDATE geo.publication_grants AS publication_grant
  SET status = 'consumed', consumed_at = clock_timestamp(), consumed_by_actor_id = actor_value
  WHERE publication_grant.tenant_id = tenant_value AND publication_grant.id = grant_row.id AND publication_grant.status = 'issued';
  IF NOT FOUND THEN RAISE EXCEPTION 'publication grant was concurrently consumed' USING ERRCODE = '40001'; END IF;

  INSERT INTO geo.publication_jobs (
    tenant_id, id, grant_id, audit_artifact_id, variant_id, channel_account_id,
    platform, execution_level, state, idempotency_key, request_hash, payload_hash,
    available_at, scheduled_for
  ) VALUES (
    tenant_value, job_value, grant_row.id, grant_row.audit_artifact_id, grant_row.variant_id,
    grant_row.channel_account_id, 'ctrip_community', p_execution_level, 'queued', p_idempotency_key,
    p_request_hash, grant_row.payload_hash, scheduled_value, scheduled_value
  );
  INSERT INTO geo.idempotency_records (
    tenant_id, scope, idempotency_key, request_hash, response_resource_type, response_resource_id, expires_at
  ) VALUES (
    tenant_value, 'publication_request', p_idempotency_key, p_request_hash, 'publication_job', job_value,
    statement_timestamp() + interval '30 days'
  );
  INSERT INTO geo.outbox_events (
    tenant_id, id, aggregate_type, aggregate_id, topic, payload, request_hash, idempotency_key, available_at
  ) VALUES (
    tenant_value, outbox_value, 'publication_job', job_value, 'publication.requested',
    jsonb_build_object(
      'tenantId', tenant_value, 'jobId', job_value, 'variantId', grant_row.variant_id,
      'channelAccountId', grant_row.channel_account_id, 'platform', 'ctrip_community',
      'executionLevel', p_execution_level, 'payloadHash', grant_row.payload_hash, 'scheduledFor', scheduled_value
    ), p_request_hash, 'publication-job:' || job_value::text, scheduled_value
  );
  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id, request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_grant.ctrip_browser_consumed', 'publication_job', job_value,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_idempotency_key), p_request_hash,
    jsonb_build_object('grantId', grant_row.id, 'outboxEventId', outbox_value, 'platform', 'ctrip_community',
      'executionLevel', p_execution_level, 'scheduledFor', scheduled_value)
  );
  RETURN QUERY SELECT job_value, outbox_value, true;
END
$$;

CREATE OR REPLACE FUNCTION geo.issue_publication_assisted_submit_permit(p_handoff_id uuid)
RETURNS TABLE (submit_permit text, submit_permit_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_publication_operator();
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  job geo.publication_jobs%ROWTYPE;
  block_reason text;
  permit_value text;
  permit_hash geo.sha256_hex;
  permit_expiry timestamptz;
BEGIN
  SELECT * INTO handoff FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id FOR UPDATE;
  IF handoff.id IS NULL THEN RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO job FROM geo.publication_jobs AS publication_job
  WHERE publication_job.tenant_id = tenant_value AND publication_job.id = handoff.job_id;
  IF job.execution_level <> 'assisted' OR handoff.bridge_service_principal_id IS NULL OR handoff.external_draft_id IS NULL
     OR handoff.state <> 'draft_prepared' THEN
    RAISE EXCEPTION 'assisted submit permit requires a prepared assisted draft' USING ERRCODE = '55000';
  END IF;
  IF handoff.lease_owner_actor_id <> actor_value OR handoff.lease_expires_at < statement_timestamp() THEN
    RAISE EXCEPTION 'submit permit requires the current operator lease' USING ERRCODE = '55006';
  END IF;
  IF handoff.expires_at <= statement_timestamp() THEN RAISE EXCEPTION 'assisted handoff has expired' USING ERRCODE = '55000'; END IF;
  PERFORM geo.require_ctrip_bridge_principal(handoff.bridge_service_principal_id);
  block_reason := geo.publication_assisted_block_reason(handoff.job_id);
  IF block_reason IS NOT NULL THEN RAISE EXCEPTION 'submit permit blocked: %', block_reason USING ERRCODE = '42501'; END IF;

  permit_value := encode(public.gen_random_bytes(32), 'hex');
  permit_hash := encode(public.digest(permit_value, 'sha256'), 'hex');
  permit_expiry := LEAST(handoff.expires_at, handoff.lease_expires_at, statement_timestamp() + interval '5 minutes');
  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = 'awaiting_operator_submit', submit_permit_hash = permit_hash,
      submit_permit_expires_at = permit_expiry, submit_permit_consumed_at = NULL,
      submit_permit_issued_by_actor_id = actor_value, submit_permit_issued_by_principal_id = NULL,
      submit_permit_consumed_by_principal_id = NULL
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id;
  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id, request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.submit_permit_issued',
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text), permit_hash,
    jsonb_build_object('expiresAt', permit_expiry, 'bridgePrincipalId', handoff.bridge_service_principal_id,
      'executionLevel', 'assisted')
  );
  RETURN QUERY SELECT permit_value, permit_expiry;
END
$$;

CREATE OR REPLACE FUNCTION geo.claim_next_ctrip_unattended_submit()
RETURNS TABLE (handoff_id uuid, submit_permit text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  permit_value text;
  permit_hash geo.sha256_hex;
  permit_expiry timestamptz;
BEGIN
  PERFORM geo.require_ctrip_bridge_principal(actor_value);
  SELECT candidate.* INTO handoff
  FROM geo.publication_assisted_handoffs AS candidate
  JOIN geo.publication_jobs AS job ON job.tenant_id = candidate.tenant_id AND job.id = candidate.job_id
  WHERE candidate.tenant_id = tenant_value AND candidate.bridge_service_principal_id = actor_value
    AND job.execution_level = 'unattended' AND candidate.state = 'draft_prepared'
    AND candidate.external_draft_id IS NOT NULL AND candidate.expires_at > statement_timestamp()
    AND (candidate.submit_permit_hash IS NULL OR candidate.submit_permit_expires_at < statement_timestamp())
    AND geo.publication_assisted_block_reason(candidate.job_id) IS NULL
  ORDER BY candidate.created_at, candidate.id
  FOR UPDATE OF candidate SKIP LOCKED LIMIT 1;
  IF handoff.id IS NULL THEN RETURN; END IF;

  permit_value := encode(public.gen_random_bytes(32), 'hex');
  permit_hash := encode(public.digest(permit_value, 'sha256'), 'hex');
  permit_expiry := LEAST(handoff.expires_at, statement_timestamp() + interval '5 minutes');
  UPDATE geo.publication_assisted_handoffs AS claimed
  SET state = 'awaiting_operator_submit', submit_permit_hash = permit_hash,
      submit_permit_expires_at = permit_expiry, submit_permit_consumed_at = NULL,
      submit_permit_issued_by_actor_id = NULL, submit_permit_issued_by_principal_id = actor_value,
      submit_permit_consumed_by_principal_id = NULL
  WHERE claimed.tenant_id = tenant_value AND claimed.id = handoff.id;
  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id, request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.submit_permit_issued',
    'publication_assisted_handoff', handoff.id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), handoff.id::text), permit_hash,
    jsonb_build_object('expiresAt', permit_expiry, 'bridgePrincipalId', actor_value, 'executionLevel', 'unattended',
      'operatorApprovalRequired', false)
  );
  RETURN QUERY SELECT handoff.id, permit_value;
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
  job geo.publication_jobs%ROWTYPE;
  permit_hash geo.sha256_hex;
  block_reason text;
BEGIN
  IF p_submit_permit IS NULL OR p_submit_permit !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid submit permit' USING ERRCODE = '22023';
  END IF;
  permit_hash := encode(public.digest(p_submit_permit, 'sha256'), 'hex');
  SELECT * INTO handoff FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id FOR UPDATE;
  IF handoff.id IS NULL THEN RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO job FROM geo.publication_jobs AS publication_job
  WHERE publication_job.tenant_id = tenant_value AND publication_job.id = handoff.job_id;
  IF job.execution_level = 'unattended' THEN
    IF handoff.bridge_service_principal_id <> actor_value
       OR handoff.submit_permit_issued_by_principal_id <> actor_value
       OR handoff.lease_owner_actor_id IS NOT NULL THEN
      RAISE EXCEPTION 'unattended submit permit requires the bound bridge principal' USING ERRCODE = '55006';
    END IF;
  ELSE
    IF handoff.lease_owner_actor_id IS NULL OR handoff.lease_expires_at < statement_timestamp()
       OR handoff.submit_permit_issued_by_actor_id <> handoff.lease_owner_actor_id THEN
      RAISE EXCEPTION 'submit permit requires its current issuing operator lease' USING ERRCODE = '55006';
    END IF;
  END IF;
  IF handoff.state <> 'awaiting_operator_submit' OR handoff.submit_permit_hash <> permit_hash
     OR handoff.submit_permit_expires_at <= statement_timestamp()
     OR handoff.submit_permit_consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'submit permit is invalid, expired, or already consumed' USING ERRCODE = '42501';
  END IF;
  block_reason := geo.publication_assisted_block_reason(handoff.job_id);
  IF block_reason IS NOT NULL THEN RAISE EXCEPTION 'submit permit blocked: %', block_reason USING ERRCODE = '42501'; END IF;
  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET submit_permit_consumed_at = statement_timestamp(), submit_permit_consumed_by_principal_id = actor_value
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id
    AND assisted_handoff.submit_permit_consumed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'submit permit was concurrently consumed' USING ERRCODE = '40001'; END IF;
  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id, request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.submit_permit_consumed',
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text), permit_hash,
    jsonb_build_object('confirmed', false, 'externalWriteObserved', false, 'executionLevel', job.execution_level)
  );
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION geo.claim_next_ctrip_unattended_readback()
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
BEGIN
  PERFORM geo.require_ctrip_bridge_principal(actor_value);
  SELECT candidate.* INTO handoff
  FROM geo.publication_assisted_handoffs AS candidate
  JOIN geo.publication_jobs AS job ON job.tenant_id = candidate.tenant_id AND job.id = candidate.job_id
  WHERE candidate.tenant_id = tenant_value AND candidate.bridge_service_principal_id = actor_value
    AND job.execution_level = 'unattended'
    AND candidate.state IN ('readback_pending', 'awaiting_operator_submit')
    AND (candidate.state = 'readback_pending' OR candidate.submit_permit_consumed_at IS NOT NULL)
    AND candidate.expires_at > statement_timestamp()
    AND (candidate.readback_owner_principal_id IS NULL OR candidate.readback_lease_expires_at < statement_timestamp())
    AND geo.publication_assisted_block_reason(candidate.job_id) IS NULL
  ORDER BY candidate.created_at, candidate.id
  FOR UPDATE OF candidate SKIP LOCKED LIMIT 1;
  IF handoff.id IS NULL THEN RETURN NULL; END IF;
  lease_expiry := LEAST(handoff.expires_at, statement_timestamp() + interval '5 minutes');
  UPDATE geo.publication_assisted_handoffs AS claimed
  SET readback_owner_principal_id = actor_value, readback_lease_expires_at = lease_expiry
  WHERE claimed.tenant_id = tenant_value AND claimed.id = handoff.id;
  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id, request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.readback_claimed',
    'publication_assisted_handoff', handoff.id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), handoff.id::text), handoff.preview_hash,
    jsonb_build_object('leaseExpiresAt', lease_expiry, 'executionLevel', 'unattended')
  );
  RETURN handoff.id;
END
$$;

-- The 0023 function body is intentionally redefined here so receipts/readbacks
-- carry the durable job execution level instead of assuming assisted execution.
REVOKE ALL ON FUNCTION geo.record_publication_assisted_submit_observation(
  uuid, text, text, geo.sha256_hex, text, text, timestamptz
) FROM PUBLIC, geo_runtime;
DROP FUNCTION geo.record_publication_assisted_submit_observation(
  uuid, text, text, geo.sha256_hex, text, text, timestamptz
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
     OR (normalized_candidate_id IS NOT NULL AND (length(normalized_candidate_id) > 500
       OR length(normalized_candidate_url) > 2000
       OR normalized_candidate_url !~* '^https://([a-z0-9-]+\.)*ctrip\.com(?::443)?/[^[:space:]?#]*$'))
     OR (p_evidence_kind = 'simulation' AND normalized_candidate_id IS NOT NULL)
     OR (p_outcome = 'rejected' AND normalized_candidate_id IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid assisted submit observation' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO handoff FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id FOR UPDATE;
  IF handoff.id IS NULL THEN RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002'; END IF;
  IF handoff.submit_outcome IS NOT NULL THEN
    IF handoff.submit_outcome <> p_outcome OR handoff.submit_evidence_kind <> p_evidence_kind
       OR handoff.submit_evidence_hash <> p_evidence_hash
       OR handoff.submit_candidate_external_id IS DISTINCT FROM normalized_candidate_id
       OR handoff.submit_candidate_external_url IS DISTINCT FROM normalized_candidate_url
       OR handoff.submit_observed_at <> p_observed_at OR handoff.publication_receipt_id IS NULL
       OR handoff.publication_readback_id IS NULL THEN
      RAISE EXCEPTION 'assisted submit observation conflicts with durable evidence' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT handoff.publication_receipt_id, handoff.publication_readback_id;
    RETURN;
  END IF;
  IF handoff.state <> 'awaiting_operator_submit' OR handoff.submit_permit_consumed_at IS NULL
     OR handoff.submit_permit_consumed_by_principal_id <> actor_value
     OR handoff.submit_evidence_hash IS NOT NULL THEN
    RAISE EXCEPTION 'submit observation requires one consumed bound permit' USING ERRCODE = '55000';
  END IF;
  IF p_observed_at < handoff.submit_permit_consumed_at - interval '1 minute' THEN
    RAISE EXCEPTION 'submit observation predates permit consumption' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO attempt FROM geo.publication_attempts AS publication_attempt
  WHERE publication_attempt.tenant_id = tenant_value AND publication_attempt.id = handoff.attempt_id
    AND publication_attempt.job_id = handoff.job_id FOR UPDATE;
  SELECT * INTO job FROM geo.publication_jobs AS publication_job
  WHERE publication_job.tenant_id = tenant_value AND publication_job.id = handoff.job_id;
  IF attempt.id IS NULL OR attempt.state <> 'started' THEN
    RAISE EXCEPTION 'submit observation requires the active publication attempt' USING ERRCODE = '55000';
  END IF;
  receipt_value := gen_random_uuid();
  readback_value := gen_random_uuid();
  attempt_error_code := CASE p_outcome WHEN 'accepted' THEN 'ASSISTED_READBACK_REQUIRED'
    WHEN 'uncertain' THEN 'ASSISTED_SUBMIT_UNCERTAIN' ELSE 'ASSISTED_SUBMIT_REJECTED' END;
  attempt_error_message := CASE p_outcome
    WHEN 'accepted' THEN 'Bridge observed submit acknowledgement; independent readback is required'
    WHEN 'uncertain' THEN 'Bridge crossed the submit boundary but could not classify the outcome'
    ELSE 'Bridge observed a submit rejection; operator review is required before any new attempt' END;
  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = 'submitted_unconfirmed', submit_evidence_hash = p_evidence_hash,
      submit_outcome = p_outcome, submit_evidence_kind = p_evidence_kind, submit_observed_at = p_observed_at,
      submit_candidate_external_id = normalized_candidate_id, submit_candidate_external_url = normalized_candidate_url,
      last_error_code = attempt_error_code, last_error_message = attempt_error_message
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id;
  UPDATE geo.publication_attempts AS publication_attempt
  SET state = 'uncertain', response_hash = p_evidence_hash, error_code = attempt_error_code,
      error_message = attempt_error_message, finished_at = clock_timestamp()
  WHERE publication_attempt.tenant_id = tenant_value AND publication_attempt.id = handoff.attempt_id;
  UPDATE geo.publication_jobs AS publication_job
  SET state = 'uncertain', lease_owner = NULL, lease_expires_at = NULL, last_error_code = attempt_error_code
  WHERE publication_job.tenant_id = tenant_value AND publication_job.id = handoff.job_id;
  INSERT INTO geo.publication_receipts (
    tenant_id, id, job_id, attempt_id, platform, execution_level, evidence_type,
    request_hash, response_hash, external_id, external_url, published_at, recorded_at, confirmed, payload
  ) VALUES (
    tenant_value, receipt_value, handoff.job_id, handoff.attempt_id, 'ctrip_community', job.execution_level,
    CASE p_evidence_kind WHEN 'simulation' THEN 'fixture' ELSE 'browser_screenshot' END,
    attempt.request_hash, p_evidence_hash, NULL, NULL, NULL, clock_timestamp(), false,
    jsonb_build_object('schemaVersion', 'geo.ctrip-browser-receipt.v2', 'outcome', p_outcome,
      'evidenceKind', p_evidence_kind, 'previewHash', handoff.preview_hash, 'confirmed', false,
      'simulation', p_evidence_kind = 'simulation', 'executionLevel', job.execution_level,
      'candidateExternalIdHash', CASE WHEN normalized_candidate_id IS NULL THEN NULL ELSE encode(public.digest(normalized_candidate_id, 'sha256'), 'hex') END,
      'candidateExternalUrlHash', CASE WHEN normalized_candidate_url IS NULL THEN NULL ELSE encode(public.digest(normalized_candidate_url, 'sha256'), 'hex') END,
      'readback', jsonb_build_object('required', true, 'status', 'pending', 'reason', 'browser_publication_unconfirmed'))
  );
  INSERT INTO geo.publication_readbacks (
    tenant_id, id, job_id, receipt_id, execution_level, status, required, reason, scheduled_for, completed_at, last_error
  ) VALUES (
    tenant_value, readback_value, handoff.job_id, receipt_value, job.execution_level, 'pending', true,
    'browser_publication_unconfirmed', clock_timestamp(), NULL, NULL
  );
  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = 'readback_pending', publication_receipt_id = receipt_value, publication_readback_id = readback_value
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id;
  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id, request_id, after_hash, details
  ) VALUES
    (tenant_value, actor_value, 'publication_assisted_handoff.submit_observed', 'publication_assisted_handoff', p_handoff_id,
      COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text), p_evidence_hash,
      jsonb_build_object('outcome', p_outcome, 'evidenceKind', p_evidence_kind, 'confirmed', false,
        'receiptId', receipt_value, 'readbackId', readback_value, 'executionLevel', job.execution_level)),
    (tenant_value, actor_value, 'publication_readback.required', 'publication_readback', readback_value,
      COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text), p_evidence_hash,
      jsonb_build_object('jobId', handoff.job_id, 'receiptId', receipt_value, 'required', true,
        'reason', 'browser_publication_unconfirmed', 'executionLevel', job.execution_level));
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
  IF handoff.state <> 'readback_pending' OR handoff.publication_receipt_id IS NULL OR handoff.publication_readback_id IS NULL THEN
    RAISE EXCEPTION 'readback requires a pending browser publication observation' USING ERRCODE = '55000';
  END IF;
  IF job.execution_level = 'unattended' AND (
       handoff.readback_owner_principal_id <> actor_value OR handoff.readback_lease_expires_at < statement_timestamp()
     ) THEN
    RAISE EXCEPTION 'unattended readback requires the current bridge lease' USING ERRCODE = '55006';
  END IF;
  IF p_observed_at < handoff.submit_observed_at - interval '1 minute' THEN
    RAISE EXCEPTION 'readback predates the submit observation' USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'confirmed' THEN
    IF p_evidence_kind <> 'platform_readback' OR p_observed_payload_hash IS DISTINCT FROM handoff.payload_hash
       OR normalized_external_id IS NULL OR length(normalized_external_id) > 500
       OR normalized_external_url IS NULL OR length(normalized_external_url) > 2000
       OR normalized_external_url !~* '^https://([a-z0-9-]+\.)*ctrip\.com(?::443)?/' THEN
      RAISE EXCEPTION 'confirmed readback requires matching public Ctrip evidence' USING ERRCODE = '23514';
    END IF;
    next_state := 'confirmed'; readback_status := 'succeeded'; readback_error := NULL;
  ELSIF p_outcome = 'unavailable' THEN
    IF normalized_external_id IS NOT NULL OR normalized_external_url IS NOT NULL THEN
      RAISE EXCEPTION 'unavailable readback cannot claim external identity' USING ERRCODE = '23514';
    END IF;
    next_state := 'readback_pending'; readback_status := 'pending'; readback_error := 'ASSISTED_READBACK_UNAVAILABLE';
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
    readback_error := CASE p_outcome WHEN 'simulation_only' THEN 'SIMULATION_ONLY'
      WHEN 'mismatch' THEN 'ASSISTED_READBACK_MISMATCH' ELSE 'ASSISTED_READBACK_NOT_FOUND' END;
  END IF;
  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = next_state, readback_outcome = p_outcome, readback_evidence_kind = p_evidence_kind,
      readback_evidence_hash = p_evidence_hash, readback_observed_at = p_observed_at,
      observed_payload_hash = p_observed_payload_hash,
      external_id = CASE WHEN next_state = 'confirmed' THEN normalized_external_id ELSE NULL END,
      external_url = CASE WHEN next_state = 'confirmed' THEN normalized_external_url ELSE NULL END,
      readback_owner_principal_id = NULL, readback_lease_expires_at = NULL,
      last_error_code = readback_error,
      last_error_message = CASE WHEN next_state = 'confirmed' THEN NULL
        WHEN p_outcome = 'simulation_only' THEN 'Simulator evidence cannot confirm a live publication'
        WHEN p_outcome = 'unavailable' THEN 'Public readback is temporarily unavailable'
        WHEN p_outcome = 'mismatch' THEN 'Public readback did not match the audited payload'
        ELSE 'Public publication was not found within the readback window' END
  WHERE assisted_handoff.tenant_id = tenant_value AND assisted_handoff.id = p_handoff_id;
  UPDATE geo.publication_readbacks AS readback
  SET status = readback_status, completed_at = CASE WHEN readback_status IN ('succeeded', 'failed') THEN clock_timestamp() ELSE NULL END,
      last_error = readback_error
  WHERE readback.tenant_id = tenant_value AND readback.id = handoff.publication_readback_id;
  UPDATE geo.publication_jobs AS publication_job
  SET state = CASE WHEN next_state = 'confirmed' THEN 'confirmed' WHEN next_state = 'needs_review' THEN 'needs_review' ELSE 'uncertain' END,
      confirmed_at = CASE WHEN next_state = 'confirmed' THEN clock_timestamp() ELSE NULL END, last_error_code = readback_error
  WHERE publication_job.tenant_id = tenant_value AND publication_job.id = handoff.job_id;
  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id, request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value,
    CASE next_state WHEN 'confirmed' THEN 'publication_assisted_handoff.confirmed'
      WHEN 'needs_review' THEN 'publication_assisted_handoff.needs_review' ELSE 'publication_assisted_handoff.readback_pending' END,
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text), p_evidence_hash,
    jsonb_build_object('outcome', p_outcome, 'evidenceKind', p_evidence_kind, 'confirmed', next_state = 'confirmed',
      'externalIdHash', CASE WHEN normalized_external_id IS NULL THEN NULL ELSE encode(public.digest(normalized_external_id, 'sha256'), 'hex') END,
      'externalUrlHash', CASE WHEN normalized_external_url IS NULL THEN NULL ELSE encode(public.digest(normalized_external_url, 'sha256'), 'hex') END,
      'executionLevel', job.execution_level)
  );
  RETURN QUERY SELECT next_state,
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
        'media_manifest_hash', 'submit_evidence_hash', 'submit_permit_hash',
        'submit_permit_expires_at', 'submit_permit_consumed_at',
        'submit_permit_issued_by_actor_id', 'submit_permit_issued_by_principal_id',
        'submit_permit_consumed_by_principal_id', 'submit_outcome', 'submit_evidence_kind',
        'submit_observed_at', 'submit_candidate_external_id', 'submit_candidate_external_url',
        'publication_receipt_id', 'publication_readback_id', 'readback_outcome',
        'readback_evidence_kind', 'readback_evidence_hash', 'readback_observed_at',
        'observed_payload_hash', 'external_draft_id', 'external_id', 'external_url',
        'cancelled_at', 'cancelled_by_actor_id', 'cancellation_reason', 'last_error_code',
        'last_error_message', 'updated_at'
      ]) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY[
        'state', 'lease_owner_actor_id', 'lease_expires_at', 'heartbeat_at',
        'draft_prepare_owner_principal_id', 'draft_prepare_lease_expires_at',
        'readback_owner_principal_id', 'readback_lease_expires_at',
        'session_evidence_hash', 'draft_evidence_hash', 'prepare_outcome',
        'prepare_evidence_kind', 'prepare_evidence_hash', 'prepare_observed_at',
        'media_manifest_hash', 'submit_evidence_hash', 'submit_permit_hash',
        'submit_permit_expires_at', 'submit_permit_consumed_at',
        'submit_permit_issued_by_actor_id', 'submit_permit_issued_by_principal_id',
        'submit_permit_consumed_by_principal_id', 'submit_outcome', 'submit_evidence_kind',
        'submit_observed_at', 'submit_candidate_external_id', 'submit_candidate_external_url',
        'publication_receipt_id', 'publication_readback_id', 'readback_outcome',
        'readback_evidence_kind', 'readback_evidence_hash', 'readback_observed_at',
        'observed_payload_hash', 'external_draft_id', 'external_id', 'external_url',
        'cancelled_at', 'cancelled_by_actor_id', 'cancellation_reason', 'last_error_code',
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

ALTER TABLE geo.publication_assisted_handoffs
  VALIDATE CONSTRAINT publication_assisted_handoff_readback_lease_complete,
  VALIDATE CONSTRAINT publication_assisted_handoff_permit_issuer_consistency;

REVOKE ALL ON FUNCTION geo.claim_next_ctrip_unattended_submit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.claim_next_ctrip_unattended_submit() TO geo_runtime;
REVOKE ALL ON FUNCTION geo.claim_next_ctrip_unattended_readback() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.claim_next_ctrip_unattended_readback() TO geo_runtime;
REVOKE ALL ON FUNCTION geo.record_publication_assisted_submit_observation(
  uuid, text, text, geo.sha256_hex, text, text, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_submit_observation(
  uuid, text, text, geo.sha256_hex, text, text, timestamptz
) TO geo_runtime;
REVOKE ALL ON FUNCTION geo.record_publication_assisted_readback(
  uuid, text, text, geo.sha256_hex, geo.sha256_hex, text, text, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_readback(
  uuid, text, text, geo.sha256_hex, geo.sha256_hex, text, text, timestamptz
) TO geo_runtime;
