BEGIN;

-- Priority-platform moderation is polled automatically for ten minutes after
-- the one-shot submit boundary. The targeted claim function is intentionally
-- unchanged so an operator can request a later manual public readback while
-- the handoff remains readback_pending.
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
  PERFORM geo.require_ctrip_bridge_principal(actor_value);
  SELECT candidate.* INTO handoff
  FROM geo.publication_assisted_handoffs AS candidate
  JOIN geo.publication_jobs AS job
    ON job.tenant_id = candidate.tenant_id AND job.id = candidate.job_id
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
      OR COALESCE(candidate.submit_observed_at, candidate.submit_permit_consumed_at)
        >= statement_timestamp() - interval '10 minutes'
    )
    AND (
      candidate.readback_owner_principal_id IS NULL OR
      candidate.readback_lease_expires_at < statement_timestamp()
    )
  ORDER BY candidate.created_at, candidate.id
  FOR UPDATE OF candidate SKIP LOCKED
  LIMIT 1;

  IF handoff.id IS NULL THEN RETURN NULL; END IF;

  lease_expiry := statement_timestamp() + interval '5 minutes';
  UPDATE geo.publication_assisted_handoffs AS claimed
  SET readback_owner_principal_id = actor_value,
      readback_lease_expires_at = lease_expiry
  WHERE claimed.tenant_id = tenant_value AND claimed.id = handoff.id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value,
    actor_value,
    'publication_assisted_handoff.readback_claimed',
    'publication_assisted_handoff',
    handoff.id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), handoff.id::text),
    handoff.preview_hash,
    jsonb_build_object(
      'leaseExpiresAt', lease_expiry,
      'executionLevel', 'unattended',
      'platform', handoff.platform,
      'claimMode', 'automatic',
      'automaticWindowMinutes', 10,
      'postSubmitRecovery', true,
      'handoffExpired', handoff.expires_at <= statement_timestamp()
    )
  );
  RETURN handoff.id;
END
$$;

COMMENT ON FUNCTION geo.claim_next_ctrip_unattended_readback() IS
  'Claims automatic browser readback within ten minutes for priority platforms while preserving targeted operator queries';

REVOKE ALL ON FUNCTION geo.claim_next_ctrip_unattended_readback() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.claim_next_ctrip_unattended_readback() TO geo_runtime;

COMMIT;
