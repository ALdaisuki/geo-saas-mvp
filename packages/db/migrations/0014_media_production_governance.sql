CREATE TABLE geo.media_generation_jobs (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_version_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('toutiao', 'sohu', 'ctrip_community')),
  role text NOT NULL CHECK (role IN ('cover', 'inline')),
  fact_ids uuid[] NOT NULL CHECK (cardinality(fact_ids) BETWEEN 1 AND 3),
  visual_brief jsonb NOT NULL CHECK (jsonb_typeof(visual_brief) = 'object'),
  visual_brief_hash geo.sha256_hex NOT NULL,
  request_hash geo.sha256_hex NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  provider_id text NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 200),
  provider_mode text NOT NULL CHECK (provider_mode IN ('fixture', 'live')),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  asset_id uuid,
  last_error_code text,
  last_error_message text,
  created_by_actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, request_hash),
  UNIQUE (tenant_id, id, request_hash, provider_id, provider_mode),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, content_version_id)
    REFERENCES geo.content_versions (tenant_id, id) ON DELETE RESTRICT,
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (
    (state IN ('pending', 'running') AND completed_at IS NULL) OR
    (state IN ('succeeded', 'failed', 'cancelled') AND completed_at IS NOT NULL)
  ),
  CHECK ((state = 'succeeded') = (asset_id IS NOT NULL)),
  CHECK ((state = 'failed') = (last_error_code IS NOT NULL))
);

CREATE TABLE geo.media_generation_attempts (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  status text NOT NULL CHECK (status IN ('succeeded', 'failed', 'timed_out')),
  provider_id text NOT NULL,
  provider_mode text NOT NULL CHECK (provider_mode IN ('fixture', 'live')),
  model text NOT NULL,
  input_hash geo.sha256_hex NOT NULL,
  request_hash geo.sha256_hex NOT NULL,
  response_hash geo.sha256_hex,
  output_sha256 geo.sha256_hex,
  provider_request_id text,
  error_code text,
  error_message text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, job_id, attempt_no),
  FOREIGN KEY (tenant_id, job_id)
    REFERENCES geo.media_generation_jobs (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, job_id, request_hash, provider_id, provider_mode)
    REFERENCES geo.media_generation_jobs
      (tenant_id, id, request_hash, provider_id, provider_mode) ON DELETE RESTRICT,
  CHECK (
    (status = 'succeeded' AND finished_at IS NOT NULL AND response_hash IS NOT NULL AND
      output_sha256 IS NOT NULL AND error_code IS NULL) OR
    (status IN ('failed', 'timed_out') AND finished_at IS NOT NULL AND
      output_sha256 IS NULL AND error_code IS NOT NULL)
  )
);

ALTER TABLE geo.media_assets
  DROP CONSTRAINT media_assets_tenant_id_sha256_key,
  ADD COLUMN job_id uuid,
  ADD COLUMN source_class text,
  ADD COLUMN provenance_hash geo.sha256_hex,
  ADD COLUMN byte_length bigint,
  ADD COLUMN width integer,
  ADD COLUMN height integer,
  ADD COLUMN platform text,
  ADD COLUMN role text,
  ADD COLUMN caption text,
  ADD COLUMN fact_ids uuid[],
  ADD COLUMN visual_brief jsonb,
  ADD COLUMN visual_brief_hash geo.sha256_hex,
  ADD COLUMN rights jsonb,
  ADD COLUMN provenance jsonb;

UPDATE geo.media_assets
SET source_class = 'legacy',
    provenance_hash = encode(public.digest(
      tenant_id::text || ':' || id::text || ':' || sha256,
      'sha256'
    ), 'hex'),
    fact_ids = ARRAY[]::uuid[],
    caption = '',
    rights = jsonb_build_object('basis', 'legacy_unverified'),
    provenance = jsonb_build_object('kind', 'legacy');

ALTER TABLE geo.media_assets
  ALTER COLUMN source_class SET NOT NULL,
  ALTER COLUMN provenance_hash SET NOT NULL,
  ALTER COLUMN fact_ids SET NOT NULL,
  ALTER COLUMN caption SET NOT NULL,
  ALTER COLUMN rights SET NOT NULL,
  ALTER COLUMN provenance SET NOT NULL,
  ADD CONSTRAINT media_assets_source_class
    CHECK (source_class IN ('generated', 'licensed_stock', 'tenant_owned', 'legacy')),
  ADD CONSTRAINT media_assets_platform
    CHECK (platform IS NULL OR platform IN ('toutiao', 'sohu', 'ctrip_community')),
  ADD CONSTRAINT media_assets_role CHECK (role IS NULL OR role IN ('cover', 'inline')),
  ADD CONSTRAINT media_assets_rights_object CHECK (jsonb_typeof(rights) = 'object'),
  ADD CONSTRAINT media_assets_provenance_object CHECK (jsonb_typeof(provenance) = 'object'),
  ADD CONSTRAINT media_assets_visual_brief_object
    CHECK (visual_brief IS NULL OR jsonb_typeof(visual_brief) = 'object'),
  ADD CONSTRAINT media_assets_governed_shape CHECK (
    source_class = 'legacy' OR (
      job_id IS NOT NULL AND content_version_id IS NOT NULL AND
      byte_length > 0 AND width > 0 AND height > 0 AND
      platform IS NOT NULL AND role IS NOT NULL AND
      cardinality(fact_ids) BETWEEN 1 AND 3 AND
      visual_brief IS NOT NULL AND visual_brief_hash IS NOT NULL
    )
  ),
  ADD CONSTRAINT media_assets_tenant_provenance_unique UNIQUE (tenant_id, provenance_hash),
  ADD CONSTRAINT media_assets_tenant_id_sha256_unique UNIQUE (tenant_id, id, sha256),
  ADD FOREIGN KEY (tenant_id, job_id)
    REFERENCES geo.media_generation_jobs (tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE geo.media_generation_jobs
  ADD FOREIGN KEY (tenant_id, asset_id)
    REFERENCES geo.media_assets (tenant_id, id) ON DELETE RESTRICT;

CREATE TABLE geo.content_media_bindings (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_version_id uuid NOT NULL,
  media_asset_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('toutiao', 'sohu', 'ctrip_community')),
  role text NOT NULL CHECK (role IN ('cover', 'inline')),
  position integer NOT NULL CHECK (position >= 0),
  alt_text text NOT NULL,
  caption text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, content_version_id, platform, role, position),
  UNIQUE (tenant_id, content_version_id, media_asset_id),
  FOREIGN KEY (tenant_id, content_version_id)
    REFERENCES geo.content_versions (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, media_asset_id)
    REFERENCES geo.media_assets (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE geo.media_inspections (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_asset_id uuid NOT NULL,
  asset_sha256 geo.sha256_hex NOT NULL,
  status text NOT NULL CHECK (status IN ('passed', 'failed')),
  evaluator text NOT NULL,
  evaluator_mode text NOT NULL CHECK (evaluator_mode IN ('fixture', 'live')),
  evaluator_version text NOT NULL,
  response_sha256 geo.sha256_hex NOT NULL,
  inspected_at timestamptz NOT NULL,
  ocr_text text NOT NULL DEFAULT '',
  labels jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(labels) = 'array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, media_asset_id, evaluator, evaluator_mode, evaluator_version, response_sha256),
  FOREIGN KEY (tenant_id, media_asset_id, asset_sha256)
    REFERENCES geo.media_assets (tenant_id, id, sha256) ON DELETE RESTRICT
);

ALTER TABLE geo.audit_artifacts
  ADD COLUMN brand_snapshot_hash geo.sha256_hex NOT NULL DEFAULT repeat('0', 64),
  ADD COLUMN media_snapshot_hash geo.sha256_hex NOT NULL DEFAULT repeat('0', 64);

ALTER TABLE geo.audit_artifacts
  ALTER COLUMN brand_snapshot_hash DROP DEFAULT,
  ALTER COLUMN media_snapshot_hash DROP DEFAULT;

CREATE OR REPLACE FUNCTION geo.enforce_media_generation_job_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'media generation jobs cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(OLD) - ARRAY[
        'state', 'attempt_count', 'lease_owner', 'lease_expires_at', 'asset_id',
        'last_error_code', 'last_error_message', 'updated_at', 'completed_at'
      ]) IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY[
        'state', 'attempt_count', 'lease_owner', 'lease_expires_at', 'asset_id',
        'last_error_code', 'last_error_message', 'updated_at', 'completed_at'
      ]) THEN
    RAISE EXCEPTION 'media generation job request fields are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count OR
     NOT (
       (OLD.state = 'pending' AND NEW.state IN ('pending', 'running', 'failed', 'cancelled')) OR
       (OLD.state = 'running' AND NEW.state IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')) OR
       (OLD.state IN ('succeeded', 'failed', 'cancelled') AND NEW.state = OLD.state)
     ) THEN
    RAISE EXCEPTION 'invalid media generation job transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('succeeded', 'failed', 'cancelled') AND
     to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
    RAISE EXCEPTION 'terminal media generation jobs are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER media_generation_jobs_transition_only
BEFORE UPDATE OR DELETE ON geo.media_generation_jobs
FOR EACH ROW EXECUTE FUNCTION geo.enforce_media_generation_job_transition();

CREATE TRIGGER media_generation_jobs_set_updated_at
BEFORE UPDATE ON geo.media_generation_jobs
FOR EACH ROW EXECUTE FUNCTION geo.set_updated_at();

CREATE TRIGGER media_generation_attempts_append_only
BEFORE UPDATE OR DELETE ON geo.media_generation_attempts
FOR EACH ROW EXECUTE FUNCTION geo.prevent_append_only_mutation();

CREATE TRIGGER media_assets_append_only
BEFORE UPDATE OR DELETE ON geo.media_assets
FOR EACH ROW EXECUTE FUNCTION geo.prevent_append_only_mutation();

CREATE TRIGGER content_media_bindings_append_only
BEFORE UPDATE OR DELETE ON geo.content_media_bindings
FOR EACH ROW EXECUTE FUNCTION geo.prevent_append_only_mutation();

CREATE TRIGGER media_inspections_append_only
BEFORE UPDATE OR DELETE ON geo.media_inspections
FOR EACH ROW EXECUTE FUNCTION geo.prevent_append_only_mutation();

ALTER TABLE geo.media_generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.media_generation_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON geo.media_generation_jobs TO geo_runtime
  USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

ALTER TABLE geo.media_generation_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.media_generation_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON geo.media_generation_attempts TO geo_runtime
  USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

ALTER TABLE geo.content_media_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.content_media_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON geo.content_media_bindings TO geo_runtime
  USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

ALTER TABLE geo.media_inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.media_inspections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON geo.media_inspections TO geo_runtime
  USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

REVOKE ALL ON TABLE
  geo.media_generation_jobs,
  geo.media_generation_attempts,
  geo.media_assets,
  geo.content_media_bindings,
  geo.media_inspections
FROM PUBLIC, geo_dispatcher, geo_identity, geo_runtime;

GRANT SELECT, INSERT ON TABLE geo.media_generation_jobs TO geo_runtime;
GRANT UPDATE (
  state, attempt_count, lease_owner, lease_expires_at, asset_id,
  last_error_code, last_error_message, updated_at, completed_at
) ON TABLE geo.media_generation_jobs TO geo_runtime;
GRANT SELECT, INSERT ON TABLE
  geo.media_generation_attempts,
  geo.media_assets,
  geo.content_media_bindings,
  geo.media_inspections
TO geo_runtime;

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE
  geo.media_generation_attempts,
  geo.media_assets,
  geo.content_media_bindings,
  geo.media_inspections FROM geo_runtime;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE
  geo.media_generation_jobs,
  geo.media_generation_attempts,
  geo.media_assets,
  geo.content_media_bindings,
  geo.media_inspections FROM geo_runtime;

REVOKE ALL ON FUNCTION geo.enforce_media_generation_job_transition() FROM PUBLIC;
