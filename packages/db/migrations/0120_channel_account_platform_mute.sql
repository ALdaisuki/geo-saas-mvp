BEGIN;

-- A platform mute is a publisher-imposed restriction on the account itself.
-- Persist the mute window and temporarily disable the account so automation
-- stops claiming it while an operator decides whether to re-enable it.
ALTER TABLE geo.channel_accounts
  ADD COLUMN IF NOT EXISTS platform_muted_at timestamptz,
  ADD COLUMN IF NOT EXISTS platform_muted_until timestamptz,
  ADD COLUMN IF NOT EXISTS platform_mute_reason text;

CREATE INDEX IF NOT EXISTS channel_accounts_platform_muted_idx
  ON geo.channel_accounts (tenant_id, platform_muted_until)
  WHERE platform_muted_at IS NOT NULL;

CREATE OR REPLACE FUNCTION geo.report_channel_account_platform_mute(
  p_handoff_id uuid,
  p_channel_account_id uuid,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_bound_ctrip_bridge(p_handoff_id);
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  account geo.channel_accounts%ROWTYPE;
  binding geo.ctrip_account_runtime_bindings%ROWTYPE;
BEGIN
  IF p_channel_account_id IS NULL
     OR p_reason IS NULL
     OR length(trim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid platform mute report'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id;

  IF handoff.id IS NULL OR handoff.channel_account_id <> p_channel_account_id THEN
    RAISE EXCEPTION 'handoff does not match the muted channel account'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO account
  FROM geo.channel_accounts AS channel_account
  WHERE channel_account.tenant_id = tenant_value
    AND channel_account.id = p_channel_account_id
  FOR UPDATE;

  IF account.id IS NULL THEN
    RAISE EXCEPTION 'channel account was not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO binding
  FROM geo.ctrip_account_runtime_bindings AS runtime_binding
  WHERE runtime_binding.tenant_id = tenant_value
    AND runtime_binding.channel_account_id = p_channel_account_id
  FOR UPDATE;

  IF binding.id IS NULL THEN
    RAISE EXCEPTION 'channel account browser runtime is not bound'
      USING ERRCODE = 'P0002';
  END IF;

  UPDATE geo.channel_accounts AS channel_account
  SET status = 'disabled',
      platform_muted_at = clock_timestamp(),
      platform_muted_until = clock_timestamp() + interval '3 days',
      platform_mute_reason = trim(p_reason)
  WHERE channel_account.tenant_id = tenant_value
    AND channel_account.id = p_channel_account_id;

  UPDATE geo.ctrip_account_runtime_bindings AS runtime_binding
  SET session_state = 'disabled',
      last_checked_at = clock_timestamp(),
      last_error_code = 'ACCOUNT_PLATFORM_MUTED',
      last_error_message = trim(p_reason),
      manual_ready_until = NULL
  WHERE runtime_binding.tenant_id = tenant_value
    AND runtime_binding.channel_account_id = p_channel_account_id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, before_hash, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'channel_account.platform_muted',
    'channel_account', p_channel_account_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_channel_account_id::text),
    NULL,
    NULL,
    jsonb_build_object(
      'reason', trim(p_reason),
      'mutedAt', clock_timestamp(),
      'mutedUntil', clock_timestamp() + interval '3 days',
      'handoffId', p_handoff_id,
      'previousSessionState', binding.session_state,
      'previousErrorCode', binding.last_error_code
    )
  );

  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION geo.report_channel_account_platform_mute(uuid, uuid, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.report_channel_account_platform_mute(uuid, uuid, text)
  TO geo_runtime;

COMMIT;
