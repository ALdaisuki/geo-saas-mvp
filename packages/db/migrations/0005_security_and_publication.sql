ALTER TABLE geo.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.users FORCE ROW LEVEL SECURITY;
CREATE POLICY user_self ON geo.users TO geo_runtime
  USING (id = geo.current_actor_id())
  WITH CHECK (id = geo.current_actor_id());

ALTER TABLE geo.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON geo.tenants TO geo_runtime
  USING (id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

DO $$
DECLARE
  table_name text;
  tenant_tables constant text[] := ARRAY[
    'tenant_memberships', 'service_principals', 'api_keys', 'sessions',
    'brands', 'tenant_contacts', 'policy_bundles', 'automation_controls',
    'channel_accounts', 'campaigns', 'claim_facts', 'evidence_sources',
    'content_items', 'content_versions', 'media_assets', 'publication_variants',
    'audit_runs', 'audit_artifacts', 'publication_grants', 'audit_log',
    'publication_jobs', 'publication_attempts', 'publication_receipts',
    'outbox_events', 'inbox_events', 'idempotency_records', 'circuit_breakers',
    'query_sets', 'query_set_versions', 'visibility_runs',
    'visibility_observations', 'visibility_metrics'
  ];
BEGIN
  FOREACH table_name IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE geo.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE geo.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON geo.%I TO geo_runtime '
      'USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL) '
      'WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)',
      table_name
    );
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION geo.validate_publication_grant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, geo
AS $$
DECLARE
  artifact geo.audit_artifacts%ROWTYPE;
  variant geo.publication_variants%ROWTYPE;
BEGIN
  IF NEW.status <> 'issued'
     OR NEW.consumed_at IS NOT NULL
     OR NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a publication grant must be inserted in issued state' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO artifact
  FROM geo.audit_artifacts
  WHERE tenant_id = NEW.tenant_id AND id = NEW.audit_artifact_id;

  SELECT * INTO variant
  FROM geo.publication_variants
  WHERE tenant_id = NEW.tenant_id AND id = NEW.variant_id;

  IF NOT FOUND OR artifact.id IS NULL OR variant.id IS NULL
     OR artifact.status <> 'passed'
     OR artifact.expires_at <= statement_timestamp()
     OR variant.state <> 'frozen'
     OR artifact.variant_id <> NEW.variant_id
     OR artifact.channel_account_id <> NEW.channel_account_id
     OR artifact.platform <> NEW.platform
     OR artifact.payload_hash <> NEW.payload_hash
     OR artifact.audit_hash <> NEW.audit_hash
     OR variant.payload_hash <> NEW.payload_hash
     OR NEW.expires_at > artifact.expires_at THEN
    RAISE EXCEPTION 'publication grant is not bound to a live passing audit and frozen variant'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER publication_grants_validate_insert
BEFORE INSERT ON geo.publication_grants
FOR EACH ROW EXECUTE FUNCTION geo.validate_publication_grant();

CREATE OR REPLACE FUNCTION geo.consume_publication_grant(
  p_grant_id uuid,
  p_token_hash geo.sha256_hex,
  p_idempotency_key text,
  p_request_hash geo.sha256_hex,
  p_execution_level text DEFAULT 'dry_run'
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
  account_row geo.channel_accounts%ROWTYPE;
  control_row geo.automation_controls%ROWTYPE;
  job_value uuid;
  outbox_value uuid;
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'idempotency key must contain 1 to 200 characters' USING ERRCODE = '22023';
  END IF;
  IF p_execution_level NOT IN ('dry_run', 'assisted', 'unattended') THEN
    RAISE EXCEPTION 'invalid execution level' USING ERRCODE = '22023';
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
      SELECT 1 FROM geo.publication_jobs
      WHERE tenant_id = tenant_value
        AND id = job_value
        AND grant_id = p_grant_id
        AND request_hash = p_request_hash
    ) THEN
      RAISE EXCEPTION 'idempotency key conflicts with another publication request'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT job_value, outbox_value, false;
    RETURN;
  END IF;

  SELECT * INTO grant_row
  FROM geo.publication_grants
  WHERE tenant_id = tenant_value AND id = p_grant_id
  FOR UPDATE;

  IF grant_row.id IS NULL
     OR grant_row.status <> 'issued'
     OR grant_row.expires_at <= statement_timestamp()
     OR grant_row.token_hash <> p_token_hash THEN
    RAISE EXCEPTION 'publication grant is invalid, expired, consumed, revoked, or mismatched'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO artifact_row
  FROM geo.audit_artifacts
  WHERE tenant_id = tenant_value AND id = grant_row.audit_artifact_id;

  SELECT * INTO account_row
  FROM geo.channel_accounts
  WHERE tenant_id = tenant_value AND id = grant_row.channel_account_id;

  SELECT * INTO control_row
  FROM geo.automation_controls
  WHERE tenant_id = tenant_value AND scope_type = 'tenant' AND scope_key = '*';

  IF artifact_row.id IS NULL
     OR artifact_row.status <> 'passed'
     OR artifact_row.expires_at <= statement_timestamp()
     OR artifact_row.payload_hash <> grant_row.payload_hash
     OR artifact_row.audit_hash <> grant_row.audit_hash THEN
    RAISE EXCEPTION 'publication audit is no longer valid' USING ERRCODE = '42501';
  END IF;

  IF account_row.id IS NULL
     OR account_row.status <> 'active'
     OR account_row.platform <> grant_row.platform
     OR NOT (p_execution_level = ANY(account_row.supported_execution_levels)) THEN
    RAISE EXCEPTION 'channel account does not support requested execution level'
      USING ERRCODE = '42501';
  END IF;

  IF p_execution_level = 'unattended'
     AND account_row.capability NOT IN ('public_api', 'partner_api') THEN
    RAISE EXCEPTION 'unattended publication requires a documented API capability'
      USING ERRCODE = '42501';
  END IF;

  IF p_execution_level <> 'dry_run'
     AND (control_row.id IS NULL
          OR control_row.kill_switch_enabled
          OR control_row.mode IN ('shadow', 'paused', 'stopped')
          OR (p_execution_level = 'unattended' AND control_row.mode <> 'unattended')) THEN
    RAISE EXCEPTION 'tenant automation control blocks external publication'
      USING ERRCODE = '42501';
  END IF;

  IF p_execution_level <> 'dry_run' AND EXISTS (
    SELECT 1
    FROM geo.circuit_breakers
    WHERE tenant_id = tenant_value
      AND state = 'open'
      AND (
        (scope_type = 'tenant' AND scope_key = '*')
        OR (scope_type = 'platform' AND scope_key = grant_row.platform)
        OR (scope_type = 'account' AND scope_key = grant_row.channel_account_id::text)
      )
  ) THEN
    RAISE EXCEPTION 'an open circuit breaker blocks external publication'
      USING ERRCODE = '42501';
  END IF;

  job_value := gen_random_uuid();
  outbox_value := gen_random_uuid();

  UPDATE geo.publication_grants
  SET status = 'consumed',
      consumed_at = clock_timestamp(),
      consumed_by_actor_id = actor_value
  WHERE tenant_id = tenant_value AND id = grant_row.id AND status = 'issued';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'publication grant was concurrently consumed' USING ERRCODE = '40001';
  END IF;

  INSERT INTO geo.publication_jobs (
    tenant_id, id, grant_id, audit_artifact_id, variant_id, channel_account_id,
    platform, execution_level, state, idempotency_key, request_hash, payload_hash
  ) VALUES (
    tenant_value, job_value, grant_row.id, grant_row.audit_artifact_id,
    grant_row.variant_id, grant_row.channel_account_id, grant_row.platform,
    p_execution_level, 'queued', p_idempotency_key, p_request_hash, grant_row.payload_hash
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
    request_hash, idempotency_key
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
      'payloadHash', grant_row.payload_hash
    ),
    p_request_hash,
    'publication-job:' || job_value::text
  );

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_grant.consumed',
    'publication_job', job_value,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_idempotency_key),
    p_request_hash,
    jsonb_build_object('grantId', grant_row.id, 'outboxEventId', outbox_value)
  );

  RETURN QUERY SELECT job_value, outbox_value, true;
END
$$;

CREATE OR REPLACE FUNCTION geo.revoke_publication_grant(p_grant_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'revocation reason is required' USING ERRCODE = '22023';
  END IF;

  UPDATE geo.publication_grants
  SET status = 'revoked', revoked_at = clock_timestamp(),
      revoked_by_actor_id = actor_value, revocation_reason = p_reason
  WHERE tenant_id = tenant_value AND id = p_grant_id AND status = 'issued';
  RETURN FOUND;
END
$$;

CREATE OR REPLACE FUNCTION geo.claim_outbox_events(
  p_worker_id text,
  p_limit integer DEFAULT 25,
  p_lease_seconds integer DEFAULT 60
)
RETURNS TABLE (
  tenant_id uuid,
  event_id uuid,
  topic text,
  payload jsonb,
  attempts integer,
  locked_until timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) NOT BETWEEN 1 AND 200
     OR p_limit NOT BETWEEN 1 AND 100
     OR p_lease_seconds NOT BETWEEN 5 AND 600 THEN
    RAISE EXCEPTION 'invalid dispatcher claim arguments' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH eligible AS (
    SELECT event.id, event.tenant_id, event.created_at,
           row_number() OVER (
             PARTITION BY event.tenant_id
             ORDER BY event.available_at, event.created_at, event.id
           ) AS tenant_rank
    FROM geo.outbox_events AS event
    WHERE event.published_at IS NULL
      AND event.dead_lettered_at IS NULL
      AND event.available_at <= statement_timestamp()
      AND (event.locked_until IS NULL OR event.locked_until < statement_timestamp())
  ), picked AS (
    SELECT event.id, event.tenant_id
    FROM eligible
    JOIN geo.outbox_events AS event USING (id, tenant_id)
    ORDER BY eligible.tenant_rank, eligible.created_at, eligible.tenant_id
    FOR UPDATE OF event SKIP LOCKED
    LIMIT p_limit
  ), leased AS (
    UPDATE geo.outbox_events AS event
    SET locked_by = p_worker_id,
        locked_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
        attempts = event.attempts + 1,
        last_attempt_at = clock_timestamp()
    FROM picked
    WHERE event.id = picked.id AND event.tenant_id = picked.tenant_id
    RETURNING event.tenant_id, event.id, event.topic, event.payload,
              event.attempts, event.locked_until
  )
  SELECT leased.tenant_id, leased.id, leased.topic, leased.payload,
         leased.attempts, leased.locked_until
  FROM leased
  ORDER BY leased.locked_until, leased.tenant_id, leased.id;
END
$$;

CREATE OR REPLACE FUNCTION geo.ack_outbox_event(p_event_id uuid, p_worker_id text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
  UPDATE geo.outbox_events
  SET published_at = clock_timestamp(), locked_by = NULL, locked_until = NULL, last_error = NULL
  WHERE id = p_event_id
    AND locked_by = p_worker_id
    AND locked_until >= statement_timestamp()
    AND published_at IS NULL
    AND dead_lettered_at IS NULL
  RETURNING true
$$;

CREATE OR REPLACE FUNCTION geo.retry_outbox_event(
  p_event_id uuid,
  p_worker_id text,
  p_delay_seconds integer,
  p_error text,
  p_dead_letter boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF p_delay_seconds NOT BETWEEN 0 AND 86400 OR p_error IS NULL THEN
    RAISE EXCEPTION 'invalid retry arguments' USING ERRCODE = '22023';
  END IF;

  UPDATE geo.outbox_events
  SET available_at = clock_timestamp() + make_interval(secs => p_delay_seconds),
      locked_by = NULL,
      locked_until = NULL,
      last_error = left(p_error, 4000),
      dead_lettered_at = CASE WHEN p_dead_letter THEN clock_timestamp() ELSE NULL END
  WHERE id = p_event_id
    AND locked_by = p_worker_id
    AND published_at IS NULL
    AND dead_lettered_at IS NULL;
  RETURN FOUND;
END
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA geo FROM PUBLIC, geo_dispatcher;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA geo FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA geo TO geo_runtime;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA geo FROM geo_runtime;
REVOKE UPDATE, DELETE ON geo.audit_artifacts, geo.publication_receipts,
  geo.audit_log, geo.visibility_observations FROM geo_runtime;
REVOKE UPDATE, DELETE ON geo.publication_grants FROM geo_runtime;
REVOKE INSERT, DELETE ON geo.publication_jobs FROM geo_runtime;
REVOKE INSERT, UPDATE, DELETE ON geo.outbox_events FROM geo_runtime;

GRANT EXECUTE ON FUNCTION geo.current_tenant_id() TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.current_actor_id() TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.require_tenant_id() TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.require_actor_id() TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.consume_publication_grant(uuid, geo.sha256_hex, text, geo.sha256_hex, text) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.revoke_publication_grant(uuid, text) TO geo_runtime;

GRANT EXECUTE ON FUNCTION geo.claim_outbox_events(text, integer, integer) TO geo_dispatcher;
GRANT EXECUTE ON FUNCTION geo.ack_outbox_event(uuid, text) TO geo_dispatcher;
GRANT EXECUTE ON FUNCTION geo.retry_outbox_event(uuid, text, integer, text, boolean) TO geo_dispatcher;
