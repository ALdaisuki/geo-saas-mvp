CREATE TABLE geo.ctrip_account_analytics_snapshots (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_account_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'ctrip_community'
    CHECK (platform = 'ctrip_community'),
  snapshot_hour timestamptz NOT NULL,
  report_period text NOT NULL CHECK (length(report_period) BETWEEN 1 AND 160),
  publish_count integer NOT NULL CHECK (publish_count >= 0),
  featured_count integer NOT NULL CHECK (featured_count >= 0),
  quality_count integer NOT NULL CHECK (quality_count >= 0),
  featured_quality_rate numeric(7, 4) NOT NULL
    CHECK (featured_quality_rate BETWEEN 0 AND 100),
  content_heat numeric(18, 2) NOT NULL CHECK (content_heat >= 0),
  total_views bigint NOT NULL CHECK (total_views >= 0),
  total_viewers bigint NOT NULL CHECK (total_viewers >= 0),
  total_interactions bigint NOT NULL CHECK (total_interactions >= 0),
  total_interactors bigint NOT NULL CHECK (total_interactors >= 0),
  traffic_sources jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(traffic_sources) = 'object'),
  works jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(works) = 'array'),
  source_hash char(64) NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, channel_account_id, snapshot_hour),
  FOREIGN KEY (tenant_id, channel_account_id, platform)
    REFERENCES geo.channel_accounts (tenant_id, id, platform) ON DELETE CASCADE,
  CHECK (snapshot_hour = date_trunc('hour', observed_at))
);

CREATE INDEX ctrip_account_analytics_snapshots_latest_idx
  ON geo.ctrip_account_analytics_snapshots (
    tenant_id, channel_account_id, observed_at DESC
  );

ALTER TABLE geo.ctrip_account_analytics_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.ctrip_account_analytics_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON geo.ctrip_account_analytics_snapshots TO geo_runtime
  USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

CREATE TABLE geo.ctrip_account_analytics_sync_state (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_account_id uuid NOT NULL,
  next_refresh_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner uuid,
  lease_expires_at timestamptz,
  last_attempted_at timestamptz,
  last_succeeded_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, channel_account_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, channel_account_id)
    REFERENCES geo.channel_accounts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, lease_owner)
    REFERENCES geo.service_principals (tenant_id, id) ON DELETE RESTRICT,
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX ctrip_account_analytics_sync_due_idx
  ON geo.ctrip_account_analytics_sync_state (tenant_id, next_refresh_at, lease_expires_at);

ALTER TABLE geo.ctrip_account_analytics_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.ctrip_account_analytics_sync_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON geo.ctrip_account_analytics_sync_state TO geo_runtime
  USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

CREATE TRIGGER ctrip_account_analytics_sync_state_updated_at
BEFORE UPDATE ON geo.ctrip_account_analytics_sync_state
FOR EACH ROW EXECUTE FUNCTION geo.set_updated_at();

INSERT INTO geo.ctrip_account_analytics_sync_state (tenant_id, channel_account_id)
SELECT account.tenant_id, account.id
FROM geo.channel_accounts AS account
WHERE account.platform = 'ctrip_community'
ON CONFLICT (tenant_id, channel_account_id) DO NOTHING;

CREATE OR REPLACE FUNCTION geo.create_ctrip_account_analytics_sync_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF NEW.platform = 'ctrip_community' THEN
    INSERT INTO geo.ctrip_account_analytics_sync_state (tenant_id, channel_account_id)
    VALUES (NEW.tenant_id, NEW.id)
    ON CONFLICT (tenant_id, channel_account_id) DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION geo.create_ctrip_account_analytics_sync_state() FROM PUBLIC;

CREATE TRIGGER channel_accounts_create_ctrip_analytics_sync_state
AFTER INSERT ON geo.channel_accounts
FOR EACH ROW EXECUTE FUNCTION geo.create_ctrip_account_analytics_sync_state();

CREATE OR REPLACE FUNCTION geo.claim_next_ctrip_account_analytics_refresh(
  lease_seconds integer DEFAULT 300
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  claimed_account_id uuid;
BEGIN
  IF lease_seconds < 30 OR lease_seconds > 900 THEN
    RAISE EXCEPTION 'analytics lease must be between 30 and 900 seconds';
  END IF;

  SELECT sync.channel_account_id
  INTO claimed_account_id
  FROM geo.ctrip_account_analytics_sync_state AS sync
  JOIN geo.channel_accounts AS account
    ON account.tenant_id = sync.tenant_id
   AND account.id = sync.channel_account_id
   AND account.platform = 'ctrip_community'
   AND account.status = 'active'
  JOIN geo.ctrip_account_runtime_bindings AS runtime
    ON runtime.tenant_id = sync.tenant_id
   AND runtime.channel_account_id = sync.channel_account_id
   AND runtime.bridge_principal_id = geo.current_actor_id()
   AND runtime.session_state IN ('authenticated', 'ready')
  WHERE sync.next_refresh_at <= clock_timestamp()
    AND (sync.lease_expires_at IS NULL OR sync.lease_expires_at <= clock_timestamp())
  ORDER BY sync.next_refresh_at, sync.channel_account_id
  FOR UPDATE OF sync SKIP LOCKED
  LIMIT 1;

  IF claimed_account_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE geo.ctrip_account_analytics_sync_state
  SET lease_owner = geo.current_actor_id(),
      lease_expires_at = clock_timestamp() + make_interval(secs => lease_seconds),
      last_attempted_at = clock_timestamp(),
      last_error_code = NULL,
      last_error_message = NULL
  WHERE channel_account_id = claimed_account_id;

  RETURN claimed_account_id;
END
$$;

REVOKE ALL ON FUNCTION geo.claim_next_ctrip_account_analytics_refresh(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.claim_next_ctrip_account_analytics_refresh(integer) TO geo_runtime;

REVOKE ALL ON TABLE geo.ctrip_account_analytics_snapshots,
  geo.ctrip_account_analytics_sync_state FROM PUBLIC, geo_dispatcher;
GRANT SELECT, INSERT, UPDATE ON TABLE geo.ctrip_account_analytics_snapshots,
  geo.ctrip_account_analytics_sync_state TO geo_runtime;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE geo.ctrip_account_analytics_snapshots,
  geo.ctrip_account_analytics_sync_state FROM geo_runtime;
