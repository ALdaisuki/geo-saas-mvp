CREATE OR REPLACE FUNCTION geo.claim_ctrip_unattended_readback(p_handoff_id uuid)
RETURNS boolean
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
    AND candidate.id = p_handoff_id
    AND candidate.bridge_service_principal_id = actor_value
    AND job.execution_level = 'unattended'
    AND job.platform = 'ctrip_community'
    AND job.state IN ('dispatching', 'uncertain', 'reconciling')
    AND candidate.state = 'readback_pending'
    AND candidate.submit_permit_consumed_at IS NOT NULL
  FOR UPDATE OF candidate;

  IF handoff.id IS NULL THEN RETURN false; END IF;
  IF handoff.readback_owner_principal_id IS NOT NULL
     AND handoff.readback_owner_principal_id <> actor_value
     AND handoff.readback_lease_expires_at >= statement_timestamp() THEN
    RETURN false;
  END IF;

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
      'claimMode', 'targeted',
      'postSubmitRecovery', true,
      'handoffExpired', handoff.expires_at <= statement_timestamp()
    )
  );
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION geo.claim_ctrip_unattended_readback(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.claim_ctrip_unattended_readback(uuid) TO geo_runtime;
