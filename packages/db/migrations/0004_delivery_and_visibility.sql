CREATE TABLE geo.publication_jobs (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL,
  audit_artifact_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('toutiao', 'sohu', 'ctrip_community')),
  execution_level text NOT NULL CHECK (execution_level IN ('dry_run', 'assisted', 'unattended')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'dispatching', 'retry_wait', 'uncertain', 'reconciling', 'confirmed', 'needs_review', 'permanent_failure', 'cancelled')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash geo.sha256_hex NOT NULL,
  payload_hash geo.sha256_hex NOT NULL,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text,
  lease_expires_at timestamptz,
  confirmed_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, grant_id)
    REFERENCES geo.publication_grants (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, audit_artifact_id)
    REFERENCES geo.audit_artifacts (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, variant_id)
    REFERENCES geo.publication_variants (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, channel_account_id, platform)
    REFERENCES geo.channel_accounts (tenant_id, id, platform) ON DELETE RESTRICT,
  CHECK ((state = 'confirmed') = (confirmed_at IS NOT NULL)),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX publication_jobs_dispatch
  ON geo.publication_jobs (tenant_id, state, available_at, created_at)
  WHERE state IN ('queued', 'retry_wait', 'uncertain', 'reconciling');

CREATE TABLE geo.publication_attempts (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  state text NOT NULL CHECK (state IN ('started', 'succeeded', 'failed', 'uncertain', 'reconciled')),
  request_hash geo.sha256_hex NOT NULL,
  response_hash geo.sha256_hex,
  error_code text,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, job_id),
  UNIQUE (tenant_id, job_id, attempt_no),
  FOREIGN KEY (tenant_id, job_id)
    REFERENCES geo.publication_jobs (tenant_id, id) ON DELETE RESTRICT,
  CHECK ((state = 'started' AND finished_at IS NULL) OR (state <> 'started' AND finished_at IS NOT NULL))
);

CREATE TABLE geo.publication_receipts (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('toutiao', 'sohu', 'ctrip_community')),
  execution_level text NOT NULL CHECK (execution_level IN ('dry_run', 'assisted', 'unattended')),
  evidence_type text NOT NULL CHECK (evidence_type IN ('fixture', 'preview', 'manual_import', 'browser_screenshot', 'api_response', 'platform_readback')),
  request_hash geo.sha256_hex NOT NULL,
  response_hash geo.sha256_hex NOT NULL,
  external_id text,
  external_url text,
  published_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, attempt_id),
  FOREIGN KEY (tenant_id, job_id)
    REFERENCES geo.publication_jobs (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id, job_id)
    REFERENCES geo.publication_attempts (tenant_id, id, job_id) ON DELETE RESTRICT,
  CHECK ((confirmed AND (published_at IS NOT NULL OR execution_level = 'dry_run')) OR NOT confirmed),
  CHECK (execution_level <> 'dry_run' OR evidence_type IN ('fixture', 'preview'))
);

CREATE TABLE geo.outbox_events (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  topic text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  request_hash geo.sha256_hex NOT NULL,
  idempotency_key text NOT NULL,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_by text,
  locked_until timestamptz,
  last_attempt_at timestamptz,
  published_at timestamptz,
  dead_lettered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  CHECK ((locked_by IS NULL) = (locked_until IS NULL)),
  CHECK (NOT (published_at IS NOT NULL AND dead_lettered_at IS NOT NULL))
);

CREATE INDEX outbox_events_claimable
  ON geo.outbox_events (available_at, created_at, tenant_id)
  WHERE published_at IS NULL AND dead_lettered_at IS NULL;

CREATE TABLE geo.inbox_events (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer text NOT NULL,
  event_id uuid NOT NULL,
  payload_hash geo.sha256_hex NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, consumer, event_id)
);

CREATE TABLE geo.idempotency_records (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash geo.sha256_hex NOT NULL,
  response_resource_type text NOT NULL,
  response_resource_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, scope, idempotency_key),
  CHECK (expires_at > created_at)
);

CREATE INDEX idempotency_records_expiry
  ON geo.idempotency_records (expires_at);

CREATE TABLE geo.circuit_breakers (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL CHECK (scope_type IN ('tenant', 'platform', 'account', 'campaign', 'topic')),
  scope_key text NOT NULL DEFAULT '*',
  state text NOT NULL CHECK (state IN ('closed', 'open', 'half_open')),
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  opened_at timestamptz,
  retry_at timestamptz,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, scope_type, scope_key),
  CHECK ((state = 'open' AND opened_at IS NOT NULL) OR state <> 'open')
);

CREATE TABLE geo.query_sets (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  industry text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE geo.query_set_versions (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_set_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  prompts jsonb NOT NULL CHECK (jsonb_typeof(prompts) = 'array'),
  prompt_hash geo.sha256_hex NOT NULL,
  created_by_actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, query_set_id, version),
  UNIQUE (tenant_id, prompt_hash),
  FOREIGN KEY (tenant_id, query_set_id)
    REFERENCES geo.query_sets (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE geo.visibility_runs (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_set_version_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('doubao', 'qwen')),
  product_surface text NOT NULL,
  model text NOT NULL,
  search_mode text NOT NULL CHECK (search_mode IN ('on', 'off', 'unknown')),
  observation_method text NOT NULL CHECK (observation_method IN ('fixture', 'manual', 'official_api', 'browser')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  locale text NOT NULL DEFAULT 'zh-CN',
  geo text,
  started_at timestamptz,
  completed_at timestamptz,
  created_by_actor_id uuid NOT NULL,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, query_set_version_id)
    REFERENCES geo.query_set_versions (tenant_id, id) ON DELETE RESTRICT,
  CHECK ((status IN ('completed', 'failed') AND completed_at IS NOT NULL) OR status NOT IN ('completed', 'failed'))
);

CREATE INDEX visibility_runs_provider_time
  ON geo.visibility_runs (tenant_id, provider, created_at DESC);

CREATE TABLE geo.visibility_observations (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('doubao', 'qwen')),
  product_surface text NOT NULL,
  model text NOT NULL,
  search_mode text NOT NULL CHECK (search_mode IN ('on', 'off', 'unknown')),
  observation_method text NOT NULL CHECK (observation_method IN ('fixture', 'manual', 'official_api', 'browser')),
  prompt text NOT NULL,
  prompt_version text NOT NULL,
  locale text NOT NULL,
  geo text,
  raw_answer text NOT NULL,
  cited_urls jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(cited_urls) = 'array'),
  evidence_hash geo.sha256_hex NOT NULL,
  evidence_type text NOT NULL CHECK (evidence_type IN ('fixture', 'preview', 'manual_import', 'browser_screenshot', 'api_response', 'platform_readback')),
  observed_at timestamptz NOT NULL,
  brand_mentioned boolean NOT NULL,
  answer_position integer CHECK (answer_position IS NULL OR answer_position > 0),
  contact_accuracy numeric(5,4) NOT NULL CHECK (contact_accuracy BETWEEN 0 AND 1),
  competitor_mentions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(competitor_mentions) = 'array'),
  harmful_error boolean NOT NULL,
  extractor_version text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, evidence_hash),
  FOREIGN KEY (tenant_id, run_id)
    REFERENCES geo.visibility_runs (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE geo.visibility_metrics (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  metric_name text NOT NULL,
  value numeric NOT NULL,
  sample_count integer NOT NULL CHECK (sample_count > 0),
  confidence_low numeric,
  confidence_high numeric,
  dimensions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(dimensions) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, run_id, metric_name),
  FOREIGN KEY (tenant_id, run_id)
    REFERENCES geo.visibility_runs (tenant_id, id) ON DELETE RESTRICT,
  CHECK (confidence_low IS NULL OR confidence_high IS NULL OR confidence_low <= confidence_high)
);

CREATE TRIGGER publication_jobs_set_updated_at
BEFORE UPDATE ON geo.publication_jobs
FOR EACH ROW EXECUTE FUNCTION geo.set_updated_at();

CREATE TRIGGER query_sets_set_updated_at
BEFORE UPDATE ON geo.query_sets
FOR EACH ROW EXECUTE FUNCTION geo.set_updated_at();

CREATE TRIGGER publication_receipts_append_only
BEFORE UPDATE OR DELETE ON geo.publication_receipts
FOR EACH ROW EXECUTE FUNCTION geo.prevent_append_only_mutation();

CREATE TRIGGER visibility_observations_append_only
BEFORE UPDATE OR DELETE ON geo.visibility_observations
FOR EACH ROW EXECUTE FUNCTION geo.prevent_append_only_mutation();
