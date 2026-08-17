UPDATE geo.tenant_memberships AS membership
SET capabilities = membership.capabilities || '["automation:execute"]'::jsonb
WHERE membership.role IN ('owner', 'admin')
  AND membership.capabilities @> '["automation:manage"]'::jsonb
  AND NOT membership.capabilities @> '["automation:execute"]'::jsonb;

CREATE TABLE geo.automation_batches (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash geo.sha256_hex NOT NULL,
  state text NOT NULL DEFAULT 'scheduled'
    CHECK (state IN ('scheduled', 'running', 'completed', 'partially_failed', 'cancelled')),
  execution_level text NOT NULL DEFAULT 'dry_run' CHECK (execution_level = 'dry_run'),
  scheduled_for timestamptz NOT NULL DEFAULT clock_timestamp(),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(configuration) = 'object'),
  created_by_actor_id uuid NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by_actor_id uuid,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, campaign_id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, campaign_id)
    REFERENCES geo.campaigns (tenant_id, id) ON DELETE RESTRICT,
  CHECK (started_at IS NULL OR started_at >= created_at),
  CHECK (completed_at IS NULL OR completed_at >= created_at),
  CHECK (
    (state IN ('completed', 'partially_failed')) = (completed_at IS NOT NULL)
  ),
  CHECK (
    (state = 'cancelled') =
    (cancelled_at IS NOT NULL AND cancelled_by_actor_id IS NOT NULL AND
     cancellation_reason IS NOT NULL AND length(trim(cancellation_reason)) > 0)
  )
);

CREATE INDEX automation_batches_schedule
  ON geo.automation_batches (tenant_id, scheduled_for, id)
  WHERE state = 'scheduled';

CREATE INDEX automation_batches_campaign_state
  ON geo.automation_batches (tenant_id, campaign_id, state, created_at DESC);

CREATE TABLE geo.automation_runs (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  slot_key text NOT NULL CHECK (length(trim(slot_key)) BETWEEN 1 AND 200),
  topic_key text NOT NULL CHECK (length(trim(topic_key)) BETWEEN 1 AND 300),
  brief jsonb NOT NULL CHECK (jsonb_typeof(brief) = 'object'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash geo.sha256_hex NOT NULL,
  state text NOT NULL DEFAULT 'scheduled'
    CHECK (state IN (
      'scheduled', 'running', 'retry_wait', 'awaiting_delivery', 'completed',
      'partially_failed', 'blocked', 'failed', 'cancelled'
    )),
  stage text NOT NULL DEFAULT 'planning'
    CHECK (stage IN ('planning', 'draft', 'targets', 'delivery')),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 100),
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(checkpoint) = 'object'),
  content_item_id uuid,
  content_version_id uuid,
  last_error_code text,
  last_error_message text,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by_actor_id uuid,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, batch_id, campaign_id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, batch_id, slot_key),
  FOREIGN KEY (tenant_id, batch_id, campaign_id)
    REFERENCES geo.automation_batches (tenant_id, id, campaign_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, campaign_id)
    REFERENCES geo.campaigns (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, content_item_id)
    REFERENCES geo.content_items (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, content_version_id)
    REFERENCES geo.content_versions (tenant_id, id) ON DELETE RESTRICT,
  CHECK (attempt_count <= max_attempts),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 200),
  CHECK (state = 'running' OR (lease_owner IS NULL AND lease_expires_at IS NULL)),
  CHECK (content_version_id IS NULL OR content_item_id IS NOT NULL),
  CHECK (
    (state IN ('completed', 'partially_failed', 'blocked', 'failed')) =
    (completed_at IS NOT NULL)
  ),
  CHECK (
    (state = 'cancelled') =
    (cancelled_at IS NOT NULL AND cancelled_by_actor_id IS NOT NULL AND
     cancellation_reason IS NOT NULL AND length(trim(cancellation_reason)) > 0)
  )
);

CREATE INDEX automation_runs_claim
  ON geo.automation_runs (tenant_id, available_at, id)
  WHERE state IN ('scheduled', 'retry_wait', 'awaiting_delivery');

CREATE INDEX automation_runs_expired_lease
  ON geo.automation_runs (tenant_id, lease_expires_at, id)
  WHERE state = 'running';

CREATE INDEX automation_runs_batch_state
  ON geo.automation_runs (tenant_id, batch_id, state, id);

CREATE TABLE geo.automation_run_targets (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('toutiao', 'sohu', 'ctrip_community')),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN (
      'pending', 'variant_ready', 'audit_failed', 'awaiting_delivery',
      'preview_completed', 'confirmed', 'blocked', 'failed', 'cancelled'
    )),
  variant_id uuid,
  audit_run_id uuid,
  audit_artifact_id uuid,
  publication_job_id uuid,
  variant_idempotency_key text NOT NULL
    CHECK (length(variant_idempotency_key) BETWEEN 1 AND 200),
  audit_idempotency_key text NOT NULL
    CHECK (length(audit_idempotency_key) BETWEEN 1 AND 200),
  publication_idempotency_key text NOT NULL
    CHECK (length(publication_idempotency_key) BETWEEN 1 AND 200),
  last_error_code text,
  last_error_message text,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, run_id, channel_account_id),
  UNIQUE (tenant_id, variant_idempotency_key),
  UNIQUE (tenant_id, audit_idempotency_key),
  UNIQUE (tenant_id, publication_idempotency_key),
  FOREIGN KEY (tenant_id, run_id)
    REFERENCES geo.automation_runs (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, channel_account_id, platform)
    REFERENCES geo.channel_accounts (tenant_id, id, platform) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, variant_id)
    REFERENCES geo.publication_variants (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, audit_run_id)
    REFERENCES geo.audit_runs (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, audit_artifact_id)
    REFERENCES geo.audit_artifacts (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, publication_job_id)
    REFERENCES geo.publication_jobs (tenant_id, id) ON DELETE RESTRICT,
  CHECK (
    state NOT IN ('variant_ready', 'audit_failed', 'awaiting_delivery',
                  'preview_completed', 'confirmed') OR
    variant_id IS NOT NULL
  ),
  CHECK (audit_artifact_id IS NULL OR audit_run_id IS NOT NULL),
  CHECK (publication_job_id IS NULL OR audit_artifact_id IS NOT NULL),
  CHECK (
    state NOT IN ('awaiting_delivery', 'preview_completed', 'confirmed') OR
    publication_job_id IS NOT NULL
  ),
  CHECK (
    (state IN ('preview_completed', 'confirmed', 'audit_failed', 'blocked', 'failed')) =
    (completed_at IS NOT NULL)
  ),
  CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL))
);

CREATE INDEX automation_run_targets_run_state
  ON geo.automation_run_targets (tenant_id, run_id, state, id);

CREATE INDEX automation_run_targets_delivery
  ON geo.automation_run_targets (tenant_id, publication_job_id, id)
  WHERE state = 'awaiting_delivery';

CREATE OR REPLACE FUNCTION geo.validate_automation_batch_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF NEW.state <> 'scheduled' OR NEW.execution_level <> 'dry_run' OR
     NEW.started_at IS NOT NULL OR NEW.completed_at IS NOT NULL OR
     NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by_actor_id IS NOT NULL OR
     NEW.cancellation_reason IS NOT NULL THEN
    RAISE EXCEPTION 'automation batches must be inserted as unsullied scheduled dry runs'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION geo.validate_automation_run_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF NEW.state <> 'scheduled' OR NEW.stage <> 'planning' OR NEW.attempt_count <> 0 OR
     NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL OR
     NEW.heartbeat_at IS NOT NULL OR NEW.content_item_id IS NOT NULL OR
     NEW.content_version_id IS NOT NULL OR NEW.last_error_code IS NOT NULL OR
     NEW.last_error_message IS NOT NULL OR NEW.completed_at IS NOT NULL OR
     NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by_actor_id IS NOT NULL OR
     NEW.cancellation_reason IS NOT NULL OR NOT EXISTS (
       SELECT 1
       FROM geo.automation_batches AS batch
       WHERE batch.tenant_id = NEW.tenant_id
         AND batch.id = NEW.batch_id
         AND batch.campaign_id = NEW.campaign_id
         AND batch.state = 'scheduled'
         AND batch.execution_level = 'dry_run'
     ) THEN
    RAISE EXCEPTION 'automation runs must start clean inside a scheduled dry-run batch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION geo.validate_automation_target_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF NEW.state <> 'pending' OR NEW.variant_id IS NOT NULL OR NEW.audit_run_id IS NOT NULL OR
     NEW.audit_artifact_id IS NOT NULL OR NEW.publication_job_id IS NOT NULL OR
     NEW.last_error_code IS NOT NULL OR NEW.last_error_message IS NOT NULL OR
     NEW.completed_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NOT EXISTS (
       SELECT 1
       FROM geo.automation_runs AS run
       WHERE run.tenant_id = NEW.tenant_id
         AND run.id = NEW.run_id
         AND run.state = 'scheduled'
         AND run.stage = 'planning'
     ) THEN
    RAISE EXCEPTION 'automation targets must start pending inside a scheduled run'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER automation_batches_validate_insert
BEFORE INSERT ON geo.automation_batches
FOR EACH ROW EXECUTE FUNCTION geo.validate_automation_batch_insert();

CREATE TRIGGER automation_runs_validate_insert
BEFORE INSERT ON geo.automation_runs
FOR EACH ROW EXECUTE FUNCTION geo.validate_automation_run_insert();

CREATE TRIGGER automation_run_targets_validate_insert
BEFORE INSERT ON geo.automation_run_targets
FOR EACH ROW EXECUTE FUNCTION geo.validate_automation_target_insert();

CREATE TRIGGER automation_batches_set_updated_at
BEFORE UPDATE ON geo.automation_batches
FOR EACH ROW EXECUTE FUNCTION geo.set_updated_at();

CREATE TRIGGER automation_runs_set_updated_at
BEFORE UPDATE ON geo.automation_runs
FOR EACH ROW EXECUTE FUNCTION geo.set_updated_at();

CREATE TRIGGER automation_run_targets_set_updated_at
BEFORE UPDATE ON geo.automation_run_targets
FOR EACH ROW EXECUTE FUNCTION geo.set_updated_at();

ALTER TABLE geo.automation_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.automation_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON geo.automation_batches TO geo_runtime
  USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

ALTER TABLE geo.automation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.automation_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON geo.automation_runs TO geo_runtime
  USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

ALTER TABLE geo.automation_run_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.automation_run_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON geo.automation_run_targets TO geo_runtime
  USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

CREATE OR REPLACE FUNCTION geo.automation_run_block_reason(
  p_campaign_id uuid,
  p_topic_key text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  blocked_scope record;
BEGIN
  IF p_campaign_id IS NULL OR p_topic_key IS NULL OR length(trim(p_topic_key)) = 0 THEN
    RETURN 'invalid_run_scope';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM geo.automation_controls AS control
    WHERE control.tenant_id = tenant_value
      AND control.scope_type = 'tenant'
      AND control.scope_key = '*'
  ) THEN
    RETURN 'control_missing:tenant:*';
  END IF;

  SELECT control.scope_type, control.scope_key, control.kill_switch_enabled, control.mode
  INTO blocked_scope
  FROM geo.automation_controls AS control
  WHERE control.tenant_id = tenant_value
    AND (
      (control.scope_type = 'tenant' AND control.scope_key = '*') OR
      (control.scope_type = 'campaign' AND control.scope_key = p_campaign_id::text) OR
      (control.scope_type = 'topic' AND control.scope_key = p_topic_key)
    )
    AND (control.kill_switch_enabled OR control.mode IN ('paused', 'stopped'))
  ORDER BY
    CASE control.scope_type WHEN 'tenant' THEN 1 WHEN 'campaign' THEN 2 ELSE 3 END,
    control.scope_key
  LIMIT 1;

  IF FOUND THEN
    IF blocked_scope.kill_switch_enabled THEN
      RETURN 'kill_switch:' || blocked_scope.scope_type || ':' || blocked_scope.scope_key;
    END IF;
    RETURN 'control_' || blocked_scope.mode || ':' || blocked_scope.scope_type || ':' ||
      blocked_scope.scope_key;
  END IF;

  SELECT breaker.scope_type, breaker.scope_key, breaker.state
  INTO blocked_scope
  FROM geo.circuit_breakers AS breaker
  WHERE breaker.tenant_id = tenant_value
    AND breaker.state IN ('open', 'half_open')
    AND (
      (breaker.scope_type = 'tenant' AND breaker.scope_key = '*') OR
      (breaker.scope_type = 'campaign' AND breaker.scope_key = p_campaign_id::text) OR
      (breaker.scope_type = 'topic' AND breaker.scope_key = p_topic_key)
    )
  ORDER BY
    CASE breaker.scope_type WHEN 'tenant' THEN 1 WHEN 'campaign' THEN 2 ELSE 3 END,
    breaker.scope_key
  LIMIT 1;

  IF FOUND THEN
    RETURN 'circuit_' || blocked_scope.state || ':' || blocked_scope.scope_type || ':' ||
      blocked_scope.scope_key;
  END IF;

  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION geo.refresh_automation_batch_state(p_batch_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  batch_row geo.automation_batches%ROWTYPE;
  total_count integer;
  active_count integer;
  completed_count integer;
  next_state text;
BEGIN
  SELECT * INTO batch_row
  FROM geo.automation_batches AS batch
  WHERE batch.tenant_id = tenant_value AND batch.id = p_batch_id
  FOR UPDATE;

  IF batch_row.id IS NULL THEN
    RAISE EXCEPTION 'automation batch was not found' USING ERRCODE = 'P0002';
  END IF;
  IF batch_row.state = 'cancelled' THEN
    RETURN batch_row.state;
  END IF;

  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE run.state IN ('scheduled', 'running', 'retry_wait', 'awaiting_delivery')
         )::integer,
         count(*) FILTER (WHERE run.state = 'completed')::integer
  INTO total_count, active_count, completed_count
  FROM geo.automation_runs AS run
  WHERE run.tenant_id = tenant_value AND run.batch_id = p_batch_id;

  IF total_count = 0 THEN
    RETURN batch_row.state;
  ELSIF active_count > 0 THEN
    next_state := 'running';
  ELSIF completed_count = total_count THEN
    next_state := 'completed';
  ELSE
    next_state := 'partially_failed';
  END IF;

  UPDATE geo.automation_batches AS batch
  SET state = next_state,
      started_at = CASE
        WHEN next_state = 'running' THEN COALESCE(batch.started_at, clock_timestamp())
        ELSE batch.started_at
      END,
      completed_at = CASE
        WHEN next_state IN ('completed', 'partially_failed')
          THEN COALESCE(batch.completed_at, clock_timestamp())
        ELSE NULL
      END
  WHERE batch.tenant_id = tenant_value AND batch.id = p_batch_id;

  RETURN next_state;
END
$$;

CREATE OR REPLACE FUNCTION geo.claim_automation_runs(
  p_worker_id text,
  p_limit integer DEFAULT 1,
  p_lease_seconds integer DEFAULT 60
)
RETURNS SETOF geo.automation_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  exhausted_batch_ids uuid[];
  exhausted_batch_id uuid;
BEGIN
  PERFORM geo.require_actor_id();
  IF p_worker_id IS NULL OR length(p_worker_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'worker id must contain 1 to 200 characters' USING ERRCODE = '22023';
  END IF;
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'claim limit must be between 1 and 100' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds NOT BETWEEN 10 AND 3600 THEN
    RAISE EXCEPTION 'lease seconds must be between 10 and 3600' USING ERRCODE = '22023';
  END IF;

  -- Claims share this tenant lock; cancellation takes it exclusively.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('automation:' || tenant_value::text, 0));

  WITH exhausted AS (
    UPDATE geo.automation_runs AS run
    SET state = 'failed',
        lease_owner = NULL,
        lease_expires_at = NULL,
        completed_at = clock_timestamp(),
        last_error_code = 'AUTOMATION_MAX_ATTEMPTS_EXCEEDED',
        last_error_message = 'The previous worker lease expired after the final allowed attempt'
    WHERE run.tenant_id = tenant_value
      AND run.attempt_count >= run.max_attempts
      AND (
        (run.state = 'running' AND run.lease_expires_at < statement_timestamp()) OR
        (run.state IN ('retry_wait', 'awaiting_delivery') AND
         run.available_at <= statement_timestamp())
      )
    RETURNING run.id, run.batch_id
  ), failed_targets AS (
    UPDATE geo.automation_run_targets AS target
    SET state = 'failed',
        completed_at = clock_timestamp(),
        last_error_code = 'AUTOMATION_MAX_ATTEMPTS_EXCEEDED',
        last_error_message = 'Parent automation run exhausted its attempts'
    WHERE target.tenant_id = tenant_value
      AND target.run_id IN (SELECT exhausted.id FROM exhausted)
      AND target.state IN ('pending', 'variant_ready', 'awaiting_delivery')
    RETURNING target.id
  )
  SELECT array_agg(DISTINCT exhausted.batch_id)
  INTO exhausted_batch_ids
  FROM exhausted
  CROSS JOIN (SELECT count(*) FROM failed_targets) AS target_update;

  IF exhausted_batch_ids IS NOT NULL THEN
    FOREACH exhausted_batch_id IN ARRAY exhausted_batch_ids LOOP
      PERFORM geo.refresh_automation_batch_state(exhausted_batch_id);
    END LOOP;
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT run.id
    FROM geo.automation_runs AS run
    JOIN geo.automation_batches AS batch
      ON batch.tenant_id = run.tenant_id
     AND batch.id = run.batch_id
     AND batch.campaign_id = run.campaign_id
    JOIN geo.campaigns AS campaign
      ON campaign.tenant_id = run.tenant_id
     AND campaign.id = run.campaign_id
    JOIN geo.tenants AS tenant
      ON tenant.id = run.tenant_id
    WHERE run.tenant_id = tenant_value
      AND tenant.status = 'active'
      AND campaign.status = 'active'
      AND batch.state IN ('scheduled', 'running')
      AND batch.execution_level = 'dry_run'
      AND batch.scheduled_for <= statement_timestamp()
      AND run.attempt_count < run.max_attempts
      AND (
        (run.state IN ('scheduled', 'retry_wait', 'awaiting_delivery') AND
         run.available_at <= statement_timestamp()) OR
        (run.state = 'running' AND
         run.lease_expires_at < statement_timestamp() AND
         run.attempt_count < run.max_attempts)
      )
      AND geo.automation_run_block_reason(run.campaign_id, run.topic_key) IS NULL
    ORDER BY run.available_at, run.id
    FOR UPDATE OF run SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE geo.automation_runs AS run
    SET state = 'running',
        attempt_count = run.attempt_count + 1,
        lease_owner = p_worker_id,
        lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
        heartbeat_at = clock_timestamp(),
        last_error_code = NULL,
        last_error_message = NULL
    FROM candidate
    WHERE run.tenant_id = tenant_value AND run.id = candidate.id
    RETURNING run.*
  ), started_batches AS (
    UPDATE geo.automation_batches AS batch
    SET state = 'running',
        started_at = COALESCE(batch.started_at, clock_timestamp())
    WHERE batch.tenant_id = tenant_value
      AND batch.state = 'scheduled'
      AND batch.id IN (SELECT claimed.batch_id FROM claimed)
    RETURNING batch.id
  )
  SELECT claimed.*
  FROM claimed
  CROSS JOIN (SELECT count(*) FROM started_batches) AS ensured
  ORDER BY claimed.available_at, claimed.id;
END
$$;

CREATE OR REPLACE FUNCTION geo.heartbeat_automation_run(
  p_run_id uuid,
  p_worker_id text,
  p_attempt_count integer,
  p_stage text,
  p_checkpoint jsonb,
  p_lease_seconds integer DEFAULT 60
)
RETURNS TABLE (
  accepted boolean,
  reason text,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  run_row geo.automation_runs%ROWTYPE;
  block_reason text;
  stage_before integer;
  stage_after integer;
BEGIN
  PERFORM geo.require_actor_id();
  IF p_worker_id IS NULL OR length(p_worker_id) NOT BETWEEN 1 AND 200 OR
     p_attempt_count < 1 OR
     p_stage NOT IN ('planning', 'draft', 'targets', 'delivery') OR
     p_checkpoint IS NULL OR jsonb_typeof(p_checkpoint) <> 'object' OR
     p_lease_seconds NOT BETWEEN 10 AND 3600 THEN
    RAISE EXCEPTION 'invalid automation heartbeat arguments' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(hashtextextended('automation:' || tenant_value::text, 0));

  SELECT * INTO run_row
  FROM geo.automation_runs AS run
  WHERE run.tenant_id = tenant_value AND run.id = p_run_id
  FOR UPDATE;

  IF run_row.id IS NULL THEN
    RAISE EXCEPTION 'automation run was not found' USING ERRCODE = 'P0002';
  END IF;
  IF run_row.state <> 'running' THEN
    RETURN QUERY SELECT false, 'state_' || run_row.state, NULL::timestamptz;
    RETURN;
  END IF;
  IF run_row.lease_owner <> p_worker_id OR run_row.attempt_count <> p_attempt_count THEN
    RETURN QUERY SELECT false, 'lease_mismatch', run_row.lease_expires_at;
    RETURN;
  END IF;
  IF run_row.lease_expires_at < statement_timestamp() THEN
    UPDATE geo.automation_runs AS run
    SET state = 'retry_wait',
        available_at = clock_timestamp(),
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error_code = 'AUTOMATION_LEASE_EXPIRED',
        last_error_message = 'Heartbeat arrived after the worker lease expired'
    WHERE run.tenant_id = tenant_value AND run.id = p_run_id;
    RETURN QUERY SELECT false, 'lease_expired', NULL::timestamptz;
    RETURN;
  END IF;

  block_reason := geo.automation_run_block_reason(run_row.campaign_id, run_row.topic_key);
  IF block_reason IS NOT NULL THEN
    UPDATE geo.automation_runs AS run
    SET state = 'blocked',
        lease_owner = NULL,
        lease_expires_at = NULL,
        completed_at = clock_timestamp(),
        checkpoint = p_checkpoint,
        last_error_code = 'AUTOMATION_GOVERNANCE_BLOCKED',
        last_error_message = left(block_reason, 4000)
    WHERE run.tenant_id = tenant_value AND run.id = p_run_id;

    UPDATE geo.automation_run_targets AS target
    SET state = 'blocked',
        completed_at = clock_timestamp(),
        last_error_code = 'AUTOMATION_GOVERNANCE_BLOCKED',
        last_error_message = left(block_reason, 4000)
    WHERE target.tenant_id = tenant_value
      AND target.run_id = p_run_id
      AND target.state IN ('pending', 'variant_ready', 'awaiting_delivery');

    PERFORM geo.refresh_automation_batch_state(run_row.batch_id);
    RETURN QUERY SELECT false, block_reason, NULL::timestamptz;
    RETURN;
  END IF;

  stage_before := array_position(ARRAY['planning', 'draft', 'targets', 'delivery'], run_row.stage);
  stage_after := array_position(ARRAY['planning', 'draft', 'targets', 'delivery'], p_stage);
  IF stage_after <> stage_before THEN
    RAISE EXCEPTION 'heartbeat cannot change automation run stage; use a checkpoint function'
      USING ERRCODE = '55000';
  END IF;

  UPDATE geo.automation_runs AS run
  SET stage = p_stage,
      checkpoint = p_checkpoint,
      heartbeat_at = clock_timestamp(),
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
  WHERE run.tenant_id = tenant_value AND run.id = p_run_id
  RETURNING run.lease_expires_at INTO run_row.lease_expires_at;

  RETURN QUERY SELECT true, 'accepted', run_row.lease_expires_at;
END
$$;

CREATE OR REPLACE FUNCTION geo.checkpoint_automation_draft(
  p_run_id uuid,
  p_worker_id text,
  p_attempt_count integer,
  p_content_item_id uuid,
  p_content_version_id uuid,
  p_checkpoint jsonb,
  p_lease_seconds integer DEFAULT 60
)
RETURNS TABLE (
  accepted boolean,
  reason text,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  run_row geo.automation_runs%ROWTYPE;
  block_reason text;
  lease_value timestamptz;
BEGIN
  PERFORM geo.require_actor_id();
  IF p_worker_id IS NULL OR length(p_worker_id) NOT BETWEEN 1 AND 200 OR
     p_attempt_count < 1 OR p_content_item_id IS NULL OR p_content_version_id IS NULL OR
     p_checkpoint IS NULL OR jsonb_typeof(p_checkpoint) <> 'object' OR
     p_lease_seconds NOT BETWEEN 10 AND 3600 THEN
    RAISE EXCEPTION 'invalid automation draft checkpoint arguments' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(hashtextextended('automation:' || tenant_value::text, 0));

  SELECT * INTO run_row
  FROM geo.automation_runs AS run
  WHERE run.tenant_id = tenant_value AND run.id = p_run_id
  FOR UPDATE;

  IF run_row.id IS NULL THEN
    RAISE EXCEPTION 'automation run was not found' USING ERRCODE = 'P0002';
  END IF;
  IF run_row.state <> 'running' THEN
    RETURN QUERY SELECT false, 'state_' || run_row.state, NULL::timestamptz;
    RETURN;
  END IF;
  IF run_row.lease_owner <> p_worker_id OR run_row.attempt_count <> p_attempt_count THEN
    RETURN QUERY SELECT false, 'lease_mismatch', run_row.lease_expires_at;
    RETURN;
  END IF;
  IF run_row.lease_expires_at < statement_timestamp() THEN
    UPDATE geo.automation_runs AS run
    SET state = 'retry_wait', available_at = clock_timestamp(),
        lease_owner = NULL, lease_expires_at = NULL,
        last_error_code = 'AUTOMATION_LEASE_EXPIRED',
        last_error_message = 'Draft checkpoint arrived after the worker lease expired'
    WHERE run.tenant_id = tenant_value AND run.id = p_run_id;
    RETURN QUERY SELECT false, 'lease_expired', NULL::timestamptz;
    RETURN;
  END IF;

  block_reason := geo.automation_run_block_reason(run_row.campaign_id, run_row.topic_key);
  IF block_reason IS NOT NULL THEN
    UPDATE geo.automation_runs AS run
    SET state = 'blocked', lease_owner = NULL, lease_expires_at = NULL,
        completed_at = clock_timestamp(), checkpoint = p_checkpoint,
        last_error_code = 'AUTOMATION_GOVERNANCE_BLOCKED',
        last_error_message = left(block_reason, 4000)
    WHERE run.tenant_id = tenant_value AND run.id = p_run_id;
    UPDATE geo.automation_run_targets AS target
    SET state = 'blocked', completed_at = clock_timestamp(),
        last_error_code = 'AUTOMATION_GOVERNANCE_BLOCKED',
        last_error_message = left(block_reason, 4000)
    WHERE target.tenant_id = tenant_value AND target.run_id = p_run_id
      AND target.state IN ('pending', 'variant_ready', 'awaiting_delivery');
    PERFORM geo.refresh_automation_batch_state(run_row.batch_id);
    RETURN QUERY SELECT false, block_reason, NULL::timestamptz;
    RETURN;
  END IF;

  IF run_row.stage NOT IN ('planning', 'draft') THEN
    RAISE EXCEPTION 'draft checkpoint cannot follow stage %', run_row.stage
      USING ERRCODE = '55000';
  END IF;
  IF (run_row.content_item_id IS NOT NULL AND run_row.content_item_id <> p_content_item_id) OR
     (run_row.content_version_id IS NOT NULL AND
      run_row.content_version_id <> p_content_version_id) THEN
    RAISE EXCEPTION 'draft checkpoint conflicts with previously bound content'
      USING ERRCODE = '23505';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM geo.content_items AS item
    JOIN geo.content_versions AS version
      ON version.tenant_id = item.tenant_id
     AND version.content_item_id = item.id
    WHERE item.tenant_id = tenant_value
      AND item.id = p_content_item_id
      AND item.campaign_id = run_row.campaign_id
      AND version.id = p_content_version_id
  ) THEN
    RAISE EXCEPTION 'draft content is absent, cross-tenant, or outside the run campaign'
      USING ERRCODE = '23503';
  END IF;

  UPDATE geo.automation_runs AS run
  SET stage = 'draft',
      content_item_id = p_content_item_id,
      content_version_id = p_content_version_id,
      checkpoint = p_checkpoint,
      heartbeat_at = clock_timestamp(),
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
  WHERE run.tenant_id = tenant_value AND run.id = p_run_id
  RETURNING run.lease_expires_at INTO lease_value;

  RETURN QUERY SELECT true, 'accepted', lease_value;
END
$$;

CREATE OR REPLACE FUNCTION geo.checkpoint_automation_target(
  p_run_id uuid,
  p_target_id uuid,
  p_worker_id text,
  p_attempt_count integer,
  p_new_state text,
  p_variant_id uuid,
  p_audit_run_id uuid,
  p_audit_artifact_id uuid,
  p_publication_job_id uuid,
  p_error_code text,
  p_error_message text,
  p_checkpoint jsonb,
  p_lease_seconds integer DEFAULT 60
)
RETURNS TABLE (
  accepted boolean,
  reason text,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  run_row geo.automation_runs%ROWTYPE;
  target_row geo.automation_run_targets%ROWTYPE;
  block_reason text;
  variant_value uuid;
  audit_run_value uuid;
  audit_artifact_value uuid;
  publication_job_value uuid;
  lease_value timestamptz;
  transition_allowed boolean := false;
  stage_value text;
BEGIN
  PERFORM geo.require_actor_id();
  IF p_worker_id IS NULL OR length(p_worker_id) NOT BETWEEN 1 AND 200 OR
     p_attempt_count < 1 OR
     p_new_state NOT IN (
       'pending', 'variant_ready', 'audit_failed', 'awaiting_delivery',
       'preview_completed', 'confirmed', 'blocked', 'failed', 'cancelled'
     ) OR
     p_checkpoint IS NULL OR jsonb_typeof(p_checkpoint) <> 'object' OR
     p_lease_seconds NOT BETWEEN 10 AND 3600 THEN
    RAISE EXCEPTION 'invalid automation target checkpoint arguments' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(hashtextextended('automation:' || tenant_value::text, 0));

  SELECT * INTO run_row
  FROM geo.automation_runs AS run
  WHERE run.tenant_id = tenant_value AND run.id = p_run_id
  FOR UPDATE;

  IF run_row.id IS NULL THEN
    RAISE EXCEPTION 'automation run was not found' USING ERRCODE = 'P0002';
  END IF;
  IF run_row.state <> 'running' THEN
    RETURN QUERY SELECT false, 'state_' || run_row.state, NULL::timestamptz;
    RETURN;
  END IF;
  IF run_row.lease_owner <> p_worker_id OR run_row.attempt_count <> p_attempt_count THEN
    RETURN QUERY SELECT false, 'lease_mismatch', run_row.lease_expires_at;
    RETURN;
  END IF;
  IF run_row.lease_expires_at < statement_timestamp() THEN
    UPDATE geo.automation_runs AS run
    SET state = 'retry_wait', available_at = clock_timestamp(),
        lease_owner = NULL, lease_expires_at = NULL,
        last_error_code = 'AUTOMATION_LEASE_EXPIRED',
        last_error_message = 'Target checkpoint arrived after the worker lease expired'
    WHERE run.tenant_id = tenant_value AND run.id = p_run_id;
    RETURN QUERY SELECT false, 'lease_expired', NULL::timestamptz;
    RETURN;
  END IF;

  block_reason := geo.automation_run_block_reason(run_row.campaign_id, run_row.topic_key);
  IF block_reason IS NOT NULL THEN
    UPDATE geo.automation_runs AS run
    SET state = 'blocked', lease_owner = NULL, lease_expires_at = NULL,
        completed_at = clock_timestamp(), checkpoint = p_checkpoint,
        last_error_code = 'AUTOMATION_GOVERNANCE_BLOCKED',
        last_error_message = left(block_reason, 4000)
    WHERE run.tenant_id = tenant_value AND run.id = p_run_id;
    UPDATE geo.automation_run_targets AS target
    SET state = 'blocked', completed_at = clock_timestamp(),
        last_error_code = 'AUTOMATION_GOVERNANCE_BLOCKED',
        last_error_message = left(block_reason, 4000)
    WHERE target.tenant_id = tenant_value AND target.run_id = p_run_id
      AND target.state IN ('pending', 'variant_ready', 'awaiting_delivery');
    PERFORM geo.refresh_automation_batch_state(run_row.batch_id);
    RETURN QUERY SELECT false, block_reason, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT * INTO target_row
  FROM geo.automation_run_targets AS target
  WHERE target.tenant_id = tenant_value
    AND target.id = p_target_id
    AND target.run_id = p_run_id
  FOR UPDATE;

  IF target_row.id IS NULL THEN
    RAISE EXCEPTION 'automation target was not found for the run' USING ERRCODE = 'P0002';
  END IF;

  transition_allowed := target_row.state = p_new_state OR
    (target_row.state = 'pending' AND
     p_new_state IN ('variant_ready', 'blocked', 'failed', 'cancelled')) OR
    (target_row.state = 'variant_ready' AND
     p_new_state IN ('audit_failed', 'awaiting_delivery', 'blocked', 'failed', 'cancelled')) OR
    (target_row.state = 'awaiting_delivery' AND
     p_new_state IN ('preview_completed', 'confirmed', 'blocked', 'failed', 'cancelled'));
  IF NOT transition_allowed THEN
    RAISE EXCEPTION 'automation target transition % -> % is not allowed',
      target_row.state, p_new_state USING ERRCODE = '55000';
  END IF;

  IF (target_row.variant_id IS NOT NULL AND p_variant_id IS NOT NULL AND
      target_row.variant_id <> p_variant_id) OR
     (target_row.audit_run_id IS NOT NULL AND p_audit_run_id IS NOT NULL AND
      target_row.audit_run_id <> p_audit_run_id) OR
     (target_row.audit_artifact_id IS NOT NULL AND p_audit_artifact_id IS NOT NULL AND
      target_row.audit_artifact_id <> p_audit_artifact_id) OR
     (target_row.publication_job_id IS NOT NULL AND p_publication_job_id IS NOT NULL AND
      target_row.publication_job_id <> p_publication_job_id) THEN
    RAISE EXCEPTION 'automation target checkpoint conflicts with a previously bound resource'
      USING ERRCODE = '23505';
  END IF;

  variant_value := COALESCE(p_variant_id, target_row.variant_id);
  audit_run_value := COALESCE(p_audit_run_id, target_row.audit_run_id);
  audit_artifact_value := COALESCE(p_audit_artifact_id, target_row.audit_artifact_id);
  publication_job_value := COALESCE(p_publication_job_id, target_row.publication_job_id);

  IF variant_value IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM geo.publication_variants AS variant
    WHERE variant.tenant_id = tenant_value
      AND variant.id = variant_value
      AND variant.content_version_id = run_row.content_version_id
      AND variant.channel_account_id = target_row.channel_account_id
      AND variant.platform = target_row.platform
  ) THEN
    RAISE EXCEPTION 'automation target variant binding is invalid' USING ERRCODE = '23503';
  END IF;

  IF audit_artifact_value IS NOT NULL AND audit_run_value IS NULL THEN
    SELECT artifact.audit_run_id INTO audit_run_value
    FROM geo.audit_artifacts AS artifact
    WHERE artifact.tenant_id = tenant_value
      AND artifact.id = audit_artifact_value
      AND artifact.variant_id = variant_value
      AND artifact.channel_account_id = target_row.channel_account_id
      AND artifact.platform = target_row.platform;
    IF audit_run_value IS NULL THEN
      RAISE EXCEPTION 'automation target audit artifact binding is invalid'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  IF audit_run_value IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM geo.audit_runs AS audit_run
    WHERE audit_run.tenant_id = tenant_value
      AND audit_run.id = audit_run_value
      AND audit_run.variant_id = variant_value
  ) THEN
    RAISE EXCEPTION 'automation target audit run binding is invalid' USING ERRCODE = '23503';
  END IF;

  IF audit_artifact_value IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM geo.audit_artifacts AS artifact
    WHERE artifact.tenant_id = tenant_value
      AND artifact.id = audit_artifact_value
      AND artifact.audit_run_id = audit_run_value
      AND artifact.variant_id = variant_value
      AND artifact.channel_account_id = target_row.channel_account_id
      AND artifact.platform = target_row.platform
  ) THEN
    RAISE EXCEPTION 'automation target audit artifact binding is invalid' USING ERRCODE = '23503';
  END IF;

  IF publication_job_value IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM geo.publication_jobs AS job
    WHERE job.tenant_id = tenant_value
      AND job.id = publication_job_value
      AND job.variant_id = variant_value
      AND job.audit_artifact_id = audit_artifact_value
      AND job.channel_account_id = target_row.channel_account_id
      AND job.platform = target_row.platform
      AND job.execution_level = 'dry_run'
  ) THEN
    RAISE EXCEPTION 'automation target publication job binding is invalid' USING ERRCODE = '23503';
  END IF;

  IF p_new_state = 'variant_ready' AND variant_value IS NULL THEN
    RAISE EXCEPTION 'variant_ready requires a bound variant' USING ERRCODE = '23514';
  END IF;
  IF p_new_state = 'audit_failed' AND (
    audit_run_value IS NULL OR audit_artifact_value IS NULL OR NOT EXISTS (
      SELECT 1 FROM geo.audit_artifacts AS artifact
      WHERE artifact.tenant_id = tenant_value AND artifact.id = audit_artifact_value
        AND artifact.status IN ('failed', 'errored')
    )
  ) THEN
    RAISE EXCEPTION 'audit_failed requires a failed or errored audit artifact'
      USING ERRCODE = '23514';
  END IF;
  IF p_new_state IN ('awaiting_delivery', 'preview_completed', 'confirmed') AND (
    publication_job_value IS NULL OR NOT EXISTS (
      SELECT 1
      FROM geo.audit_artifacts AS artifact
      JOIN geo.publication_jobs AS job
        ON job.tenant_id = artifact.tenant_id
       AND job.audit_artifact_id = artifact.id
      WHERE artifact.tenant_id = tenant_value
        AND artifact.id = audit_artifact_value
        AND artifact.status = 'passed'
        AND job.id = publication_job_value
        AND (
          (p_new_state = 'preview_completed' AND job.state = 'preview_completed') OR
          (p_new_state = 'confirmed' AND job.state = 'confirmed') OR
          (p_new_state = 'awaiting_delivery' AND
           job.state IN ('queued', 'dispatching', 'retry_wait', 'uncertain', 'reconciling'))
        )
    )
  ) THEN
    RAISE EXCEPTION 'delivery checkpoint is not supported by the bound audit and job state'
      USING ERRCODE = '23514';
  END IF;
  IF p_new_state IN ('audit_failed', 'blocked', 'failed') AND
     (p_error_code IS NULL OR length(trim(p_error_code)) = 0) THEN
    RAISE EXCEPTION 'an error code is required for a failed target checkpoint'
      USING ERRCODE = '22023';
  END IF;

  UPDATE geo.automation_run_targets AS target
  SET state = p_new_state,
      variant_id = variant_value,
      audit_run_id = audit_run_value,
      audit_artifact_id = audit_artifact_value,
      publication_job_id = publication_job_value,
      last_error_code = CASE
        WHEN p_new_state IN ('audit_failed', 'blocked', 'failed', 'cancelled')
          THEN left(trim(p_error_code), 200)
        ELSE NULL
      END,
      last_error_message = CASE
        WHEN p_new_state IN ('audit_failed', 'blocked', 'failed', 'cancelled')
          THEN left(COALESCE(p_error_message, p_error_code), 4000)
        ELSE NULL
      END,
      completed_at = CASE
        WHEN p_new_state IN ('preview_completed', 'confirmed', 'audit_failed', 'blocked', 'failed')
          THEN COALESCE(target.completed_at, clock_timestamp())
        ELSE NULL
      END,
      cancelled_at = CASE
        WHEN p_new_state = 'cancelled' THEN COALESCE(target.cancelled_at, clock_timestamp())
        ELSE NULL
      END
  WHERE target.tenant_id = tenant_value AND target.id = p_target_id;

  stage_value := CASE
    WHEN p_new_state IN ('awaiting_delivery', 'preview_completed', 'confirmed') THEN 'delivery'
    WHEN run_row.stage IN ('planning', 'draft') THEN 'targets'
    ELSE run_row.stage
  END;
  UPDATE geo.automation_runs AS run
  SET stage = stage_value,
      checkpoint = p_checkpoint,
      heartbeat_at = clock_timestamp(),
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
  WHERE run.tenant_id = tenant_value AND run.id = p_run_id
  RETURNING run.lease_expires_at INTO lease_value;

  RETURN QUERY SELECT true, 'accepted', lease_value;
END
$$;

CREATE OR REPLACE FUNCTION geo.reconcile_automation_run(
  p_run_id uuid,
  p_worker_id text,
  p_attempt_count integer,
  p_retry_after_seconds integer,
  p_error_code text,
  p_error_message text
)
RETURNS TABLE (
  automation_run_id uuid,
  run_state text,
  batch_state text,
  available_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  run_row geo.automation_runs%ROWTYPE;
  block_reason text;
  target_count integer;
  unfinished_count integer;
  awaiting_count integer;
  success_count integer;
  failure_count integer;
  next_state text;
  batch_state_value text;
  available_value timestamptz;
  completed_value timestamptz;
  error_code_value text;
  error_message_value text;
BEGIN
  PERFORM geo.require_actor_id();
  IF p_worker_id IS NULL OR length(p_worker_id) NOT BETWEEN 1 AND 200 OR
     p_attempt_count < 1 OR
     (p_retry_after_seconds IS NOT NULL AND p_retry_after_seconds NOT BETWEEN 0 AND 86400) THEN
    RAISE EXCEPTION 'invalid automation reconciliation arguments' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(hashtextextended('automation:' || tenant_value::text, 0));

  SELECT * INTO run_row
  FROM geo.automation_runs AS run
  WHERE run.tenant_id = tenant_value AND run.id = p_run_id
  FOR UPDATE;

  IF run_row.id IS NULL THEN
    RAISE EXCEPTION 'automation run was not found' USING ERRCODE = 'P0002';
  END IF;
  IF run_row.state <> 'running' THEN
    RAISE EXCEPTION 'automation run in state % cannot be reconciled', run_row.state
      USING ERRCODE = '55000';
  END IF;
  IF run_row.lease_owner <> p_worker_id OR run_row.attempt_count <> p_attempt_count THEN
    RAISE EXCEPTION 'automation run lease does not match the reconciler' USING ERRCODE = '42501';
  END IF;
  IF run_row.lease_expires_at < statement_timestamp() THEN
    UPDATE geo.automation_runs AS run
    SET state = 'retry_wait', available_at = clock_timestamp(),
        lease_owner = NULL, lease_expires_at = NULL,
        last_error_code = 'AUTOMATION_LEASE_EXPIRED',
        last_error_message = 'Reconciliation arrived after the worker lease expired'
    WHERE run.tenant_id = tenant_value AND run.id = p_run_id;
    batch_state_value := geo.refresh_automation_batch_state(run_row.batch_id);
    RETURN QUERY SELECT p_run_id, 'retry_wait'::text, batch_state_value, clock_timestamp();
    RETURN;
  END IF;

  block_reason := geo.automation_run_block_reason(run_row.campaign_id, run_row.topic_key);
  IF block_reason IS NOT NULL THEN
    UPDATE geo.automation_runs AS run
    SET state = 'blocked', lease_owner = NULL, lease_expires_at = NULL,
        completed_at = clock_timestamp(),
        last_error_code = 'AUTOMATION_GOVERNANCE_BLOCKED',
        last_error_message = left(block_reason, 4000)
    WHERE run.tenant_id = tenant_value AND run.id = p_run_id;
    UPDATE geo.automation_run_targets AS target
    SET state = 'blocked', completed_at = clock_timestamp(),
        last_error_code = 'AUTOMATION_GOVERNANCE_BLOCKED',
        last_error_message = left(block_reason, 4000)
    WHERE target.tenant_id = tenant_value AND target.run_id = p_run_id
      AND target.state IN ('pending', 'variant_ready', 'awaiting_delivery');
    batch_state_value := geo.refresh_automation_batch_state(run_row.batch_id);
    RETURN QUERY SELECT p_run_id, 'blocked'::text, batch_state_value, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT count(*)::integer,
         count(*) FILTER (WHERE target.state IN ('pending', 'variant_ready'))::integer,
         count(*) FILTER (WHERE target.state = 'awaiting_delivery')::integer,
         count(*) FILTER (WHERE target.state IN ('preview_completed', 'confirmed'))::integer,
         count(*) FILTER (
           WHERE target.state IN ('audit_failed', 'blocked', 'failed', 'cancelled')
         )::integer
  INTO target_count, unfinished_count, awaiting_count, success_count, failure_count
  FROM geo.automation_run_targets AS target
  WHERE target.tenant_id = tenant_value AND target.run_id = p_run_id;

  IF unfinished_count > 0 AND p_retry_after_seconds IS NULL AND
     p_error_code IS NOT NULL AND length(trim(p_error_code)) > 0 THEN
    UPDATE geo.automation_run_targets AS target
    SET state = 'failed',
        completed_at = clock_timestamp(),
        last_error_code = left(trim(p_error_code), 200),
        last_error_message = left(
          COALESCE(NULLIF(trim(p_error_message), ''), trim(p_error_code)),
          4000
        )
    WHERE target.tenant_id = tenant_value
      AND target.run_id = p_run_id
      AND target.state IN ('pending', 'variant_ready');
    failure_count := failure_count + unfinished_count;
    unfinished_count := 0;
  END IF;

  IF awaiting_count > 0 THEN
    next_state := 'awaiting_delivery';
    available_value := clock_timestamp() +
      make_interval(secs => COALESCE(p_retry_after_seconds, 5));
    completed_value := NULL;
  ELSIF unfinished_count > 0 THEN
    IF p_retry_after_seconds IS NULL THEN
      RAISE EXCEPTION 'unfinished automation targets require an explicit retry delay'
        USING ERRCODE = '55000';
    END IF;
    next_state := 'retry_wait';
    available_value := clock_timestamp() + make_interval(secs => p_retry_after_seconds);
    completed_value := NULL;
  ELSIF target_count = 0 THEN
    IF p_retry_after_seconds IS NOT NULL THEN
      next_state := 'retry_wait';
      available_value := clock_timestamp() + make_interval(secs => p_retry_after_seconds);
      completed_value := NULL;
    ELSE
      next_state := 'failed';
      available_value := run_row.available_at;
      completed_value := clock_timestamp();
    END IF;
  ELSIF success_count = target_count THEN
    next_state := 'completed';
    available_value := run_row.available_at;
    completed_value := clock_timestamp();
  ELSIF success_count > 0 AND failure_count > 0 THEN
    next_state := 'partially_failed';
    available_value := run_row.available_at;
    completed_value := clock_timestamp();
  ELSE
    next_state := 'failed';
    available_value := run_row.available_at;
    completed_value := clock_timestamp();
  END IF;

  error_code_value := CASE
    WHEN next_state = 'completed' THEN NULL
    WHEN p_error_code IS NOT NULL AND length(trim(p_error_code)) > 0
      THEN left(trim(p_error_code), 200)
    WHEN next_state = 'retry_wait' THEN 'AUTOMATION_RETRY_REQUESTED'
    WHEN next_state = 'awaiting_delivery' THEN NULL
    WHEN target_count = 0 THEN 'AUTOMATION_TARGETS_MISSING'
    ELSE 'AUTOMATION_TARGETS_FAILED'
  END;
  error_message_value := CASE
    WHEN error_code_value IS NULL THEN NULL
    ELSE left(COALESCE(NULLIF(trim(p_error_message), ''), error_code_value), 4000)
  END;

  UPDATE geo.automation_runs AS run
  SET state = next_state,
      stage = CASE
        WHEN next_state IN ('awaiting_delivery', 'completed', 'partially_failed')
          THEN 'delivery'
        ELSE run.stage
      END,
      available_at = available_value,
      lease_owner = NULL,
      lease_expires_at = NULL,
      completed_at = completed_value,
      last_error_code = error_code_value,
      last_error_message = error_message_value
  WHERE run.tenant_id = tenant_value AND run.id = p_run_id;

  batch_state_value := geo.refresh_automation_batch_state(run_row.batch_id);
  RETURN QUERY SELECT p_run_id, next_state, batch_state_value, available_value;
END
$$;

CREATE OR REPLACE FUNCTION geo.cancel_automation_batch(
  p_batch_id uuid,
  p_reason text
)
RETURNS TABLE (
  automation_batch_id uuid,
  state text,
  cancelled_runs integer,
  cancelled_targets integer,
  was_changed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  batch_row geo.automation_batches%ROWTYPE;
  run_count integer := 0;
  target_count integer := 0;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'cancellation reason is required' USING ERRCODE = '22023';
  END IF;

  -- Excludes concurrent claim transactions for this tenant until every child is cancelled.
  PERFORM pg_advisory_xact_lock(hashtextextended('automation:' || tenant_value::text, 0));

  SELECT * INTO batch_row
  FROM geo.automation_batches AS batch
  WHERE batch.tenant_id = tenant_value AND batch.id = p_batch_id
  FOR UPDATE;

  IF batch_row.id IS NULL THEN
    RAISE EXCEPTION 'automation batch was not found' USING ERRCODE = 'P0002';
  END IF;
  IF batch_row.state IN ('completed', 'partially_failed', 'cancelled') THEN
    RETURN QUERY SELECT batch_row.id, batch_row.state, 0, 0, false;
    RETURN;
  END IF;

  UPDATE geo.automation_run_targets AS target
  SET state = 'cancelled',
      cancelled_at = clock_timestamp(),
      last_error_code = 'AUTOMATION_BATCH_CANCELLED',
      last_error_message = left(trim(p_reason), 4000)
  WHERE target.tenant_id = tenant_value
    AND target.run_id IN (
      SELECT run.id
      FROM geo.automation_runs AS run
      WHERE run.tenant_id = tenant_value AND run.batch_id = p_batch_id
    )
    AND target.state IN ('pending', 'variant_ready', 'awaiting_delivery');
  GET DIAGNOSTICS target_count = ROW_COUNT;

  UPDATE geo.automation_runs AS run
  SET state = 'cancelled',
      lease_owner = NULL,
      lease_expires_at = NULL,
      cancelled_at = clock_timestamp(),
      cancelled_by_actor_id = actor_value,
      cancellation_reason = trim(p_reason),
      last_error_code = 'AUTOMATION_BATCH_CANCELLED',
      last_error_message = left(trim(p_reason), 4000)
  WHERE run.tenant_id = tenant_value
    AND run.batch_id = p_batch_id
    AND run.state IN ('scheduled', 'running', 'retry_wait', 'awaiting_delivery');
  GET DIAGNOSTICS run_count = ROW_COUNT;

  UPDATE geo.automation_batches AS batch
  SET state = 'cancelled',
      cancelled_at = clock_timestamp(),
      cancelled_by_actor_id = actor_value,
      cancellation_reason = trim(p_reason)
  WHERE batch.tenant_id = tenant_value AND batch.id = p_batch_id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'automation_batch.cancelled',
    'automation_batch', p_batch_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_batch_id::text),
    encode(public.digest(
      p_batch_id::text || ':cancelled:' || run_count::text || ':' || target_count::text,
      'sha256'
    ), 'hex'),
    jsonb_build_object(
      'reason', trim(p_reason),
      'cancelledRuns', run_count,
      'cancelledTargets', target_count
    )
  );

  RETURN QUERY SELECT p_batch_id, 'cancelled'::text, run_count, target_count, true;
END
$$;

REVOKE ALL ON TABLE geo.automation_batches, geo.automation_runs,
  geo.automation_run_targets FROM PUBLIC, geo_dispatcher, geo_runtime;
GRANT SELECT, INSERT ON TABLE geo.automation_batches, geo.automation_runs,
  geo.automation_run_targets TO geo_runtime;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE geo.automation_batches,
  geo.automation_runs, geo.automation_run_targets FROM geo_runtime;

REVOKE ALL ON FUNCTION geo.automation_run_block_reason(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.refresh_automation_batch_state(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.validate_automation_batch_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.validate_automation_run_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.validate_automation_target_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.claim_automation_runs(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.heartbeat_automation_run(uuid, text, integer, text, jsonb, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.checkpoint_automation_draft(uuid, text, integer, uuid, uuid, jsonb, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.checkpoint_automation_target(uuid, uuid, text, integer, text,
  uuid, uuid, uuid, uuid, text, text, jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.reconcile_automation_run(uuid, text, integer, integer, text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.cancel_automation_batch(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION geo.claim_automation_runs(text, integer, integer) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.heartbeat_automation_run(uuid, text, integer, text, jsonb, integer)
  TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.checkpoint_automation_draft(uuid, text, integer, uuid, uuid, jsonb, integer)
  TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.checkpoint_automation_target(uuid, uuid, text, integer, text,
  uuid, uuid, uuid, uuid, text, text, jsonb, integer) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.reconcile_automation_run(uuid, text, integer, integer, text, text)
  TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.cancel_automation_batch(uuid, text) TO geo_runtime;
