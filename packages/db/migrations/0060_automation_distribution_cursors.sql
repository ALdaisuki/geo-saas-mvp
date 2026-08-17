CREATE TABLE geo.automation_distribution_cursors (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_key geo.sha256_hex NOT NULL,
  account_pool_ids uuid[] NOT NULL,
  next_offset integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, pool_key),
  CHECK (cardinality(account_pool_ids) BETWEEN 1 AND 200),
  CHECK (next_offset >= 0 AND next_offset < cardinality(account_pool_ids))
);

ALTER TABLE geo.automation_distribution_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.automation_distribution_cursors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON geo.automation_distribution_cursors TO geo_runtime
  USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

CREATE TRIGGER automation_distribution_cursors_updated_at
BEFORE UPDATE ON geo.automation_distribution_cursors
FOR EACH ROW EXECUTE FUNCTION geo.set_updated_at();

REVOKE ALL ON TABLE geo.automation_distribution_cursors FROM PUBLIC, geo_dispatcher;
GRANT SELECT, INSERT, UPDATE ON TABLE geo.automation_distribution_cursors TO geo_runtime;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE geo.automation_distribution_cursors FROM geo_runtime;
