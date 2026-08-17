BEGIN;

CREATE INDEX IF NOT EXISTS publication_assisted_handoffs_account_claims
  ON geo.publication_assisted_handoffs (
    tenant_id,
    channel_account_id,
    state,
    created_at,
    id
  );

-- Browser work is serialized per channel account, not per worker process. The
-- durable lease/permit state keeps later transactions from claiming more work
-- for an account after the short account-row lock is released.
CREATE OR REPLACE FUNCTION geo.publication_account_browser_operation_busy(
  p_channel_account_id uuid,
  p_exclude_handoff_id uuid DEFAULT NULL,
  p_block_prepared boolean DEFAULT false
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM geo.publication_assisted_handoffs AS active
    WHERE active.tenant_id = geo.require_tenant_id()
      AND active.channel_account_id = p_channel_account_id
      AND (p_exclude_handoff_id IS NULL OR active.id <> p_exclude_handoff_id)
      AND (
        (
          active.draft_prepare_owner_principal_id IS NOT NULL
          AND active.draft_prepare_lease_expires_at > statement_timestamp()
        )
        OR (
          active.state = 'draft_prepared'
          AND active.expires_at > statement_timestamp()
          AND (
            p_block_prepared
            OR (
              active.submit_permit_hash IS NOT NULL
              AND active.submit_permit_consumed_at IS NULL
              AND active.submit_permit_expires_at > statement_timestamp()
            )
          )
        )
        OR (
          active.state = 'awaiting_operator_submit'
          AND active.expires_at > statement_timestamp()
        )
        OR (
          active.readback_owner_principal_id IS NOT NULL
          AND active.readback_lease_expires_at > statement_timestamp()
        )
      )
  )
$$;

CREATE OR REPLACE FUNCTION geo.claim_next_publication_assisted_draft_prepare(
  p_lease_seconds integer,
  p_execution_level text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  lease_expiry timestamptz;
  account_breaker_id uuid;
  account_breaker_state text;
  account_breaker_retry_at timestamptz;
BEGIN
  IF p_lease_seconds NOT BETWEEN 30 AND 600 THEN
    RAISE EXCEPTION 'draft preparation lease must be between 30 and 600 seconds'
      USING ERRCODE = '22023';
  END IF;
  IF p_execution_level IS NOT NULL
     AND p_execution_level NOT IN ('assisted', 'unattended') THEN
    RAISE EXCEPTION 'unsupported draft preparation execution level'
      USING ERRCODE = '22023';
  END IF;
  PERFORM geo.require_ctrip_bridge_principal(actor_value);
  PERFORM geo.expire_stale_publication_assisted_handoffs(100);
  PERFORM set_config('app.allow_account_half_open_probe', 'true', true);

  SELECT candidate.* INTO handoff
  FROM geo.publication_assisted_handoffs AS candidate
  JOIN geo.publication_jobs AS job
    ON job.tenant_id = candidate.tenant_id AND job.id = candidate.job_id
  JOIN geo.channel_accounts AS account
    ON account.tenant_id = candidate.tenant_id AND account.id = candidate.channel_account_id
  WHERE candidate.tenant_id = tenant_value
    AND candidate.bridge_service_principal_id = actor_value
    AND (p_execution_level IS NULL OR job.execution_level = p_execution_level)
    AND candidate.state IN ('handoff_pending', 'session_required', 'challenge_required')
    AND candidate.expires_at > statement_timestamp()
    AND (
      candidate.draft_prepare_owner_principal_id IS NULL OR
      candidate.draft_prepare_lease_expires_at < statement_timestamp()
    )
    AND NOT geo.publication_account_browser_operation_busy(
      candidate.channel_account_id,
      candidate.id,
      p_block_prepared => true
    )
    AND geo.publication_assisted_block_reason(candidate.job_id) IS NULL
  ORDER BY candidate.created_at, candidate.id
  FOR UPDATE OF candidate, account SKIP LOCKED
  LIMIT 1;

  IF handoff.id IS NULL THEN RETURN NULL; END IF;

  SELECT circuit.id, circuit.state, circuit.retry_at
  INTO account_breaker_id, account_breaker_state, account_breaker_retry_at
  FROM geo.circuit_breakers AS circuit
  WHERE circuit.tenant_id = tenant_value
    AND circuit.scope_type = 'account'
    AND circuit.scope_key = handoff.channel_account_id::text
    AND circuit.state IN ('open', 'half_open')
    AND circuit.reason IN (
      'ASSISTED_SESSION_REQUIRED',
      'ASSISTED_CHALLENGE_REQUIRED',
      'ASSISTED_ADAPTER_DRIFT'
    )
  FOR UPDATE;

  IF account_breaker_id IS NOT NULL THEN
    IF account_breaker_state = 'open' THEN
      IF account_breaker_retry_at IS NULL
         OR account_breaker_retry_at > statement_timestamp() THEN
        RETURN NULL;
      END IF;
      UPDATE geo.circuit_breakers AS circuit
      SET state = 'half_open',
          retry_at = NULL,
          probe_attempt_id = handoff.attempt_id,
          probe_started_at = statement_timestamp(),
          updated_at = clock_timestamp()
      WHERE circuit.tenant_id = tenant_value
        AND circuit.id = account_breaker_id
        AND circuit.state = 'open'
        AND circuit.reason IN (
          'ASSISTED_SESSION_REQUIRED',
          'ASSISTED_CHALLENGE_REQUIRED',
          'ASSISTED_ADAPTER_DRIFT'
        );
    ELSIF account_breaker_state = 'half_open' THEN
      IF geo.publication_account_browser_operation_busy(
        handoff.channel_account_id,
        handoff.id,
        p_block_prepared => false
      ) THEN
        RETURN NULL;
      END IF;
      UPDATE geo.circuit_breakers AS circuit
      SET retry_at = NULL,
          probe_attempt_id = handoff.attempt_id,
          probe_started_at = statement_timestamp(),
          updated_at = clock_timestamp()
      WHERE circuit.tenant_id = tenant_value
        AND circuit.id = account_breaker_id
        AND circuit.state = 'half_open'
        AND circuit.reason IN (
          'ASSISTED_SESSION_REQUIRED',
          'ASSISTED_CHALLENGE_REQUIRED',
          'ASSISTED_ADAPTER_DRIFT'
        );
    END IF;
  END IF;

  lease_expiry := LEAST(
    handoff.expires_at,
    statement_timestamp() + make_interval(secs => p_lease_seconds)
  );
  UPDATE geo.publication_assisted_handoffs AS claimed
  SET draft_prepare_owner_principal_id = actor_value,
      draft_prepare_lease_expires_at = lease_expiry,
      updated_at = clock_timestamp()
  WHERE claimed.tenant_id = tenant_value AND claimed.id = handoff.id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.draft_prepare_claimed',
    'publication_assisted_handoff', handoff.id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), handoff.id::text),
    handoff.preview_hash,
    jsonb_strip_nulls(jsonb_build_object(
      'leaseExpiresAt', lease_expiry,
      'claimMode', 'next',
      'executionLevel', p_execution_level,
      'accountScoped', true,
      'probeArmed', account_breaker_id IS NOT NULL,
      'recoveredState', handoff.state
    ))
  );

  RETURN handoff.id;
END
$$;

CREATE OR REPLACE FUNCTION geo.claim_next_publication_assisted_draft_prepare(
  p_lease_seconds integer DEFAULT 300
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
  SELECT geo.claim_next_publication_assisted_draft_prepare(p_lease_seconds, NULL)
$$;

CREATE OR REPLACE FUNCTION geo.claim_next_ctrip_unattended_submit()
RETURNS TABLE (handoff_id uuid, submit_permit text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  permit_value text;
  permit_hash geo.sha256_hex;
  permit_expiry timestamptz;
BEGIN
  PERFORM geo.require_ctrip_bridge_principal(actor_value);
  SELECT candidate.* INTO handoff
  FROM geo.publication_assisted_handoffs AS candidate
  JOIN geo.publication_jobs AS job
    ON job.tenant_id = candidate.tenant_id AND job.id = candidate.job_id
  JOIN geo.channel_accounts AS account
    ON account.tenant_id = candidate.tenant_id AND account.id = candidate.channel_account_id
  WHERE candidate.tenant_id = tenant_value
    AND candidate.bridge_service_principal_id = actor_value
    AND job.execution_level = 'unattended'
    AND candidate.state = 'draft_prepared'
    AND candidate.external_draft_id IS NOT NULL
    AND candidate.expires_at > statement_timestamp()
    AND candidate.submit_permit_consumed_at IS NULL
    AND (
      candidate.submit_permit_hash IS NULL OR
      candidate.submit_permit_expires_at <= statement_timestamp()
    )
    AND NOT geo.publication_account_browser_operation_busy(
      candidate.channel_account_id,
      candidate.id,
      p_block_prepared => false
    )
    AND geo.publication_assisted_block_reason(candidate.job_id) IS NULL
  ORDER BY candidate.created_at, candidate.id
  FOR UPDATE OF candidate, account SKIP LOCKED
  LIMIT 1;
  IF handoff.id IS NULL THEN RETURN; END IF;

  permit_value := encode(public.gen_random_bytes(32), 'hex');
  permit_hash := encode(public.digest(permit_value, 'sha256'), 'hex');
  permit_expiry := LEAST(handoff.expires_at, statement_timestamp() + interval '5 minutes');
  UPDATE geo.publication_assisted_handoffs AS claimed
  SET submit_permit_hash = permit_hash,
      submit_permit_expires_at = permit_expiry,
      submit_permit_consumed_at = NULL,
      submit_permit_issued_by_actor_id = NULL,
      submit_permit_issued_by_principal_id = actor_value,
      submit_permit_consumed_by_principal_id = NULL,
      updated_at = clock_timestamp()
  WHERE claimed.tenant_id = tenant_value AND claimed.id = handoff.id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.submit_permit_issued',
    'publication_assisted_handoff', handoff.id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), handoff.id::text),
    permit_hash,
    jsonb_build_object(
      'expiresAt', permit_expiry,
      'bridgePrincipalId', actor_value,
      'executionLevel', 'unattended',
      'operatorApprovalRequired', false,
      'stateTransitionDeferredUntilConsumption', true,
      'releaseMode', 'immediate',
      'accountScoped', true
    )
  );
  RETURN QUERY SELECT handoff.id, permit_value;
END
$$;

CREATE OR REPLACE FUNCTION geo.claim_next_ctrip_unattended_readback()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  lease_expiry timestamptz;
BEGIN
  PERFORM geo.expire_priority_platform_readback_windows();
  PERFORM geo.require_ctrip_bridge_principal(actor_value);
  SELECT candidate.* INTO handoff
  FROM geo.publication_assisted_handoffs AS candidate
  JOIN geo.publication_jobs AS job
    ON job.tenant_id = candidate.tenant_id AND job.id = candidate.job_id
  JOIN geo.channel_accounts AS account
    ON account.tenant_id = candidate.tenant_id AND account.id = candidate.channel_account_id
  WHERE candidate.tenant_id = tenant_value
    AND candidate.bridge_service_principal_id = actor_value
    AND job.execution_level = 'unattended'
    AND job.platform = candidate.platform
    AND job.platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community')
    AND job.channel_account_id = candidate.channel_account_id
    AND job.state IN ('dispatching', 'uncertain', 'reconciling')
    AND candidate.state IN ('readback_pending', 'awaiting_operator_submit')
    AND candidate.submit_permit_consumed_at IS NOT NULL
    AND (
      candidate.platform = 'ctrip_community'
      OR candidate.readback_deadline_at >= statement_timestamp()
    )
    AND (
      candidate.platform = 'ctrip_community'
      OR candidate.readback_attempt_count = 0
      OR candidate.updated_at <= statement_timestamp() - CASE
        WHEN COALESCE(candidate.submit_observed_at, candidate.submit_permit_consumed_at)
          >= statement_timestamp() - interval '10 minutes'
        THEN interval '1 minute'
        ELSE interval '30 minutes'
      END
    )
    AND (
      candidate.readback_owner_principal_id IS NULL OR
      candidate.readback_lease_expires_at < statement_timestamp()
    )
    AND NOT geo.publication_account_browser_operation_busy(
      candidate.channel_account_id,
      candidate.id,
      p_block_prepared => true
    )
  ORDER BY candidate.created_at, candidate.id
  FOR UPDATE OF candidate, account SKIP LOCKED
  LIMIT 1;

  IF handoff.id IS NULL THEN RETURN NULL; END IF;

  lease_expiry := statement_timestamp() + interval '5 minutes';
  UPDATE geo.publication_assisted_handoffs AS claimed
  SET readback_owner_principal_id = actor_value,
      readback_lease_expires_at = lease_expiry,
      updated_at = clock_timestamp()
  WHERE claimed.tenant_id = tenant_value AND claimed.id = handoff.id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.readback_claimed',
    'publication_assisted_handoff', handoff.id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), handoff.id::text),
    handoff.preview_hash,
    jsonb_build_object(
      'leaseExpiresAt', lease_expiry,
      'executionLevel', 'unattended',
      'platform', handoff.platform,
      'claimMode', 'automatic',
      'automaticWindowMinutes', 10,
      'postSubmitRecovery', true,
      'handoffExpired', handoff.expires_at <= statement_timestamp(),
      'accountScoped', true
    )
  );
  RETURN handoff.id;
END
$$;

REVOKE ALL ON FUNCTION geo.publication_account_browser_operation_busy(uuid, uuid, boolean)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.publication_account_browser_operation_busy(uuid, uuid, boolean)
  TO geo_runtime;
REVOKE ALL ON FUNCTION geo.claim_next_publication_assisted_draft_prepare(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.claim_next_publication_assisted_draft_prepare(integer) TO geo_runtime;
REVOKE ALL ON FUNCTION geo.claim_next_publication_assisted_draft_prepare(integer, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.claim_next_publication_assisted_draft_prepare(integer, text)
  TO geo_runtime;
REVOKE ALL ON FUNCTION geo.claim_next_ctrip_unattended_submit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.claim_next_ctrip_unattended_submit() TO geo_runtime;
REVOKE ALL ON FUNCTION geo.claim_next_ctrip_unattended_readback() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.claim_next_ctrip_unattended_readback() TO geo_runtime;

COMMENT ON FUNCTION geo.publication_account_browser_operation_busy(uuid, uuid, boolean) IS
  'Reports durable account-scoped browser work so claimers serialize one account while allowing different accounts to run concurrently';
COMMENT ON FUNCTION geo.claim_next_ctrip_unattended_submit() IS
  'Claims one unattended submit while locking and reserving only its channel account';
COMMENT ON FUNCTION geo.claim_next_ctrip_unattended_readback() IS
  'Claims asynchronous readback at account scope without colliding with active browser preparation or submit work';

COMMIT;
