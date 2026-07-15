ALTER TABLE geo.publication_jobs
  ADD COLUMN scheduled_for timestamptz;

UPDATE geo.publication_jobs
SET scheduled_for = available_at
WHERE scheduled_for IS NULL;

ALTER TABLE geo.publication_jobs
  ALTER COLUMN scheduled_for SET NOT NULL;

ALTER TABLE geo.publication_jobs
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancelled_by_actor_id uuid,
  ADD COLUMN cancellation_reason text;

UPDATE geo.publication_jobs
SET cancelled_at = updated_at,
    cancellation_reason = COALESCE(last_error_code, 'legacy cancellation')
WHERE state = 'cancelled' AND cancelled_at IS NULL;

ALTER TABLE geo.publication_jobs
  ADD CONSTRAINT publication_jobs_cancellation_metadata
  CHECK (
    state <> 'cancelled' OR (
      cancelled_at IS NOT NULL AND
      cancellation_reason IS NOT NULL AND
      length(trim(cancellation_reason)) > 0
    )
  );

CREATE INDEX publication_jobs_schedule
  ON geo.publication_jobs (tenant_id, scheduled_for, id)
  WHERE state IN ('queued', 'retry_wait');

ALTER TABLE geo.publication_attempts
  ADD COLUMN worker_id text,
  ADD COLUMN half_open_probe boolean NOT NULL DEFAULT false,
  ADD COLUMN governance_finished_at timestamptz;

UPDATE geo.publication_attempts
SET worker_id = 'legacy-worker'
WHERE state = 'started' AND worker_id IS NULL;

ALTER TABLE geo.publication_attempts
  ADD CONSTRAINT publication_attempts_started_worker
  CHECK (state <> 'started' OR (worker_id IS NOT NULL AND length(worker_id) BETWEEN 1 AND 200)),
  ADD CONSTRAINT publication_attempts_governance_finished
  CHECK (governance_finished_at IS NULL OR finished_at IS NOT NULL);

CREATE INDEX publication_attempts_active_execution
  ON geo.publication_attempts (tenant_id, job_id, started_at, id)
  WHERE state = 'started';

ALTER TABLE geo.circuit_breakers
  ADD COLUMN probe_attempt_id uuid,
  ADD COLUMN probe_started_at timestamptz;

ALTER TABLE geo.circuit_breakers
  ADD CONSTRAINT circuit_breakers_probe_state
  CHECK (
    state = 'half_open' OR
    (probe_attempt_id IS NULL AND probe_started_at IS NULL)
  ),
  ADD CONSTRAINT circuit_breakers_probe_timestamps
  CHECK ((probe_attempt_id IS NULL) = (probe_started_at IS NULL)),
  ADD CONSTRAINT circuit_breakers_probe_attempt_fk
  FOREIGN KEY (tenant_id, probe_attempt_id)
  REFERENCES geo.publication_attempts (tenant_id, id) ON DELETE RESTRICT;

CREATE INDEX circuit_breakers_probe_lookup
  ON geo.circuit_breakers (tenant_id, probe_attempt_id)
  WHERE probe_attempt_id IS NOT NULL;

CREATE TABLE geo.publication_readbacks (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  execution_level text NOT NULL CHECK (execution_level IN ('dry_run', 'assisted', 'unattended')),
  status text NOT NULL CHECK (status IN ('not_required', 'pending', 'processing', 'succeeded', 'failed', 'cancelled')),
  required boolean NOT NULL,
  reason text,
  scheduled_for timestamptz NOT NULL,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, job_id),
  UNIQUE (tenant_id, receipt_id),
  FOREIGN KEY (tenant_id, job_id)
    REFERENCES geo.publication_jobs (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, receipt_id)
    REFERENCES geo.publication_receipts (tenant_id, id) ON DELETE RESTRICT,
  CHECK (required = (execution_level <> 'dry_run')),
  CHECK ((status = 'not_required') = (execution_level = 'dry_run')),
  CHECK (status <> 'not_required' OR reason = 'dry_run_preview_only'),
  CHECK (
    (status IN ('not_required', 'succeeded', 'failed', 'cancelled')) =
    (completed_at IS NOT NULL)
  )
);

CREATE INDEX publication_readbacks_pending
  ON geo.publication_readbacks (tenant_id, status, scheduled_for, id)
  WHERE status IN ('pending', 'processing');

CREATE TRIGGER publication_readbacks_set_updated_at
BEFORE UPDATE ON geo.publication_readbacks
FOR EACH ROW EXECUTE FUNCTION geo.set_updated_at();

ALTER TABLE geo.publication_readbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.publication_readbacks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON geo.publication_readbacks TO geo_runtime
  USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

CREATE OR REPLACE FUNCTION geo.consume_publication_grant(
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
  account_row geo.channel_accounts%ROWTYPE;
  control_row geo.automation_controls%ROWTYPE;
  job_value uuid;
  outbox_value uuid;
  scheduled_value timestamptz := COALESCE(p_scheduled_for, statement_timestamp());
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'idempotency key must contain 1 to 200 characters' USING ERRCODE = '22023';
  END IF;
  IF p_execution_level NOT IN ('dry_run', 'assisted', 'unattended') THEN
    RAISE EXCEPTION 'invalid execution level' USING ERRCODE = '22023';
  END IF;
  IF p_execution_level <> 'dry_run' THEN
    RAISE EXCEPTION 'live publication is unsupported for the current platform adapters'
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
      SELECT 1 FROM geo.publication_jobs AS job
      WHERE job.tenant_id = tenant_value
        AND job.id = job_value
        AND job.grant_id = p_grant_id
        AND job.request_hash = p_request_hash
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

  SELECT * INTO artifact_row
  FROM geo.audit_artifacts AS artifact
  WHERE artifact.tenant_id = tenant_value AND artifact.id = grant_row.audit_artifact_id;

  SELECT * INTO account_row
  FROM geo.channel_accounts AS account
  WHERE account.tenant_id = tenant_value AND account.id = grant_row.channel_account_id;

  SELECT * INTO control_row
  FROM geo.automation_controls AS control
  WHERE control.tenant_id = tenant_value AND control.scope_type = 'tenant' AND control.scope_key = '*';

  IF artifact_row.id IS NULL
     OR artifact_row.status <> 'passed'
     OR artifact_row.expires_at <= statement_timestamp()
     OR artifact_row.payload_hash <> grant_row.payload_hash
     OR artifact_row.audit_hash <> grant_row.audit_hash THEN
    RAISE EXCEPTION 'publication audit is no longer valid' USING ERRCODE = '42501';
  END IF;

  IF scheduled_value >= grant_row.expires_at OR scheduled_value >= artifact_row.expires_at THEN
    RAISE EXCEPTION 'scheduled publication must start before its grant and audit expire'
      USING ERRCODE = '22023';
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
    FROM geo.circuit_breakers AS breaker
    WHERE breaker.tenant_id = tenant_value
      AND breaker.state = 'open'
      AND (
        (breaker.scope_type = 'tenant' AND breaker.scope_key = '*')
        OR (breaker.scope_type = 'platform' AND breaker.scope_key = grant_row.platform)
        OR (breaker.scope_type = 'account' AND breaker.scope_key = grant_row.channel_account_id::text)
      )
  ) THEN
    RAISE EXCEPTION 'an open circuit breaker blocks external publication'
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
    grant_row.variant_id, grant_row.channel_account_id, grant_row.platform,
    p_execution_level, 'queued', p_idempotency_key, p_request_hash, grant_row.payload_hash,
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
    tenant_value, actor_value, 'publication_grant.consumed',
    'publication_job', job_value,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_idempotency_key),
    p_request_hash,
    jsonb_build_object(
      'grantId', grant_row.id,
      'outboxEventId', outbox_value,
      'scheduledFor', scheduled_value
    )
  );

  RETURN QUERY SELECT job_value, outbox_value, true;
END
$$;

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
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
  SELECT *
  FROM geo.consume_publication_grant(
    p_grant_id,
    p_token_hash,
    p_idempotency_key,
    p_request_hash,
    p_execution_level,
    NULL::timestamptz
  )
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
  grant_row geo.publication_grants%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'revocation reason is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO grant_row
  FROM geo.publication_grants AS publication_grant
  WHERE publication_grant.tenant_id = tenant_value AND publication_grant.id = p_grant_id
  FOR UPDATE;

  IF grant_row.id IS NULL THEN
    RAISE EXCEPTION 'publication grant was not found' USING ERRCODE = 'P0002';
  END IF;
  IF grant_row.status <> 'issued' THEN
    RAISE EXCEPTION 'publication grant in state % cannot be revoked', grant_row.status
      USING ERRCODE = '55000';
  END IF;

  UPDATE geo.publication_grants AS publication_grant
  SET status = 'revoked',
      revoked_at = clock_timestamp(),
      revoked_by_actor_id = actor_value,
      revocation_reason = trim(p_reason)
  WHERE publication_grant.tenant_id = tenant_value
    AND publication_grant.id = p_grant_id
    AND publication_grant.status = 'issued';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'publication grant was concurrently changed' USING ERRCODE = '40001';
  END IF;
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION geo.cancel_publication_job(p_job_id uuid, p_reason text)
RETURNS TABLE (
  publication_job_id uuid,
  state text,
  was_changed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  job_row geo.publication_jobs%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'cancellation reason is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO job_row
  FROM geo.publication_jobs AS job
  WHERE job.tenant_id = tenant_value AND job.id = p_job_id
  FOR UPDATE;

  IF job_row.id IS NULL THEN
    RAISE EXCEPTION 'publication job was not found' USING ERRCODE = 'P0002';
  END IF;

  IF job_row.state IN ('cancelled', 'preview_completed', 'confirmed', 'permanent_failure') THEN
    RETURN QUERY SELECT job_row.id, job_row.state, false;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM geo.outbox_events AS event
    WHERE event.tenant_id = tenant_value
      AND event.aggregate_type = 'publication_job'
      AND event.aggregate_id = p_job_id
      AND event.topic = 'publication.requested'
      AND event.published_at IS NULL
      AND event.dead_lettered_at IS NULL
      AND event.locked_by IS NOT NULL
      AND event.locked_until >= statement_timestamp()
  ) THEN
    RAISE EXCEPTION 'publication job has an active dispatcher outbox lease'
      USING ERRCODE = '55006';
  END IF;

  IF job_row.state = 'dispatching'
     AND job_row.lease_expires_at IS NOT NULL
     AND job_row.lease_expires_at >= statement_timestamp() THEN
    RAISE EXCEPTION 'publication job has an active worker lease' USING ERRCODE = '55006';
  END IF;

  IF job_row.state NOT IN ('queued', 'retry_wait')
     AND job_row.state <> 'dispatching' THEN
    RAISE EXCEPTION 'publication job in state % cannot be cancelled', job_row.state
      USING ERRCODE = '55000';
  END IF;

  UPDATE geo.publication_jobs AS job
  SET state = 'cancelled',
      lease_owner = NULL,
      lease_expires_at = NULL,
      cancelled_at = clock_timestamp(),
      cancelled_by_actor_id = actor_value,
      cancellation_reason = trim(p_reason),
      last_error_code = 'cancelled_by_operator'
  WHERE job.tenant_id = tenant_value AND job.id = p_job_id;

  UPDATE geo.publication_attempts AS attempt
  SET state = 'failed',
      error_code = 'CANCELLED_BY_OPERATOR',
      error_message = 'Publication job cancelled after worker lease expiry',
      finished_at = clock_timestamp(),
      governance_finished_at = clock_timestamp()
  WHERE attempt.tenant_id = tenant_value
    AND attempt.job_id = p_job_id
    AND attempt.state = 'started';

  UPDATE geo.outbox_events AS event
  SET dead_lettered_at = clock_timestamp(),
      locked_by = NULL,
      locked_until = NULL,
      last_error = left('cancelled: ' || trim(p_reason), 4000)
  WHERE event.tenant_id = tenant_value
    AND event.aggregate_type = 'publication_job'
    AND event.aggregate_id = p_job_id
    AND event.topic = 'publication.requested'
    AND event.published_at IS NULL
    AND event.dead_lettered_at IS NULL;

  RETURN QUERY SELECT p_job_id, 'cancelled'::text, true;
END
$$;

CREATE OR REPLACE FUNCTION geo.schedule_publication_readback(
  p_job_id uuid,
  p_receipt_id uuid,
  p_scheduled_for timestamptz DEFAULT NULL
)
RETURNS TABLE (
  publication_readback_id uuid,
  publication_outbox_event_id uuid,
  state text,
  required boolean,
  was_created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  job_row geo.publication_jobs%ROWTYPE;
  receipt_row geo.publication_receipts%ROWTYPE;
  readback_row geo.publication_readbacks%ROWTYPE;
  readback_value uuid;
  scheduled_value timestamptz := COALESCE(p_scheduled_for, statement_timestamp());
BEGIN
  IF scheduled_value < statement_timestamp() - interval '1 second' THEN
    RAISE EXCEPTION 'readback schedule cannot be in the past' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(tenant_value::text || ':readback:' || p_job_id::text, 0));

  SELECT * INTO job_row
  FROM geo.publication_jobs AS job
  WHERE job.tenant_id = tenant_value AND job.id = p_job_id
  FOR UPDATE;

  IF job_row.id IS NULL THEN
    RAISE EXCEPTION 'publication job was not found' USING ERRCODE = 'P0002';
  END IF;
  IF job_row.execution_level <> 'dry_run' THEN
    RAISE EXCEPTION 'live publication readback is unsupported for the current platform adapters'
      USING ERRCODE = '0A000';
  END IF;

  SELECT * INTO readback_row
  FROM geo.publication_readbacks AS readback
  WHERE readback.tenant_id = tenant_value AND readback.job_id = p_job_id;

  IF readback_row.id IS NOT NULL THEN
    IF readback_row.receipt_id <> p_receipt_id THEN
      RAISE EXCEPTION 'publication job already has a readback for another receipt'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY
      SELECT readback_row.id, NULL::uuid, readback_row.status,
             readback_row.required, false;
    RETURN;
  END IF;

  SELECT * INTO receipt_row
  FROM geo.publication_receipts AS receipt
  WHERE receipt.tenant_id = tenant_value
    AND receipt.id = p_receipt_id
    AND receipt.job_id = p_job_id;

  IF receipt_row.id IS NULL OR receipt_row.execution_level <> job_row.execution_level THEN
    RAISE EXCEPTION 'publication receipt is not bound to the job execution'
      USING ERRCODE = '23514';
  END IF;

  readback_value := gen_random_uuid();

  IF job_row.state <> 'preview_completed' OR receipt_row.confirmed THEN
    RAISE EXCEPTION 'dry-run readback disposition requires a completed preview receipt'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO geo.publication_readbacks (
    tenant_id, id, job_id, receipt_id, execution_level, status, required,
    reason, scheduled_for, completed_at
  ) VALUES (
    tenant_value, readback_value, p_job_id, p_receipt_id, 'dry_run',
    'not_required', false, 'dry_run_preview_only', scheduled_value, clock_timestamp()
  );

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_readback.not_required',
    'publication_readback', readback_value,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), 'readback:' || p_job_id::text),
    receipt_row.response_hash,
    jsonb_build_object(
      'jobId', p_job_id,
      'receiptId', p_receipt_id,
      'required', false,
      'reason', 'dry_run_preview_only',
      'outboxEventId', NULL
    )
  );

  RETURN QUERY
    SELECT readback_value, NULL::uuid, 'not_required'::text, false, true;
END
$$;

CREATE OR REPLACE FUNCTION geo.acquire_publication_execution(
  p_job_id uuid,
  p_attempt_id uuid,
  p_worker_id text
)
RETURNS TABLE (
  allowed boolean,
  reason text,
  half_open_probe boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  now_value timestamptz := clock_timestamp();
  job_row record;
  attempt_row geo.publication_attempts%ROWTYPE;
  control_row record;
  circuit_row record;
  quota_key text;
  quota_text text;
  max_concurrent_value integer;
  per_minute_value integer;
  per_day_value integer;
  cooldown_seconds_value integer;
  error_budget_value integer;
  active_count bigint;
  minute_count bigint;
  day_count bigint;
  failure_count_value bigint;
  latest_started_at timestamptz;
  attempt_no_value integer;
  denial_reason text;
  any_control boolean := false;
  probe_value boolean := false;
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'worker id must contain 1 to 200 characters' USING ERRCODE = '22023';
  END IF;

  SELECT job.*, content_item.campaign_id AS scope_campaign_id,
         content_item.topic_key AS scope_topic_key,
         publication_grant.status AS authorization_grant_status,
         publication_grant.expires_at AS authorization_grant_expires_at,
         publication_grant.audit_artifact_id AS authorization_grant_artifact_id,
         publication_grant.variant_id AS authorization_grant_variant_id,
         publication_grant.channel_account_id AS authorization_grant_account_id,
         publication_grant.platform AS authorization_grant_platform,
         publication_grant.payload_hash AS authorization_grant_payload_hash,
         publication_grant.audit_hash AS authorization_grant_audit_hash,
         audit_artifact.status AS authorization_artifact_status,
         audit_artifact.expires_at AS authorization_artifact_expires_at,
         audit_artifact.variant_id AS authorization_artifact_variant_id,
         audit_artifact.channel_account_id AS authorization_artifact_account_id,
         audit_artifact.platform AS authorization_artifact_platform,
         audit_artifact.payload_hash AS authorization_artifact_payload_hash,
         audit_artifact.audit_hash AS authorization_artifact_audit_hash
  INTO job_row
  FROM geo.publication_jobs AS job
  JOIN geo.publication_grants AS publication_grant
    ON publication_grant.tenant_id = job.tenant_id
   AND publication_grant.id = job.grant_id
  JOIN geo.audit_artifacts AS audit_artifact
    ON audit_artifact.tenant_id = job.tenant_id
   AND audit_artifact.id = job.audit_artifact_id
  JOIN geo.publication_variants AS variant
    ON variant.tenant_id = job.tenant_id AND variant.id = job.variant_id
  JOIN geo.content_versions AS content_version
    ON content_version.tenant_id = variant.tenant_id
   AND content_version.id = variant.content_version_id
  JOIN geo.content_items AS content_item
    ON content_item.tenant_id = content_version.tenant_id
   AND content_item.id = content_version.content_item_id
  WHERE job.tenant_id = tenant_value AND job.id = p_job_id
  FOR UPDATE OF job, publication_grant;

  IF job_row.id IS NULL THEN
    RAISE EXCEPTION 'publication job was not found' USING ERRCODE = 'P0002';
  END IF;

  IF job_row.authorization_grant_status <> 'consumed'
     OR job_row.authorization_artifact_status <> 'passed'
     OR job_row.authorization_grant_expires_at <= now_value
     OR job_row.authorization_artifact_expires_at <= now_value THEN
    denial_reason := 'authorization_expired';
  ELSIF job_row.authorization_grant_artifact_id <> job_row.audit_artifact_id
        OR job_row.authorization_grant_variant_id <> job_row.variant_id
        OR job_row.authorization_grant_account_id <> job_row.channel_account_id
        OR job_row.authorization_grant_platform <> job_row.platform
        OR job_row.authorization_grant_payload_hash <> job_row.payload_hash
        OR job_row.authorization_artifact_variant_id <> job_row.variant_id
        OR job_row.authorization_artifact_account_id <> job_row.channel_account_id
        OR job_row.authorization_artifact_platform <> job_row.platform
        OR job_row.authorization_artifact_payload_hash <> job_row.payload_hash
        OR job_row.authorization_grant_audit_hash <> job_row.authorization_artifact_audit_hash THEN
    denial_reason := 'authorization_binding_mismatch';
  END IF;

  SELECT * INTO attempt_row
  FROM geo.publication_attempts AS attempt
  WHERE attempt.tenant_id = tenant_value AND attempt.id = p_attempt_id
  FOR UPDATE;

  IF attempt_row.id IS NOT NULL THEN
    IF attempt_row.job_id <> p_job_id OR attempt_row.worker_id <> p_worker_id THEN
      RAISE EXCEPTION 'publication attempt id conflicts with another execution'
        USING ERRCODE = '23505';
    END IF;
    IF denial_reason IS NULL THEN
      IF attempt_row.state = 'started' THEN
        UPDATE geo.publication_jobs AS job
        SET lease_owner = p_worker_id,
            lease_expires_at = now_value + interval '10 minutes'
        WHERE job.tenant_id = tenant_value AND job.id = p_job_id;
        RETURN QUERY
          SELECT true, CASE WHEN attempt_row.half_open_probe
            THEN 'half_open_probe' ELSE 'already_acquired' END,
            attempt_row.half_open_probe;
      ELSE
        RETURN QUERY SELECT false, 'attempt_already_finished'::text, false;
      END IF;
      RETURN;
    END IF;
  END IF;

  IF denial_reason IS NULL AND job_row.state NOT IN ('queued', 'retry_wait', 'dispatching') THEN
    denial_reason := 'job_state:' || job_row.state;
  ELSIF denial_reason IS NULL AND job_row.state = 'dispatching'
        AND job_row.lease_expires_at IS NOT NULL
        AND job_row.lease_expires_at >= now_value THEN
    denial_reason := 'job_active_lease';
  END IF;

  IF denial_reason IS NULL THEN
    FOR control_row IN
      SELECT control.*
      FROM geo.automation_controls AS control
      WHERE control.tenant_id = tenant_value
        AND (
          (control.scope_type = 'tenant' AND control.scope_key = '*')
          OR (control.scope_type = 'platform' AND control.scope_key = job_row.platform)
          OR (control.scope_type = 'account' AND control.scope_key = job_row.channel_account_id::text)
          OR (control.scope_type = 'campaign' AND control.scope_key = job_row.scope_campaign_id::text)
          OR (control.scope_type = 'topic' AND control.scope_key = job_row.scope_topic_key)
        )
      ORDER BY control.scope_type, control.scope_key
      FOR UPDATE OF control
    LOOP
      any_control := true;
      IF control_row.kill_switch_enabled THEN
        denial_reason := 'automation_kill_switch:' || control_row.scope_type || ':' || control_row.scope_key;
        EXIT;
      END IF;
      IF control_row.mode IN ('paused', 'stopped')
         OR (job_row.execution_level <> 'dry_run' AND control_row.mode = 'shadow')
         OR (job_row.execution_level = 'assisted' AND control_row.mode NOT IN ('supervised', 'unattended'))
         OR (job_row.execution_level = 'unattended' AND control_row.mode <> 'unattended') THEN
        denial_reason := 'automation_mode:' || control_row.mode || ':' ||
          control_row.scope_type || ':' || control_row.scope_key;
        EXIT;
      END IF;

      IF jsonb_typeof(control_row.quota) <> 'object' THEN
        denial_reason := 'quota_invalid:object:' ||
          control_row.scope_type || ':' || control_row.scope_key;
        EXIT;
      END IF;
      quota_key := NULL;
      SELECT candidate.key INTO quota_key
      FROM jsonb_object_keys(control_row.quota) AS candidate(key)
      WHERE candidate.key <> ALL (ARRAY[
        'maxConcurrent', 'perMinute', 'perDay', 'cooldownSeconds', 'errorBudget'
      ]::text[])
      ORDER BY candidate.key
      LIMIT 1;
      IF quota_key IS NOT NULL THEN
        denial_reason := 'quota_unknown:' || quota_key || ':' ||
          control_row.scope_type || ':' || control_row.scope_key;
        EXIT;
      END IF;

      FOREACH quota_key IN ARRAY ARRAY[
        'maxConcurrent', 'perMinute', 'perDay', 'cooldownSeconds', 'errorBudget'
      ]::text[] LOOP
        IF control_row.quota ? quota_key THEN
          quota_text := control_row.quota ->> quota_key;
          IF jsonb_typeof(control_row.quota -> quota_key) <> 'number'
             OR quota_text !~ '^[0-9]{1,9}$' THEN
            denial_reason := 'quota_invalid:' || quota_key || ':' ||
              control_row.scope_type || ':' || control_row.scope_key;
            EXIT;
          END IF;
        END IF;
      END LOOP;
      EXIT WHEN denial_reason IS NOT NULL;

      max_concurrent_value := CASE WHEN control_row.quota ? 'maxConcurrent'
        THEN (control_row.quota ->> 'maxConcurrent')::integer ELSE NULL END;
      per_minute_value := CASE WHEN control_row.quota ? 'perMinute'
        THEN (control_row.quota ->> 'perMinute')::integer ELSE NULL END;
      per_day_value := CASE WHEN control_row.quota ? 'perDay'
        THEN (control_row.quota ->> 'perDay')::integer ELSE NULL END;
      cooldown_seconds_value := CASE WHEN control_row.quota ? 'cooldownSeconds'
        THEN (control_row.quota ->> 'cooldownSeconds')::integer ELSE NULL END;
      error_budget_value := CASE WHEN control_row.quota ? 'errorBudget'
        THEN (control_row.quota ->> 'errorBudget')::integer ELSE NULL END;

      SELECT
        count(*) FILTER (
          WHERE attempt.state = 'started'
            AND prior_job.lease_expires_at IS NOT NULL
            AND prior_job.lease_expires_at >= now_value
        ),
        count(*) FILTER (WHERE attempt.started_at >= now_value - interval '1 minute'),
        count(*) FILTER (WHERE attempt.started_at >= now_value - interval '1 day'),
        count(*) FILTER (
          WHERE attempt.state IN ('failed', 'uncertain')
            AND attempt.started_at >= now_value - interval '1 day'
        ),
        max(attempt.started_at)
      INTO active_count, minute_count, day_count, failure_count_value, latest_started_at
      FROM geo.publication_attempts AS attempt
      JOIN geo.publication_jobs AS prior_job
        ON prior_job.tenant_id = attempt.tenant_id AND prior_job.id = attempt.job_id
      JOIN geo.publication_variants AS prior_variant
        ON prior_variant.tenant_id = prior_job.tenant_id AND prior_variant.id = prior_job.variant_id
      JOIN geo.content_versions AS prior_version
        ON prior_version.tenant_id = prior_variant.tenant_id
       AND prior_version.id = prior_variant.content_version_id
      JOIN geo.content_items AS prior_item
        ON prior_item.tenant_id = prior_version.tenant_id
       AND prior_item.id = prior_version.content_item_id
      WHERE attempt.tenant_id = tenant_value
        AND (
          control_row.scope_type = 'tenant'
          OR (control_row.scope_type = 'platform' AND prior_job.platform = control_row.scope_key)
          OR (control_row.scope_type = 'account' AND prior_job.channel_account_id::text = control_row.scope_key)
          OR (control_row.scope_type = 'campaign' AND prior_item.campaign_id::text = control_row.scope_key)
          OR (control_row.scope_type = 'topic' AND prior_item.topic_key = control_row.scope_key)
        );

      IF max_concurrent_value IS NOT NULL AND active_count >= max_concurrent_value THEN
        denial_reason := 'quota_max_concurrent:' || control_row.scope_type || ':' || control_row.scope_key;
      ELSIF per_minute_value IS NOT NULL AND minute_count >= per_minute_value THEN
        denial_reason := 'quota_per_minute:' || control_row.scope_type || ':' || control_row.scope_key;
      ELSIF per_day_value IS NOT NULL AND day_count >= per_day_value THEN
        denial_reason := 'quota_per_day:' || control_row.scope_type || ':' || control_row.scope_key;
      ELSIF cooldown_seconds_value IS NOT NULL
            AND latest_started_at IS NOT NULL
            AND latest_started_at + make_interval(secs => cooldown_seconds_value) > now_value THEN
        denial_reason := 'quota_cooldown:' || control_row.scope_type || ':' || control_row.scope_key;
      ELSIF error_budget_value IS NOT NULL AND failure_count_value > error_budget_value THEN
        denial_reason := 'quota_error_budget:' || control_row.scope_type || ':' || control_row.scope_key;
      END IF;
      EXIT WHEN denial_reason IS NOT NULL;
    END LOOP;

    IF NOT any_control AND job_row.execution_level <> 'dry_run' THEN
      denial_reason := 'automation_control_missing';
    END IF;
  END IF;

  IF denial_reason IS NULL AND job_row.execution_level <> 'dry_run' THEN
    FOR circuit_row IN
      SELECT circuit.*
      FROM geo.circuit_breakers AS circuit
      WHERE circuit.tenant_id = tenant_value
        AND (
          (circuit.scope_type = 'tenant' AND circuit.scope_key = '*')
          OR (circuit.scope_type = 'platform' AND circuit.scope_key = job_row.platform)
          OR (circuit.scope_type = 'account' AND circuit.scope_key = job_row.channel_account_id::text)
          OR (circuit.scope_type = 'campaign' AND circuit.scope_key = job_row.scope_campaign_id::text)
          OR (circuit.scope_type = 'topic' AND circuit.scope_key = job_row.scope_topic_key)
        )
      ORDER BY circuit.scope_type, circuit.scope_key
      FOR UPDATE OF circuit
    LOOP
      IF circuit_row.state = 'open' THEN
        IF circuit_row.retry_at IS NULL OR circuit_row.retry_at > now_value THEN
          denial_reason := 'circuit_open:' || circuit_row.scope_type || ':' || circuit_row.scope_key;
          EXIT;
        END IF;
        probe_value := true;
      ELSIF circuit_row.state = 'half_open' THEN
        IF circuit_row.probe_attempt_id IS NOT NULL THEN
          IF circuit_row.probe_started_at <= now_value - interval '10 minutes'
             AND NOT EXISTS (
               SELECT 1
               FROM geo.publication_attempts AS probe_attempt
               JOIN geo.publication_jobs AS probe_job
                 ON probe_job.tenant_id = probe_attempt.tenant_id
                AND probe_job.id = probe_attempt.job_id
               WHERE probe_attempt.tenant_id = tenant_value
                 AND probe_attempt.id = circuit_row.probe_attempt_id
                 AND probe_attempt.state = 'started'
                 AND probe_job.state = 'dispatching'
                 AND probe_job.lease_expires_at IS NOT NULL
                 AND probe_job.lease_expires_at >= now_value
             ) THEN
            UPDATE geo.publication_attempts AS probe_attempt
            SET state = 'failed',
                error_code = 'WORKER_LEASE_EXPIRED',
                error_message = 'Half-open publication probe lease expired',
                finished_at = now_value,
                governance_finished_at = now_value
            WHERE probe_attempt.tenant_id = tenant_value
              AND probe_attempt.id = circuit_row.probe_attempt_id
              AND probe_attempt.state = 'started';

            UPDATE geo.publication_jobs AS probe_job
            SET state = 'retry_wait',
                lease_owner = NULL,
                lease_expires_at = NULL,
                available_at = now_value,
                last_error_code = 'WORKER_LEASE_EXPIRED'
            WHERE probe_job.tenant_id = tenant_value
              AND probe_job.id = (
                SELECT probe_attempt.job_id
                FROM geo.publication_attempts AS probe_attempt
                WHERE probe_attempt.tenant_id = tenant_value
                  AND probe_attempt.id = circuit_row.probe_attempt_id
              )
              AND probe_job.state = 'dispatching'
              AND (probe_job.lease_expires_at IS NULL OR probe_job.lease_expires_at < now_value);

            UPDATE geo.circuit_breakers AS circuit
            SET state = 'open',
                failure_count = circuit.failure_count + 1,
                opened_at = now_value,
                retry_at = now_value,
                reason = 'half-open publication probe lease expired',
                probe_attempt_id = NULL,
                probe_started_at = NULL,
                updated_at = now_value
            WHERE circuit.tenant_id = tenant_value
              AND circuit.scope_type = circuit_row.scope_type
              AND circuit.scope_key = circuit_row.scope_key
              AND circuit.state = 'half_open'
              AND circuit.probe_attempt_id = circuit_row.probe_attempt_id;
            probe_value := true;
          ELSE
            denial_reason := 'circuit_half_open_probe_active:' ||
              circuit_row.scope_type || ':' || circuit_row.scope_key;
            EXIT;
          END IF;
        END IF;
        IF circuit_row.probe_attempt_id IS NULL THEN
          probe_value := true;
        END IF;
      END IF;
    END LOOP;
  END IF;

  IF denial_reason IS NOT NULL THEN
    INSERT INTO geo.audit_log (
      tenant_id, actor_id, action, resource_type, resource_id,
      request_id, after_hash, details
    ) VALUES (
      tenant_value, actor_value, 'publication_execution.denied',
      'publication_job', p_job_id,
      COALESCE(NULLIF(current_setting('app.request_id', true), ''), 'execution:' || p_attempt_id::text),
      job_row.request_hash,
      jsonb_build_object(
        'attemptId', p_attempt_id,
        'workerId', p_worker_id,
        'executionLevel', job_row.execution_level,
        'reason', denial_reason
      )
    );
    RETURN QUERY SELECT false, denial_reason, false;
    RETURN;
  END IF;

  UPDATE geo.publication_attempts AS attempt
  SET state = 'failed',
      error_code = 'WORKER_LEASE_EXPIRED',
      error_message = 'Previous publication execution lease expired',
      finished_at = now_value,
      governance_finished_at = now_value
  WHERE attempt.tenant_id = tenant_value
    AND attempt.job_id = p_job_id
    AND attempt.state = 'started';

  SELECT COALESCE(max(attempt.attempt_no), 0) + 1
  INTO attempt_no_value
  FROM geo.publication_attempts AS attempt
  WHERE attempt.tenant_id = tenant_value AND attempt.job_id = p_job_id;

  INSERT INTO geo.publication_attempts (
    tenant_id, id, job_id, attempt_no, state, request_hash,
    started_at, worker_id, half_open_probe
  ) VALUES (
    tenant_value, p_attempt_id, p_job_id, attempt_no_value, 'started',
    job_row.request_hash, now_value, p_worker_id, probe_value
  );

  UPDATE geo.publication_jobs AS job
  SET state = 'dispatching',
      lease_owner = p_worker_id,
      lease_expires_at = now_value + interval '10 minutes',
      last_error_code = NULL
  WHERE job.tenant_id = tenant_value AND job.id = p_job_id;

  IF probe_value THEN
    UPDATE geo.circuit_breakers AS circuit
    SET state = 'half_open',
        probe_attempt_id = p_attempt_id,
        probe_started_at = now_value,
        updated_at = now_value
    WHERE circuit.tenant_id = tenant_value
      AND (
        (circuit.scope_type = 'tenant' AND circuit.scope_key = '*')
        OR (circuit.scope_type = 'platform' AND circuit.scope_key = job_row.platform)
        OR (circuit.scope_type = 'account' AND circuit.scope_key = job_row.channel_account_id::text)
        OR (circuit.scope_type = 'campaign' AND circuit.scope_key = job_row.scope_campaign_id::text)
        OR (circuit.scope_type = 'topic' AND circuit.scope_key = job_row.scope_topic_key)
      )
      AND (
        (circuit.state = 'open' AND circuit.retry_at IS NOT NULL AND circuit.retry_at <= now_value)
        OR (circuit.state = 'half_open' AND circuit.probe_attempt_id IS NULL)
      );
  END IF;

  RETURN QUERY
    SELECT true, CASE WHEN probe_value THEN 'half_open_probe' ELSE 'allowed' END, probe_value;
END
$$;

CREATE OR REPLACE FUNCTION geo.finish_publication_execution(
  p_job_id uuid,
  p_attempt_id uuid,
  p_outcome text,
  p_error_code text
)
RETURNS TABLE (
  circuits_opened integer,
  circuits_closed integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  now_value timestamptz := clock_timestamp();
  job_row record;
  attempt_row geo.publication_attempts%ROWTYPE;
  control_row record;
  cooldown_value integer;
  error_budget_value integer;
  failure_count_value bigint;
  changed_count integer;
  opened_value integer := 0;
  closed_value integer := 0;
BEGIN
  IF p_outcome NOT IN ('succeeded', 'failed', 'uncertain') THEN
    RAISE EXCEPTION 'invalid publication execution outcome' USING ERRCODE = '22023';
  END IF;
  IF p_outcome <> 'succeeded' AND (p_error_code IS NULL OR length(trim(p_error_code)) = 0) THEN
    RAISE EXCEPTION 'failed or uncertain execution requires an error code' USING ERRCODE = '22023';
  END IF;

  -- A timed-out probe recovery already holds its circuit before it retires the
  -- old attempt and job. Lock the same circuit first so a late finisher cannot
  -- hold the old job while waiting on that circuit and reverse the lock order.
  PERFORM circuit.id
  FROM geo.circuit_breakers AS circuit
  WHERE circuit.tenant_id = tenant_value
    AND circuit.probe_attempt_id = p_attempt_id
  ORDER BY circuit.scope_type, circuit.scope_key
  FOR UPDATE OF circuit;

  SELECT job.*, content_item.campaign_id AS scope_campaign_id,
         content_item.topic_key AS scope_topic_key
  INTO job_row
  FROM geo.publication_jobs AS job
  JOIN geo.publication_variants AS variant
    ON variant.tenant_id = job.tenant_id AND variant.id = job.variant_id
  JOIN geo.content_versions AS content_version
    ON content_version.tenant_id = variant.tenant_id
   AND content_version.id = variant.content_version_id
  JOIN geo.content_items AS content_item
    ON content_item.tenant_id = content_version.tenant_id
   AND content_item.id = content_version.content_item_id
  WHERE job.tenant_id = tenant_value AND job.id = p_job_id
  FOR UPDATE OF job;

  IF job_row.id IS NULL THEN
    RAISE EXCEPTION 'publication job was not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO attempt_row
  FROM geo.publication_attempts AS attempt
  WHERE attempt.tenant_id = tenant_value
    AND attempt.id = p_attempt_id
    AND attempt.job_id = p_job_id
  FOR UPDATE;

  IF attempt_row.id IS NULL THEN
    RAISE EXCEPTION 'publication execution attempt was not found' USING ERRCODE = 'P0002';
  END IF;
  IF job_row.state = 'cancelled' THEN
    RAISE EXCEPTION 'cancelled publication job cannot finish an execution attempt'
      USING ERRCODE = '55000';
  END IF;
  IF attempt_row.governance_finished_at IS NOT NULL THEN
    IF attempt_row.state <> p_outcome THEN
      RAISE EXCEPTION 'publication execution attempt already finished as %', attempt_row.state
        USING ERRCODE = '55000';
    END IF;
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;
  IF attempt_row.state <> 'started' THEN
    RAISE EXCEPTION 'publication execution attempt is not active' USING ERRCODE = '55000';
  END IF;

  UPDATE geo.publication_attempts AS attempt
  SET state = p_outcome,
      error_code = CASE WHEN p_outcome = 'succeeded' THEN NULL ELSE left(trim(p_error_code), 200) END,
      finished_at = now_value,
      governance_finished_at = now_value
  WHERE attempt.tenant_id = tenant_value AND attempt.id = p_attempt_id;

  UPDATE geo.publication_jobs AS job
  SET lease_owner = NULL,
      lease_expires_at = NULL
  WHERE job.tenant_id = tenant_value
    AND job.id = p_job_id
    AND job.lease_owner = attempt_row.worker_id;

  IF attempt_row.half_open_probe AND p_outcome = 'succeeded' THEN
    WITH changed AS (
      UPDATE geo.circuit_breakers AS circuit
      SET state = 'closed',
          failure_count = 0,
          opened_at = NULL,
          retry_at = NULL,
          reason = 'half-open publication probe succeeded',
          probe_attempt_id = NULL,
          probe_started_at = NULL,
          updated_at = now_value
      WHERE circuit.tenant_id = tenant_value
        AND circuit.probe_attempt_id = p_attempt_id
      RETURNING 1
    )
    SELECT count(*)::integer INTO closed_value FROM changed;
  ELSIF attempt_row.half_open_probe THEN
    WITH changed AS (
      UPDATE geo.circuit_breakers AS circuit
      SET state = 'open',
          failure_count = circuit.failure_count + 1,
          opened_at = now_value,
          retry_at = now_value + make_interval(secs => COALESCE((
            SELECT CASE
              WHEN jsonb_typeof(control.quota -> 'cooldownSeconds') = 'number'
               AND (control.quota ->> 'cooldownSeconds') ~ '^[0-9]{1,9}$'
              THEN (control.quota ->> 'cooldownSeconds')::integer
              ELSE 300
            END
            FROM geo.automation_controls AS control
            WHERE control.tenant_id = circuit.tenant_id
              AND control.scope_type = circuit.scope_type
              AND control.scope_key = circuit.scope_key
            LIMIT 1
          ), 300)),
          reason = 'half-open publication probe ' || p_outcome || ': ' || left(trim(p_error_code), 200),
          probe_attempt_id = NULL,
          probe_started_at = NULL,
          updated_at = now_value
      WHERE circuit.tenant_id = tenant_value
        AND circuit.probe_attempt_id = p_attempt_id
      RETURNING 1
    )
    SELECT count(*)::integer INTO opened_value FROM changed;
  ELSIF p_outcome IN ('failed', 'uncertain') THEN
    FOR control_row IN
      SELECT control.*
      FROM geo.automation_controls AS control
      WHERE control.tenant_id = tenant_value
        AND control.quota ? 'errorBudget'
        AND (
          (control.scope_type = 'tenant' AND control.scope_key = '*')
          OR (control.scope_type = 'platform' AND control.scope_key = job_row.platform)
          OR (control.scope_type = 'account' AND control.scope_key = job_row.channel_account_id::text)
          OR (control.scope_type = 'campaign' AND control.scope_key = job_row.scope_campaign_id::text)
          OR (control.scope_type = 'topic' AND control.scope_key = job_row.scope_topic_key)
        )
      ORDER BY control.scope_type, control.scope_key
      FOR UPDATE OF control
    LOOP
      IF jsonb_typeof(control_row.quota -> 'errorBudget') <> 'number'
         OR (control_row.quota ->> 'errorBudget') !~ '^[0-9]{1,9}$' THEN
        RAISE EXCEPTION 'invalid errorBudget quota for %:%',
          control_row.scope_type, control_row.scope_key USING ERRCODE = '22023';
      END IF;
      error_budget_value := (control_row.quota ->> 'errorBudget')::integer;
      cooldown_value := CASE
        WHEN jsonb_typeof(control_row.quota -> 'cooldownSeconds') = 'number'
         AND (control_row.quota ->> 'cooldownSeconds') ~ '^[0-9]{1,9}$'
        THEN (control_row.quota ->> 'cooldownSeconds')::integer
        ELSE 300
      END;

      SELECT count(*) INTO failure_count_value
      FROM geo.publication_attempts AS prior_attempt
      JOIN geo.publication_jobs AS prior_job
        ON prior_job.tenant_id = prior_attempt.tenant_id AND prior_job.id = prior_attempt.job_id
      JOIN geo.publication_variants AS prior_variant
        ON prior_variant.tenant_id = prior_job.tenant_id AND prior_variant.id = prior_job.variant_id
      JOIN geo.content_versions AS prior_version
        ON prior_version.tenant_id = prior_variant.tenant_id
       AND prior_version.id = prior_variant.content_version_id
      JOIN geo.content_items AS prior_item
        ON prior_item.tenant_id = prior_version.tenant_id
       AND prior_item.id = prior_version.content_item_id
      WHERE prior_attempt.tenant_id = tenant_value
        AND prior_attempt.state IN ('failed', 'uncertain')
        AND prior_attempt.started_at >= now_value - interval '1 day'
        AND (
          control_row.scope_type = 'tenant'
          OR (control_row.scope_type = 'platform' AND prior_job.platform = control_row.scope_key)
          OR (control_row.scope_type = 'account' AND prior_job.channel_account_id::text = control_row.scope_key)
          OR (control_row.scope_type = 'campaign' AND prior_item.campaign_id::text = control_row.scope_key)
          OR (control_row.scope_type = 'topic' AND prior_item.topic_key = control_row.scope_key)
        );

      IF failure_count_value > error_budget_value THEN
        INSERT INTO geo.circuit_breakers (
          tenant_id, scope_type, scope_key, state, failure_count,
          opened_at, retry_at, reason, updated_at
        ) VALUES (
          tenant_value, control_row.scope_type, control_row.scope_key, 'open',
          failure_count_value::integer, now_value,
          now_value + make_interval(secs => cooldown_value),
          'publication error budget exceeded: ' || left(trim(p_error_code), 200), now_value
        )
        ON CONFLICT (tenant_id, scope_type, scope_key) DO UPDATE SET
          state = 'open',
          failure_count = EXCLUDED.failure_count,
          opened_at = EXCLUDED.opened_at,
          retry_at = EXCLUDED.retry_at,
          reason = EXCLUDED.reason,
          probe_attempt_id = NULL,
          probe_started_at = NULL,
          updated_at = EXCLUDED.updated_at;
        GET DIAGNOSTICS changed_count = ROW_COUNT;
        opened_value := opened_value + changed_count;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_execution.finished',
    'publication_job', p_job_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), 'execution:' || p_attempt_id::text),
    job_row.request_hash,
    jsonb_build_object(
      'attemptId', p_attempt_id,
      'workerId', attempt_row.worker_id,
      'outcome', p_outcome,
      'errorCode', p_error_code,
      'halfOpenProbe', attempt_row.half_open_probe,
      'circuitsOpened', opened_value,
      'circuitsClosed', closed_value
    )
  );

  RETURN QUERY SELECT opened_value, closed_value;
END
$$;

CREATE OR REPLACE FUNCTION geo.finish_publication_execution(
  p_job_id uuid,
  p_attempt_id uuid,
  p_succeeded boolean,
  p_error_code text
)
RETURNS TABLE (
  circuits_opened integer,
  circuits_closed integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
  SELECT *
  FROM geo.finish_publication_execution(
    p_job_id,
    p_attempt_id,
    CASE WHEN p_succeeded THEN 'succeeded' ELSE 'failed' END::text,
    p_error_code
  )
$$;

REVOKE ALL ON TABLE geo.publication_readbacks FROM PUBLIC, geo_dispatcher, geo_runtime;
GRANT SELECT ON geo.publication_readbacks TO geo_runtime;
GRANT UPDATE (status, completed_at, last_error) ON geo.publication_readbacks TO geo_runtime;
REVOKE INSERT, DELETE ON geo.publication_readbacks FROM geo_runtime;
REVOKE DELETE ON geo.publication_attempts FROM geo_runtime;

REVOKE ALL ON FUNCTION geo.consume_publication_grant(uuid, geo.sha256_hex, text, geo.sha256_hex, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.consume_publication_grant(uuid, geo.sha256_hex, text, geo.sha256_hex, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.revoke_publication_grant(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.cancel_publication_job(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.schedule_publication_readback(uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.acquire_publication_execution(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.finish_publication_execution(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.finish_publication_execution(uuid, uuid, boolean, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION geo.consume_publication_grant(uuid, geo.sha256_hex, text, geo.sha256_hex, text, timestamptz) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.consume_publication_grant(uuid, geo.sha256_hex, text, geo.sha256_hex, text) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.revoke_publication_grant(uuid, text) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.cancel_publication_job(uuid, text) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.schedule_publication_readback(uuid, uuid, timestamptz) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.acquire_publication_execution(uuid, uuid, text) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.finish_publication_execution(uuid, uuid, text, text) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.finish_publication_execution(uuid, uuid, boolean, text) TO geo_runtime;
