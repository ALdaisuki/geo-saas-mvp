BEGIN;

ALTER TABLE geo.ctrip_account_analytics_snapshots
  DROP CONSTRAINT ctrip_account_analytics_snapshots_platform_check,
  ADD CONSTRAINT ctrip_account_analytics_snapshots_platform_check
    CHECK (platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community')),
  ADD COLUMN total_impressions bigint CHECK (total_impressions >= 0),
  ADD COLUMN total_reads bigint CHECK (total_reads >= 0),
  ADD COLUMN total_likes bigint CHECK (total_likes >= 0),
  ADD COLUMN total_comments bigint CHECK (total_comments >= 0);

INSERT INTO geo.ctrip_account_analytics_sync_state (tenant_id, channel_account_id)
SELECT account.tenant_id, account.id
FROM geo.channel_accounts AS account
WHERE account.platform IN ('toutiao', 'sohu', 'baijiahao', 'netease')
ON CONFLICT (tenant_id, channel_account_id) DO NOTHING;

CREATE OR REPLACE FUNCTION geo.create_ctrip_account_analytics_sync_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF NEW.platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community') THEN
    INSERT INTO geo.ctrip_account_analytics_sync_state (tenant_id, channel_account_id)
    VALUES (NEW.tenant_id, NEW.id)
    ON CONFLICT (tenant_id, channel_account_id) DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION geo.create_ctrip_account_analytics_sync_state() FROM PUBLIC;

CREATE OR REPLACE FUNCTION geo.claim_next_priority_platform_account_analytics_refresh(
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
   AND account.platform = 'toutiao'
   AND account.status = 'active'
  JOIN geo.ctrip_account_runtime_bindings AS runtime
    ON runtime.tenant_id = sync.tenant_id
   AND runtime.channel_account_id = sync.channel_account_id
   AND runtime.platform = account.platform
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

COMMENT ON FUNCTION geo.claim_next_priority_platform_account_analytics_refresh(integer) IS
  'Claims the next authenticated priority-platform account with an implemented native analytics collector';

REVOKE ALL ON FUNCTION geo.claim_next_priority_platform_account_analytics_refresh(integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.claim_next_priority_platform_account_analytics_refresh(integer)
  TO geo_runtime;

COMMIT;
