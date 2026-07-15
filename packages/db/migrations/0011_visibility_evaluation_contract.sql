CREATE TABLE geo.brand_competitors (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  canonical_name text NOT NULL,
  display_name text NOT NULL,
  aliases jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(aliases) = 'array'),
  source_type text NOT NULL CHECK (source_type IN ('tenant_configured', 'verified_public', 'manual_import')),
  source_ref text NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, brand_id, canonical_name),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES geo.brands (tenant_id, id) ON DELETE RESTRICT,
  CHECK (length(btrim(canonical_name)) BETWEEN 1 AND 200),
  CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  CHECK (length(btrim(source_ref)) BETWEEN 1 AND 1000),
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);

CREATE INDEX brand_competitors_active_lookup
  ON geo.brand_competitors (tenant_id, brand_id, canonical_name)
  WHERE valid_until IS NULL;

ALTER TABLE geo.visibility_observations
  ADD COLUMN request_started_at timestamptz,
  ADD COLUMN response_received_at timestamptz,
  ADD COLUMN sentiment text,
  ADD COLUMN hallucination_findings jsonb,
  ADD COLUMN evaluator_version text;

UPDATE geo.visibility_observations
SET request_started_at = observed_at,
    response_received_at = observed_at,
    sentiment = 'neutral',
    hallucination_findings = CASE
      WHEN harmful_error THEN jsonb_build_array(jsonb_build_object(
        'code', 'legacy_harmful_error',
        'category', 'other',
        'severity', 'high',
        'statement', '迁移前观测已标记为有害错误；原始提取器未保存结构化原因',
        'observedValue', null,
        'expectedValues', jsonb_build_array()
      ))
      ELSE '[]'::jsonb
    END,
    evaluator_version = extractor_version;

ALTER TABLE geo.visibility_observations
  ALTER COLUMN request_started_at SET NOT NULL,
  ALTER COLUMN response_received_at SET NOT NULL,
  ALTER COLUMN sentiment SET NOT NULL,
  ALTER COLUMN hallucination_findings SET NOT NULL,
  ALTER COLUMN evaluator_version SET NOT NULL,
  ADD CONSTRAINT visibility_observation_response_order
    CHECK (response_received_at >= request_started_at),
  ADD CONSTRAINT visibility_observation_sentiment
    CHECK (sentiment IN ('positive', 'neutral', 'negative', 'mixed')),
  ADD CONSTRAINT visibility_observation_hallucination_findings
    CHECK (jsonb_typeof(hallucination_findings) = 'array'),
  ADD CONSTRAINT visibility_observation_harmful_finding_consistency
    CHECK (harmful_error = jsonb_path_exists(
      hallucination_findings,
      '$[*] ? (@.severity == "high")'
    )),
  ADD CONSTRAINT visibility_observation_evaluator_version
    CHECK (length(btrim(evaluator_version)) BETWEEN 1 AND 100);

ALTER TABLE geo.brand_competitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.brand_competitors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON geo.brand_competitors TO geo_runtime
  USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

REVOKE ALL ON TABLE geo.brand_competitors FROM PUBLIC, geo_dispatcher, geo_identity;
GRANT SELECT ON TABLE geo.brand_competitors TO geo_runtime;
