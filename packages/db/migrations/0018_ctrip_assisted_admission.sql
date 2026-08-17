CREATE OR REPLACE FUNCTION geo.consume_ctrip_assisted_publication_grant(
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
    RAISE EXCEPTION 'idempotency key must contain 1 to 200 characters' USING ERRCODE = '22023';
  END IF;
  IF p_execution_level <> 'assisted' THEN
    RAISE EXCEPTION 'Ctrip assisted admission requires an explicit assisted execution level'
      USING ERRCODE = '0A000';
  END IF;
  IF scheduled_value < statement_timestamp() - interval '1 second' THEN
    RAISE EXCEPTION 'scheduled publication time cannot be in the past' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(tenant_value::text || ':' || p_idempotency_key, 0));

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
      WHERE job.tenant_id = tenant_value
        AND job.id = job_value
        AND job.grant_id = p_grant_id
        AND job.request_hash = p_request_hash
        AND job.platform = 'ctrip_community'
        AND job.execution_level = 'assisted'
    ) THEN
      RAISE EXCEPTION 'idempotency key conflicts with another publication request'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT job_value, outbox_value, false;
    RETURN;
  END IF;

  SELECT * INTO grant_row
  FROM geo.publication_grants AS publication_grant
  WHERE publication_grant.tenant_id = tenant_value AND publication_grant.id = p_grant_id
  FOR UPDATE;

  IF grant_row.id IS NULL
     OR grant_row.status <> 'issued'
     OR grant_row.expires_at <= statement_timestamp()
     OR grant_row.token_hash <> p_token_hash THEN
    RAISE EXCEPTION 'publication grant is invalid, expired, consumed, revoked, or mismatched'
      USING ERRCODE = '42501';
  END IF;
  IF grant_row.platform <> 'ctrip_community' THEN
    RAISE EXCEPTION 'Ctrip assisted admission requires a Ctrip Community grant'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO artifact_row
  FROM geo.audit_artifacts AS artifact
  WHERE artifact.tenant_id = tenant_value AND artifact.id = grant_row.audit_artifact_id;

  SELECT * INTO variant_row
  FROM geo.publication_variants AS variant
  WHERE variant.tenant_id = tenant_value AND variant.id = grant_row.variant_id;

  SELECT item.* INTO content_item_row
  FROM geo.content_versions AS version
  JOIN geo.content_items AS item
    ON item.tenant_id = version.tenant_id AND item.id = version.content_item_id
  WHERE version.tenant_id = tenant_value AND version.id = variant_row.content_version_id;

  SELECT * INTO account_row
  FROM geo.channel_accounts AS account
  WHERE account.tenant_id = tenant_value AND account.id = grant_row.channel_account_id;

  IF artifact_row.id IS NULL
     OR artifact_row.status <> 'passed'
     OR artifact_row.expires_at <= statement_timestamp()
     OR artifact_row.variant_id <> grant_row.variant_id
     OR artifact_row.channel_account_id <> grant_row.channel_account_id
     OR artifact_row.platform <> grant_row.platform
     OR artifact_row.payload_hash <> grant_row.payload_hash
     OR artifact_row.audit_hash <> grant_row.audit_hash THEN
    RAISE EXCEPTION 'publication audit is no longer valid' USING ERRCODE = '42501';
  END IF;

  IF variant_row.id IS NULL
     OR variant_row.state <> 'frozen'
     OR variant_row.channel_account_id <> grant_row.channel_account_id
     OR variant_row.platform <> grant_row.platform
     OR variant_row.payload_hash <> grant_row.payload_hash
     OR content_item_row.id IS NULL THEN
    RAISE EXCEPTION 'publication variant is no longer valid' USING ERRCODE = '42501';
  END IF;

  IF scheduled_value >= grant_row.expires_at OR scheduled_value >= artifact_row.expires_at THEN
    RAISE EXCEPTION 'scheduled publication must start before its grant and audit expire'
      USING ERRCODE = '22023';
  END IF;

  IF account_row.id IS NULL
     OR account_row.status <> 'active'
     OR account_row.platform <> 'ctrip_community'
     OR account_row.capability <> 'browser_assisted'
     OR NOT ('assisted' = ANY(account_row.supported_execution_levels))
     OR account_row.last_verified_at IS NULL
     OR account_row.last_verified_at < statement_timestamp() - interval '24 hours' THEN
    RAISE EXCEPTION 'Ctrip account browser-assisted capability is not current'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO control_row
  FROM geo.automation_controls AS control
  WHERE control.tenant_id = tenant_value
    AND control.scope_type = 'tenant'
    AND control.scope_key = '*';

  IF control_row.id IS NULL
     OR control_row.kill_switch_enabled
     OR control_row.mode IN ('shadow', 'paused', 'stopped') THEN
    RAISE EXCEPTION 'tenant automation control blocks Ctrip assisted handoff'
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
        (control.scope_type = 'topic' AND control.scope_key = content_item_row.topic_key)
      )
  LOOP
    IF scoped_control.kill_switch_enabled
       OR scoped_control.mode IN ('shadow', 'paused', 'stopped') THEN
      RAISE EXCEPTION 'scoped automation control blocks Ctrip assisted handoff'
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
    RAISE EXCEPTION 'a circuit breaker blocks Ctrip assisted handoff'
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
    RAISE EXCEPTION 'publication grant was concurrently consumed' USING ERRCODE = '40001';
  END IF;

  INSERT INTO geo.publication_jobs (
    tenant_id, id, grant_id, audit_artifact_id, variant_id, channel_account_id,
    platform, execution_level, state, idempotency_key, request_hash, payload_hash,
    available_at, scheduled_for
  ) VALUES (
    tenant_value, job_value, grant_row.id, grant_row.audit_artifact_id,
    grant_row.variant_id, grant_row.channel_account_id, 'ctrip_community',
    'assisted', 'queued', p_idempotency_key, p_request_hash, grant_row.payload_hash,
    scheduled_value, scheduled_value
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
      'platform', 'ctrip_community',
      'executionLevel', 'assisted',
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
    tenant_value, actor_value, 'publication_grant.ctrip_assisted_consumed',
    'publication_job', job_value,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_idempotency_key),
    p_request_hash,
    jsonb_build_object(
      'grantId', grant_row.id,
      'outboxEventId', outbox_value,
      'platform', 'ctrip_community',
      'executionLevel', 'assisted',
      'scheduledFor', scheduled_value
    )
  );

  RETURN QUERY SELECT job_value, outbox_value, true;
END
$$;

REVOKE ALL ON FUNCTION geo.consume_ctrip_assisted_publication_grant(
  uuid, geo.sha256_hex, text, geo.sha256_hex, text, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.consume_ctrip_assisted_publication_grant(
  uuid, geo.sha256_hex, text, geo.sha256_hex, text, timestamptz
) TO geo_runtime;
