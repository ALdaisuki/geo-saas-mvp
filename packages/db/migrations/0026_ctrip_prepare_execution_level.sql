-- Keep the shared preparation lease compatible with both browser modes while
-- preventing an unattended Bridge from claiming legacy assisted handoffs.
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
BEGIN
  IF p_lease_seconds NOT BETWEEN 30 AND 600 THEN
    RAISE EXCEPTION 'draft preparation lease must be between 30 and 600 seconds'
      USING ERRCODE = '22023';
  END IF;
  IF p_execution_level NOT IN ('assisted', 'unattended') THEN
    RAISE EXCEPTION 'unsupported draft preparation execution level'
      USING ERRCODE = '22023';
  END IF;
  PERFORM geo.require_ctrip_bridge_principal(actor_value);

  SELECT candidate.* INTO handoff
  FROM geo.publication_assisted_handoffs AS candidate
  JOIN geo.publication_jobs AS job
    ON job.tenant_id = candidate.tenant_id AND job.id = candidate.job_id
  WHERE candidate.tenant_id = tenant_value
    AND candidate.bridge_service_principal_id = actor_value
    AND job.execution_level = p_execution_level
    AND candidate.state = 'handoff_pending'
    AND candidate.expires_at > statement_timestamp()
    AND (
      candidate.draft_prepare_owner_principal_id IS NULL OR
      candidate.draft_prepare_lease_expires_at < statement_timestamp()
    )
    AND geo.publication_assisted_block_reason(candidate.job_id) IS NULL
  ORDER BY candidate.created_at, candidate.id
  FOR UPDATE OF candidate SKIP LOCKED
  LIMIT 1;

  IF handoff.id IS NULL THEN
    RETURN NULL;
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
    jsonb_build_object(
      'leaseExpiresAt', lease_expiry,
      'claimMode', 'next',
      'executionLevel', p_execution_level
    )
  );

  RETURN handoff.id;
END
$$;

REVOKE ALL ON FUNCTION geo.claim_next_publication_assisted_draft_prepare(integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.claim_next_publication_assisted_draft_prepare(integer, text) TO geo_runtime;
