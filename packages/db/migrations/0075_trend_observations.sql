BEGIN;

CREATE TABLE geo.trend_observations (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL CHECK (
    length(source_key) BETWEEN 1 AND 100 AND
    source_key ~ '^[a-z0-9][a-z0-9._-]*$'
  ),
  title text NOT NULL CHECK (length(title) BETWEEN 2 AND 300),
  normalized_title text NOT NULL CHECK (length(normalized_title) BETWEEN 2 AND 300),
  summary text CHECK (summary IS NULL OR length(summary) BETWEEN 1 AND 2000),
  canonical_url text CHECK (
    canonical_url IS NULL OR
    (length(canonical_url) BETWEEN 10 AND 2048 AND canonical_url LIKE 'https://%' AND
     canonical_url NOT LIKE '%#%')
  ),
  source_rank integer CHECK (source_rank IS NULL OR source_rank BETWEEN 1 AND 1000000),
  heat_value numeric CHECK (heat_value IS NULL OR heat_value BETWEEN 0 AND 1000000000000),
  observed_at timestamptz NOT NULL,
  source_updated_at timestamptz,
  fingerprint geo.sha256_hex NOT NULL,
  observation_key geo.sha256_hex NOT NULL,
  heat_score numeric NOT NULL CHECK (heat_score BETWEEN 0 AND 100),
  freshness_score_at_ingest numeric NOT NULL CHECK (freshness_score_at_ingest BETWEEN 0 AND 1),
  freshness_band_at_ingest text NOT NULL CHECK (
    freshness_band_at_ingest IN ('emerging', 'rising', 'cooling', 'stale', 'expired')
  ),
  ingested_by_actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, source_key, observation_key)
);

CREATE INDEX trend_observations_tenant_time
  ON geo.trend_observations (tenant_id, observed_at DESC, created_at DESC);

CREATE INDEX trend_observations_tenant_source_time
  ON geo.trend_observations (tenant_id, source_key, observed_at DESC);

CREATE INDEX trend_observations_tenant_fingerprint_time
  ON geo.trend_observations (tenant_id, fingerprint, observed_at DESC);

CREATE TRIGGER trend_observations_append_only
BEFORE UPDATE OR DELETE ON geo.trend_observations
FOR EACH ROW EXECUTE FUNCTION geo.prevent_append_only_mutation();

ALTER TABLE geo.trend_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.trend_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON geo.trend_observations TO geo_runtime
  USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

REVOKE ALL ON TABLE geo.trend_observations FROM PUBLIC, geo_dispatcher, geo_identity, geo_runtime;
GRANT SELECT, INSERT ON TABLE geo.trend_observations TO geo_runtime;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE geo.trend_observations FROM geo_runtime;

COMMIT;
