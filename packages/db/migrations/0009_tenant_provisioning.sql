CREATE TABLE geo.tenant_provisioning_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE
    CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_hash geo.sha256_hex NOT NULL,
  tenant_id uuid NOT NULL UNIQUE REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  worker_service_principal_id uuid NOT NULL,
  policy_bundle_id uuid NOT NULL,
  query_set_id uuid NOT NULL,
  query_set_version_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES geo.brands (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, worker_service_principal_id)
    REFERENCES geo.service_principals (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, policy_bundle_id)
    REFERENCES geo.policy_bundles (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, query_set_id)
    REFERENCES geo.query_sets (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, query_set_version_id)
    REFERENCES geo.query_set_versions (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER tenant_provisioning_receipts_append_only
BEFORE UPDATE OR DELETE ON geo.tenant_provisioning_receipts
FOR EACH ROW EXECUTE FUNCTION geo.prevent_append_only_mutation();

-- This is an administrative control-plane receipt. Runtime and dispatcher roles
-- never need to enumerate tenant commissioning records.
REVOKE ALL ON TABLE geo.tenant_provisioning_receipts
  FROM PUBLIC, geo_runtime, geo_dispatcher;
