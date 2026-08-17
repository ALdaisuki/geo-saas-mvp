CREATE TABLE geo.ctrip_bridge_commissioning_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE
    CHECK (
      length(idempotency_key) BETWEEN 8 AND 200 AND
      idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    ),
  request_hash geo.sha256_hex NOT NULL,
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  operator_user_id uuid NOT NULL,
  operator_email text NOT NULL
    CHECK (
      operator_email = lower(trim(operator_email)) AND
      operator_email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' AND
      length(operator_email) <= 320
    ),
  ctrip_channel_account_id uuid NOT NULL,
  ctrip_channel_platform text NOT NULL DEFAULT 'ctrip_community'
    CHECK (ctrip_channel_platform = 'ctrip_community'),
  bridge_service_principal_id uuid NOT NULL UNIQUE,
  principal_name text NOT NULL
    CHECK (
      principal_name = trim(principal_name) AND
      principal_name !~ '[[:cntrl:]]' AND
      length(principal_name) BETWEEN 1 AND 200
    ),
  audit_log_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, operator_user_id)
    REFERENCES geo.tenant_memberships (tenant_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, ctrip_channel_account_id, ctrip_channel_platform)
    REFERENCES geo.channel_accounts (tenant_id, id, platform) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, bridge_service_principal_id)
    REFERENCES geo.service_principals (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, audit_log_id)
    REFERENCES geo.audit_log (tenant_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX service_principals_one_active_ctrip_bridge_per_tenant
  ON geo.service_principals (tenant_id)
  WHERE profile = 'ctrip_bridge' AND status = 'active';

CREATE OR REPLACE FUNCTION geo.validate_ctrip_bridge_commissioning_receipt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM geo.tenants AS tenant
    WHERE tenant.id = NEW.tenant_id AND tenant.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Ctrip bridge commissioning requires an active tenant'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM geo.tenant_memberships AS membership
    JOIN geo.users AS users ON users.id = membership.user_id
    WHERE membership.tenant_id = NEW.tenant_id
      AND membership.user_id = NEW.operator_user_id
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'admin')
      AND membership.capabilities @> '["principal:manage"]'::jsonb
      AND users.status = 'active'
      AND users.email = NEW.operator_email
  ) THEN
    RAISE EXCEPTION 'Ctrip bridge commissioning requires an authorized owner or admin'
      USING ERRCODE = '42501';
  END IF;

  IF (
    SELECT count(*)
    FROM geo.channel_accounts AS account
    WHERE account.tenant_id = NEW.tenant_id
      AND account.platform = 'ctrip_community'
      AND account.status = 'active'
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM geo.channel_accounts AS account
    WHERE account.tenant_id = NEW.tenant_id
      AND account.id = NEW.ctrip_channel_account_id
      AND account.platform = NEW.ctrip_channel_platform
      AND account.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Ctrip bridge commissioning requires one active Ctrip channel account'
      USING ERRCODE = '55000';
  END IF;

  IF (
    SELECT count(*)
    FROM geo.service_principals AS principal
    WHERE principal.tenant_id = NEW.tenant_id
      AND principal.profile = 'ctrip_bridge'
      AND principal.status = 'active'
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM geo.service_principals AS principal
    WHERE principal.tenant_id = NEW.tenant_id
      AND principal.id = NEW.bridge_service_principal_id
      AND principal.name = NEW.principal_name
      AND principal.kind = 'integration'
      AND principal.profile = 'ctrip_bridge'
      AND principal.status = 'active'
      AND principal.capabilities @> '["tenant:read","content:read","publish:bridge"]'::jsonb
      AND principal.capabilities <@ '["tenant:read","content:read","publish:bridge"]'::jsonb
  ) THEN
    RAISE EXCEPTION 'Ctrip bridge commissioning principal is invalid or ambiguous'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM geo.api_keys AS api_key
    WHERE api_key.tenant_id = NEW.tenant_id
      AND api_key.service_principal_id = NEW.bridge_service_principal_id
  ) THEN
    RAISE EXCEPTION 'Ctrip bridge commissioning principal must be credential-less'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM geo.audit_log AS audit
    WHERE audit.tenant_id = NEW.tenant_id
      AND audit.id = NEW.audit_log_id
      AND audit.actor_id = NEW.operator_user_id
      AND audit.action = 'ctrip_bridge.commissioned'
      AND audit.resource_type = 'service_principal'
      AND audit.resource_id = NEW.bridge_service_principal_id
      AND audit.request_id = NEW.idempotency_key
      AND audit.before_hash IS NULL
      AND audit.after_hash IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Ctrip bridge commissioning audit record is missing or inconsistent'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION geo.validate_ctrip_bridge_commissioning_receipt() FROM PUBLIC;

CREATE TRIGGER ctrip_bridge_commissioning_receipts_validate
BEFORE INSERT ON geo.ctrip_bridge_commissioning_receipts
FOR EACH ROW EXECUTE FUNCTION geo.validate_ctrip_bridge_commissioning_receipt();

CREATE TRIGGER ctrip_bridge_commissioning_receipts_append_only
BEFORE UPDATE OR DELETE ON geo.ctrip_bridge_commissioning_receipts
FOR EACH ROW EXECUTE FUNCTION geo.prevent_append_only_mutation();

CREATE OR REPLACE FUNCTION geo.enforce_commissioned_ctrip_bridge_handoff()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM geo.ctrip_bridge_commissioning_receipts AS receipt
    WHERE receipt.tenant_id = NEW.tenant_id
  ) AND NOT EXISTS (
    SELECT 1
    FROM geo.ctrip_bridge_commissioning_receipts AS receipt
    JOIN geo.channel_accounts AS account
      ON account.tenant_id = receipt.tenant_id
     AND account.id = receipt.ctrip_channel_account_id
     AND account.platform = 'ctrip_community'
     AND account.status = 'active'
    JOIN geo.service_principals AS principal
      ON principal.tenant_id = receipt.tenant_id
     AND principal.id = receipt.bridge_service_principal_id
     AND principal.name = receipt.principal_name
     AND principal.kind = 'integration'
     AND principal.profile = 'ctrip_bridge'
     AND principal.status = 'active'
     AND principal.capabilities @> '["tenant:read","content:read","publish:bridge"]'::jsonb
     AND principal.capabilities <@ '["tenant:read","content:read","publish:bridge"]'::jsonb
    WHERE receipt.tenant_id = NEW.tenant_id
      AND receipt.ctrip_channel_account_id = NEW.channel_account_id
      AND receipt.bridge_service_principal_id = NEW.bridge_service_principal_id
  ) THEN
    RAISE EXCEPTION 'Ctrip handoff account and principal do not match commissioning receipt'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION geo.enforce_commissioned_ctrip_bridge_handoff() FROM PUBLIC;

CREATE TRIGGER publication_assisted_handoffs_commissioned_bridge
BEFORE INSERT OR UPDATE OF channel_account_id, bridge_service_principal_id
ON geo.publication_assisted_handoffs
FOR EACH ROW EXECUTE FUNCTION geo.enforce_commissioned_ctrip_bridge_handoff();

CREATE OR REPLACE FUNCTION geo.prevent_commissioned_ctrip_bridge_api_key()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM geo.ctrip_bridge_commissioning_receipts AS receipt
    WHERE receipt.tenant_id = NEW.tenant_id
      AND receipt.bridge_service_principal_id = NEW.service_principal_id
  ) THEN
    RAISE EXCEPTION 'Commissioned Ctrip bridge principals cannot receive database API keys'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION geo.prevent_commissioned_ctrip_bridge_api_key() FROM PUBLIC;

CREATE TRIGGER api_keys_prevent_commissioned_ctrip_bridge
BEFORE INSERT OR UPDATE OF tenant_id, service_principal_id ON geo.api_keys
FOR EACH ROW EXECUTE FUNCTION geo.prevent_commissioned_ctrip_bridge_api_key();

-- This is an administrative commissioning receipt. Application roles must not
-- enumerate it or use it as a tenant-facing API surface.
REVOKE ALL ON TABLE geo.ctrip_bridge_commissioning_receipts
  FROM PUBLIC, geo_runtime, geo_dispatcher, geo_identity;
