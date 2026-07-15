CREATE TABLE geo.brand_agent_profiles (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  document_hash geo.sha256_hex NOT NULL,
  created_by_actor_id uuid NOT NULL,
  effective_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, brand_id, version),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES geo.brands (tenant_id, id) ON DELETE RESTRICT,
  CHECK (
    (status = 'active' AND retired_at IS NULL) OR
    (status = 'retired' AND retired_at IS NOT NULL AND retired_at >= effective_at)
  )
);

CREATE UNIQUE INDEX brand_agent_profiles_one_active_per_brand
  ON geo.brand_agent_profiles (tenant_id, brand_id)
  WHERE status = 'active';

ALTER TABLE geo.tenant_provisioning_receipts
  ADD COLUMN brand_agent_profile_id uuid,
  ADD COLUMN brand_agent_profile_hash geo.sha256_hex;

INSERT INTO geo.brand_agent_profiles (
  tenant_id, id, brand_id, version, status, document, document_hash,
  created_by_actor_id, effective_at
)
SELECT
  receipt.tenant_id,
  gen_random_uuid(),
  receipt.brand_id,
  1,
  'active',
  '{"schemaVersion":"geo.brand-agent-profile.v1","voice":"克制、清晰、证据优先；先回答问题，再解释依据与边界","audiences":["正在评估品牌服务并需要核验信息的潜在客户"],"objectives":["帮助读者基于当前证据理解服务事实、适用范围与下一步"],"requiredPoints":["区分已验证事实、适用条件和仍需确认的信息"],"forbiddenClaims":["无证据的保证、排名、独家资质、实时优惠或结果承诺"],"callToAction":"请通过当前有效的官方联系方式核验具体服务范围与条件。","agentInstructions":"只选择有当前租户事实与证据支持的文章策略；优先直接回答、标明依据和有效期，并提供可执行的核验步骤。"}'::jsonb,
  '626950dce6dd7d84574044e8d78497ea90de0cb8a543044200e111493d93777c',
  receipt.worker_service_principal_id,
  receipt.created_at
FROM geo.tenant_provisioning_receipts AS receipt;

ALTER TABLE geo.tenant_provisioning_receipts
  DISABLE TRIGGER tenant_provisioning_receipts_append_only;

UPDATE geo.tenant_provisioning_receipts AS receipt
SET brand_agent_profile_id = profile.id,
    brand_agent_profile_hash = profile.document_hash
FROM geo.brand_agent_profiles AS profile
WHERE profile.tenant_id = receipt.tenant_id
  AND profile.brand_id = receipt.brand_id
  AND profile.version = 1;

ALTER TABLE geo.tenant_provisioning_receipts
  ENABLE TRIGGER tenant_provisioning_receipts_append_only;

ALTER TABLE geo.tenant_provisioning_receipts
  ALTER COLUMN brand_agent_profile_id SET NOT NULL,
  ALTER COLUMN brand_agent_profile_hash SET NOT NULL,
  ADD CONSTRAINT tenant_provisioning_receipts_brand_agent_profile_fk
    FOREIGN KEY (tenant_id, brand_agent_profile_id)
    REFERENCES geo.brand_agent_profiles (tenant_id, id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION geo.enforce_brand_agent_profile_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'brand Agent Profiles cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'active' OR NEW.status <> 'retired' OR NEW.retired_at IS NULL OR
     (to_jsonb(OLD) - ARRAY['status', 'retired_at']) IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY['status', 'retired_at']) THEN
    RAISE EXCEPTION 'brand Agent Profiles only support active to retired transition'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER brand_agent_profiles_transition_only
BEFORE UPDATE OR DELETE ON geo.brand_agent_profiles
FOR EACH ROW EXECUTE FUNCTION geo.enforce_brand_agent_profile_transition();

ALTER TABLE geo.brand_agent_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.brand_agent_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON geo.brand_agent_profiles TO geo_runtime
  USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

REVOKE ALL ON TABLE geo.brand_agent_profiles
  FROM PUBLIC, geo_dispatcher, geo_identity, geo_runtime;
GRANT SELECT, INSERT ON TABLE geo.brand_agent_profiles TO geo_runtime;
GRANT UPDATE (status, retired_at) ON TABLE geo.brand_agent_profiles TO geo_runtime;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE geo.brand_agent_profiles FROM geo_runtime;
REVOKE ALL ON FUNCTION geo.enforce_brand_agent_profile_transition() FROM PUBLIC;
