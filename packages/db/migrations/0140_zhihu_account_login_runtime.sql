BEGIN;

-- Zhihu remains reference-only for publication. This migration opens only the
-- tenant account row and its isolated browser runtime so operators can log in
-- and capture authenticated DOM evidence before the publication adapter is
-- registered in the live delivery path.
ALTER TABLE geo.channel_accounts
  DROP CONSTRAINT channel_accounts_platform_check,
  ADD CONSTRAINT channel_accounts_platform_check
    CHECK (platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community', 'zhihu'));

ALTER TABLE geo.ctrip_account_runtime_bindings
  DROP CONSTRAINT ctrip_account_runtime_bindings_platform_check,
  ADD CONSTRAINT ctrip_account_runtime_bindings_platform_check
    CHECK (platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community', 'zhihu'));

INSERT INTO geo.ctrip_account_runtime_bindings (
  tenant_id, channel_account_id, platform, profile_key, session_state, bridge_principal_id
)
SELECT account.tenant_id,
       account.id,
       account.platform,
       'ctrip-account-' || account.id::text,
       CASE WHEN account.status = 'disabled' THEN 'disabled' ELSE 'session_required' END,
       commissioned.bridge_service_principal_id
FROM geo.channel_accounts AS account
LEFT JOIN LATERAL (
  SELECT receipt.bridge_service_principal_id
  FROM geo.ctrip_bridge_commissioning_receipts AS receipt
  JOIN geo.service_principals AS principal
    ON principal.tenant_id = receipt.tenant_id
   AND principal.id = receipt.bridge_service_principal_id
   AND principal.profile = 'ctrip_bridge'
   AND principal.status = 'active'
  WHERE receipt.tenant_id = account.tenant_id
  ORDER BY receipt.created_at DESC, receipt.id DESC
  LIMIT 1
) AS commissioned ON true
WHERE account.platform = 'zhihu'
ON CONFLICT (tenant_id, channel_account_id) DO NOTHING;

CREATE OR REPLACE FUNCTION geo.create_ctrip_account_runtime_binding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  commissioned_principal_id uuid;
BEGIN
  IF NEW.platform NOT IN (
    'toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community', 'zhihu'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT receipt.bridge_service_principal_id
  INTO commissioned_principal_id
  FROM geo.ctrip_bridge_commissioning_receipts AS receipt
  JOIN geo.service_principals AS principal
    ON principal.tenant_id = receipt.tenant_id
   AND principal.id = receipt.bridge_service_principal_id
   AND principal.profile = 'ctrip_bridge'
   AND principal.status = 'active'
  WHERE receipt.tenant_id = NEW.tenant_id
  ORDER BY receipt.created_at DESC, receipt.id DESC
  LIMIT 1;

  INSERT INTO geo.ctrip_account_runtime_bindings (
    tenant_id, channel_account_id, platform, profile_key, session_state, bridge_principal_id
  ) VALUES (
    NEW.tenant_id,
    NEW.id,
    NEW.platform,
    'ctrip-account-' || NEW.id::text,
    CASE WHEN NEW.status = 'disabled' THEN 'disabled' ELSE 'session_required' END,
    commissioned_principal_id
  )
  ON CONFLICT (tenant_id, channel_account_id) DO NOTHING;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION geo.create_ctrip_account_runtime_binding() FROM PUBLIC;

COMMIT;
