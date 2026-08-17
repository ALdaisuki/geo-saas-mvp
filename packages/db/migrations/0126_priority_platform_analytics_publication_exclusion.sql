BEGIN;

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
   AND account.platform IN ('toutiao', 'baijiahao', 'sohu', 'netease')
   AND account.status = 'active'
   AND account.archived_at IS NULL
  JOIN geo.ctrip_account_runtime_bindings AS runtime
    ON runtime.tenant_id = sync.tenant_id
   AND runtime.channel_account_id = sync.channel_account_id
   AND runtime.platform = account.platform
   AND runtime.bridge_principal_id = geo.current_actor_id()
   AND runtime.session_state IN ('authenticated', 'ready')
  WHERE sync.next_refresh_at <= clock_timestamp()
    AND (sync.lease_expires_at IS NULL OR sync.lease_expires_at <= clock_timestamp())
    AND NOT EXISTS (
      SELECT 1
      FROM geo.publication_assisted_handoffs AS active_handoff
      WHERE active_handoff.tenant_id = sync.tenant_id
        AND active_handoff.channel_account_id = sync.channel_account_id
        AND active_handoff.state IN (
          'handoff_pending', 'session_required', 'challenge_required',
          'draft_prepared', 'awaiting_operator_submit',
          'submitted_unconfirmed', 'readback_pending'
        )
    )
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
  'Claims an authenticated priority-platform account only while no publication or readback handoff owns its browser runtime';

REVOKE ALL ON FUNCTION geo.claim_next_priority_platform_account_analytics_refresh(integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.claim_next_priority_platform_account_analytics_refresh(integer)
  TO geo_runtime;

COMMIT;
