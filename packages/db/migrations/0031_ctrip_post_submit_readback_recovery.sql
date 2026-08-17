ALTER TABLE geo.publication_assisted_handoffs
  DROP CONSTRAINT publication_assisted_handoff_readback_lease_complete;

ALTER TABLE geo.publication_assisted_handoffs
  ADD CONSTRAINT publication_assisted_handoff_readback_lease_complete
    CHECK (
      (readback_owner_principal_id IS NULL AND readback_lease_expires_at IS NULL) OR
      (readback_owner_principal_id IS NOT NULL AND readback_lease_expires_at IS NOT NULL)
    ) NOT VALID;

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
    AND job.platform = 'ctrip_community'
    AND job.state IN ('dispatching', 'uncertain', 'reconciling')
    AND candidate.state IN ('readback_pending', 'awaiting_operator_submit')
    AND candidate.submit_permit_consumed_at IS NOT NULL
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
      'postSubmitRecovery', true,
      'handoffExpired', handoff.expires_at <= statement_timestamp()
    )
  );
  RETURN handoff.id;
END
$$;

ALTER TABLE geo.publication_assisted_handoffs
  VALIDATE CONSTRAINT publication_assisted_handoff_readback_lease_complete;

REVOKE ALL ON FUNCTION geo.claim_next_ctrip_unattended_readback() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.claim_next_ctrip_unattended_readback() TO geo_runtime;
