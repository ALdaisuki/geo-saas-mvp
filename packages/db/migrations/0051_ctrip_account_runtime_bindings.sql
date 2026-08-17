-- Persist the account-to-browser-runtime relationship without persisting any
-- browser credential, cookie, local storage, or raw token.
ALTER TABLE geo.channel_accounts
  ADD COLUMN daily_publish_quota integer NOT NULL DEFAULT 10
    CHECK (daily_publish_quota BETWEEN 1 AND 100),
  ADD COLUMN max_concurrent_publications integer NOT NULL DEFAULT 1
    CHECK (max_concurrent_publications BETWEEN 1 AND 10),
  ADD COLUMN quota_timezone text NOT NULL DEFAULT 'Asia/Shanghai'
    CHECK (quota_timezone = 'Asia/Shanghai');

CREATE OR REPLACE FUNCTION geo.enforce_channel_account_platform_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  platform_account_count integer;
  excluded_account_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND
     NEW.tenant_id = OLD.tenant_id AND
     NEW.platform = OLD.platform THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    excluded_account_id := OLD.id;
  END IF;

  -- Serialize inserts for one tenant/platform pair so concurrent requests
  -- cannot both observe the 199th account and exceed the hard limit.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'channel-account-platform:' || NEW.tenant_id::text || ':' || NEW.platform,
      0
    )
  );

  SELECT count(*)::integer
  INTO platform_account_count
  FROM geo.channel_accounts AS account
  WHERE account.tenant_id = NEW.tenant_id
    AND account.platform = NEW.platform
    AND (excluded_account_id IS NULL OR account.id <> excluded_account_id);

  IF platform_account_count >= 200 THEN
    RAISE EXCEPTION 'tenant platform channel account limit of 200 exceeded'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION geo.enforce_channel_account_platform_limit() FROM PUBLIC;

CREATE TRIGGER channel_accounts_enforce_platform_limit
BEFORE INSERT OR UPDATE OF tenant_id, platform ON geo.channel_accounts
FOR EACH ROW EXECUTE FUNCTION geo.enforce_channel_account_platform_limit();

CREATE OR REPLACE FUNCTION geo.sync_channel_account_capacity_control()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
BEGIN
  INSERT INTO geo.automation_controls (
    tenant_id, id, scope_type, scope_key, mode, quota, kill_switch_enabled, reason
  ) VALUES (
    NEW.tenant_id,
    gen_random_uuid(),
    'account',
    NEW.id::text,
    CASE WHEN NEW.platform = 'ctrip_community' AND NEW.capability = 'browser_assisted'
      THEN 'supervised' ELSE 'shadow' END,
    jsonb_build_object(
      'maxConcurrent', NEW.max_concurrent_publications,
      'perDay', NEW.daily_publish_quota
    ),
    false,
    'Default per-account publication capacity'
  )
  ON CONFLICT (tenant_id, scope_type, scope_key) DO UPDATE
  SET quota = jsonb_set(
        jsonb_set(
          geo.automation_controls.quota,
          '{maxConcurrent}',
          to_jsonb(EXCLUDED.quota -> 'maxConcurrent')
        ),
        '{perDay}',
        to_jsonb(EXCLUDED.quota -> 'perDay')
      );

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION geo.sync_channel_account_capacity_control() FROM PUBLIC;

CREATE TRIGGER channel_accounts_sync_capacity_control
AFTER INSERT OR UPDATE OF daily_publish_quota, max_concurrent_publications
ON geo.channel_accounts
FOR EACH ROW EXECUTE FUNCTION geo.sync_channel_account_capacity_control();

INSERT INTO geo.automation_controls (
  tenant_id, id, scope_type, scope_key, mode, quota, kill_switch_enabled, reason
)
SELECT account.tenant_id,
       gen_random_uuid(),
       'account',
       account.id::text,
       CASE WHEN account.platform = 'ctrip_community'
                  AND account.capability = 'browser_assisted'
         THEN 'supervised' ELSE 'shadow' END,
       jsonb_build_object(
         'maxConcurrent', account.max_concurrent_publications,
         'perDay', account.daily_publish_quota
       ),
       false,
       'Default per-account publication capacity'
FROM geo.channel_accounts AS account
ON CONFLICT (tenant_id, scope_type, scope_key) DO UPDATE
SET quota = jsonb_set(
      jsonb_set(
        geo.automation_controls.quota,
        '{maxConcurrent}',
        to_jsonb(EXCLUDED.quota -> 'maxConcurrent')
      ),
      '{perDay}',
      to_jsonb(EXCLUDED.quota -> 'perDay')
    );

CREATE TABLE geo.ctrip_account_runtime_bindings (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_account_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'ctrip_community'
    CHECK (platform = 'ctrip_community'),
  profile_key text NOT NULL
    CHECK (
      profile_key = trim(profile_key) AND
      profile_key !~ '[[:space:]]' AND
      profile_key !~ '[[:cntrl:]]' AND
      length(profile_key) BETWEEN 16 AND 200
    ),
  session_state text NOT NULL DEFAULT 'session_required'
    CHECK (session_state IN (
      'unbound', 'session_required', 'ready', 'challenge_required',
      'unavailable', 'disabled'
    )),
  bridge_principal_id uuid,
  last_checked_at timestamptz,
  last_ready_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, channel_account_id),
  UNIQUE (tenant_id, profile_key),
  FOREIGN KEY (tenant_id, channel_account_id, platform)
    REFERENCES geo.channel_accounts (tenant_id, id, platform) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, bridge_principal_id)
    REFERENCES geo.service_principals (tenant_id, id) ON DELETE RESTRICT
);

ALTER TABLE geo.ctrip_account_runtime_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.ctrip_account_runtime_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON geo.ctrip_account_runtime_bindings TO geo_runtime
  USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

CREATE TRIGGER ctrip_account_runtime_bindings_updated_at
BEFORE UPDATE ON geo.ctrip_account_runtime_bindings
FOR EACH ROW EXECUTE FUNCTION geo.set_updated_at();

REVOKE ALL ON TABLE geo.ctrip_account_runtime_bindings
  FROM PUBLIC, geo_dispatcher;
GRANT SELECT, INSERT, UPDATE ON TABLE geo.ctrip_account_runtime_bindings TO geo_runtime;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE geo.ctrip_account_runtime_bindings FROM geo_runtime;

INSERT INTO geo.ctrip_account_runtime_bindings (
  tenant_id, channel_account_id, profile_key, session_state, bridge_principal_id
)
SELECT account.tenant_id, account.id, 'ctrip-account-' || account.id::text,
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
WHERE account.platform = 'ctrip_community'
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
  IF NEW.platform <> 'ctrip_community' THEN
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
    tenant_id, channel_account_id, profile_key, session_state, bridge_principal_id
  ) VALUES (
    NEW.tenant_id,
    NEW.id,
    'ctrip-account-' || NEW.id::text,
    CASE WHEN NEW.status = 'disabled' THEN 'disabled' ELSE 'session_required' END,
    commissioned_principal_id
  )
  ON CONFLICT (tenant_id, channel_account_id) DO NOTHING;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION geo.create_ctrip_account_runtime_binding() FROM PUBLIC;

CREATE TRIGGER channel_accounts_create_ctrip_runtime_binding
AFTER INSERT ON geo.channel_accounts
FOR EACH ROW EXECUTE FUNCTION geo.create_ctrip_account_runtime_binding();

CREATE INDEX automation_run_targets_account_run
  ON geo.automation_run_targets (tenant_id, channel_account_id, run_id);

-- Commissioning remains a tenant-level bridge identity. A handoff may use any
-- active Ctrip account that has an explicit binding to that commissioned
-- principal; the original append-only receipt is no longer an account allowlist.
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
    FROM geo.ctrip_account_runtime_bindings AS binding
    JOIN geo.channel_accounts AS account
      ON account.tenant_id = binding.tenant_id
     AND account.id = binding.channel_account_id
     AND account.platform = 'ctrip_community'
     AND account.status = 'active'
    JOIN geo.ctrip_bridge_commissioning_receipts AS receipt
      ON receipt.tenant_id = binding.tenant_id
     AND receipt.bridge_service_principal_id = binding.bridge_principal_id
    JOIN geo.service_principals AS principal
      ON principal.tenant_id = receipt.tenant_id
     AND principal.id = receipt.bridge_service_principal_id
     AND principal.name = receipt.principal_name
     AND principal.kind = 'integration'
     AND principal.profile = 'ctrip_bridge'
     AND principal.status = 'active'
     AND principal.capabilities @> '["tenant:read","content:read","publish:bridge"]'::jsonb
     AND principal.capabilities <@ '["tenant:read","content:read","publish:bridge"]'::jsonb
    WHERE binding.tenant_id = NEW.tenant_id
      AND binding.channel_account_id = NEW.channel_account_id
      AND binding.bridge_principal_id = NEW.bridge_service_principal_id
      AND binding.session_state <> 'disabled'
  ) THEN
    RAISE EXCEPTION 'Ctrip handoff account runtime does not match the commissioned bridge'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION geo.enforce_commissioned_ctrip_bridge_handoff() FROM PUBLIC;

COMMENT ON TABLE geo.ctrip_account_runtime_bindings IS
  'Tenant-scoped Ctrip account browser runtime binding; secrets remain outside the database';
