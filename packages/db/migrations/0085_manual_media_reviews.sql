BEGIN;

CREATE TABLE geo.manual_media_reviews (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_version_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('confirmed', 'rejected')),
  media_snapshot_hash geo.sha256_hex NOT NULL,
  actions text[] NOT NULL DEFAULT '{}'::text[]
    CHECK (actions <@ ARRAY['regenerate_media', 'replace_media', 'revise_article']),
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 1000),
  decided_by_actor_id uuid NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, content_version_id),
  FOREIGN KEY (tenant_id, content_version_id)
    REFERENCES geo.content_versions (tenant_id, id) ON DELETE RESTRICT,
  CHECK (status <> 'rejected' OR cardinality(actions) BETWEEN 1 AND 3),
  CHECK (status <> 'confirmed' OR cardinality(actions) = 0)
);

CREATE INDEX manual_media_reviews_version
  ON geo.manual_media_reviews (tenant_id, content_version_id);

ALTER TABLE geo.manual_media_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.manual_media_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON geo.manual_media_reviews TO geo_runtime
  USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

REVOKE ALL ON TABLE geo.manual_media_reviews FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE geo.manual_media_reviews TO geo_runtime;

COMMIT;
