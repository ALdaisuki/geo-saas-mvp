BEGIN;

-- Operator force calibration is a deliberate human override for browser
-- accounts whose real login is healthy but whose runtime probe cannot be read.
-- It restores the runtime binding, releases stale draft preparation leases,
-- closes account circuit breakers, and leaves an auditable manual action.
CREATE OR REPLACE FUNCTION geo.force_calibrate_channel_account_runtime(
  p_channel_account_id uuid,
  p_observed_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  account geo.channel_accounts%ROWTYPE;
  binding geo.ctrip_account_runtime_bindings%ROWTYPE;
BEGIN
  IF p_observed_at IS NULL
     OR p_observed_at > statement_timestamp() + interval '1 minute'
     OR p_observed_at < statement_timestamp() - interval '30 minutes' THEN
    RAISE EXCEPTION 'invalid force calibration observed time'
      USING ERRCODE = '22023';
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
  IF account.status = 'disabled' OR binding.session_state = 'disabled' THEN
    RAISE EXCEPTION 'channel account browser runtime is disabled'
      USING ERRCODE = '55000';
  END IF;

  IF account.capability_evidence_type <> 'platform_readback' THEN
    UPDATE geo.channel_accounts AS channel_account
    SET capability_evidence_type = 'browser_screenshot',
        capability_evidence_refs = '["browser-runtime-readiness"]'::jsonb,
        last_verified_at = p_observed_at
    WHERE channel_account.tenant_id = tenant_value
      AND channel_account.id = p_channel_account_id;
  END IF;

  UPDATE geo.ctrip_account_runtime_bindings AS runtime_binding
  SET session_state = 'ready',
      last_checked_at = p_observed_at,
      last_ready_at = p_observed_at,
      last_error_code = NULL,
      last_error_message = NULL
  WHERE runtime_binding.tenant_id = tenant_value
    AND runtime_binding.channel_account_id = p_channel_account_id;

  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET draft_prepare_owner_principal_id = NULL,
      draft_prepare_lease_expires_at = NULL
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.channel_account_id = p_channel_account_id
    AND assisted_handoff.state IN (
      'handoff_pending', 'session_required', 'challenge_required'
    );

  UPDATE geo.circuit_breakers AS breaker
  SET state = 'closed',
      failure_count = 0,
      opened_at = NULL,
      retry_at = NULL,
      reason = NULL,
      probe_attempt_id = NULL,
      probe_started_at = NULL
  WHERE breaker.tenant_id = tenant_value
    AND breaker.scope_type = 'account'
    AND breaker.scope_key = p_channel_account_id::text
    AND breaker.state IN ('open', 'half_open');

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, before_hash, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'channel_account.runtime_force_calibrated',
    'channel_account', p_channel_account_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_channel_account_id::text),
    NULL,
    NULL,
    jsonb_build_object(
      'manual', true,
      'reason', 'operator force calibration',
      'previousSessionState', binding.session_state,
      'previousErrorCode', binding.last_error_code,
      'previousErrorMessage', binding.last_error_message,
      'clearedDraftPrepareLeases', true
    )
  );

  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION geo.force_calibrate_channel_account_runtime(uuid, timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.force_calibrate_channel_account_runtime(uuid, timestamptz)
  TO geo_runtime;

COMMIT;
