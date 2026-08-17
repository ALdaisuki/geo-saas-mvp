-- Keep unattended handoffs retryable until the bridge atomically consumes the
-- one-time submit permit immediately before the external write.

ALTER TABLE geo.publication_assisted_handoffs
  DISABLE TRIGGER publication_assisted_handoffs_transition_only;

WITH repaired AS (
  UPDATE geo.publication_assisted_handoffs AS handoff
  SET state = 'draft_prepared', updated_at = clock_timestamp()
  FROM geo.publication_jobs AS job
  WHERE job.tenant_id = handoff.tenant_id
    AND job.id = handoff.job_id
    AND job.execution_level = 'unattended'
    AND handoff.state = 'awaiting_operator_submit'
    AND handoff.submit_permit_consumed_at IS NULL
  RETURNING handoff.tenant_id, handoff.id, handoff.bridge_service_principal_id,
            handoff.submit_permit_hash
)
INSERT INTO geo.audit_log (
  tenant_id, actor_id, action, resource_type, resource_id,
  request_id, after_hash, details
)
SELECT tenant_id, bridge_service_principal_id,
       'publication_assisted_handoff.unconsumed_permit_recovered',
       'publication_assisted_handoff', id, id::text, submit_permit_hash,
       jsonb_build_object(
         'executionLevel', 'unattended',
         'externalWriteObserved', false,
         'reason', 'migration_recovered_before_permit_consumption'
       )
FROM repaired
WHERE bridge_service_principal_id IS NOT NULL;

ALTER TABLE geo.publication_assisted_handoffs
  ENABLE TRIGGER publication_assisted_handoffs_transition_only;

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
    AND geo.publication_assisted_block_reason(candidate.job_id) IS NULL
  ORDER BY candidate.created_at, candidate.id
  FOR UPDATE OF candidate SKIP LOCKED
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
      'stateTransitionDeferredUntilConsumption', true
    )
  );
  RETURN QUERY SELECT handoff.id, permit_value;
END
$$;

CREATE OR REPLACE FUNCTION geo.consume_publication_assisted_submit_permit(
  p_handoff_id uuid,
  p_submit_permit text
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
  job geo.publication_jobs%ROWTYPE;
  permit_hash geo.sha256_hex;
  block_reason text;
BEGIN
  IF p_submit_permit IS NULL OR p_submit_permit !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid submit permit' USING ERRCODE = '22023';
  END IF;
  permit_hash := encode(public.digest(p_submit_permit, 'sha256'), 'hex');

  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id
  FOR UPDATE;
  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO job
  FROM geo.publication_jobs AS publication_job
  WHERE publication_job.tenant_id = tenant_value
    AND publication_job.id = handoff.job_id;

  IF job.execution_level = 'unattended' THEN
    IF handoff.state <> 'draft_prepared'
       OR handoff.bridge_service_principal_id <> actor_value
       OR handoff.submit_permit_issued_by_principal_id <> actor_value
       OR handoff.lease_owner_actor_id IS NOT NULL THEN
      RAISE EXCEPTION 'unattended submit permit requires the prepared handoff and bound bridge principal'
        USING ERRCODE = '55006';
    END IF;
  ELSIF job.execution_level = 'assisted' THEN
    IF handoff.state <> 'awaiting_operator_submit'
       OR handoff.lease_owner_actor_id IS NULL
       OR handoff.lease_expires_at < statement_timestamp()
       OR handoff.submit_permit_issued_by_actor_id <> handoff.lease_owner_actor_id THEN
      RAISE EXCEPTION 'submit permit requires its current issuing operator lease'
        USING ERRCODE = '55006';
    END IF;
  ELSE
    RAISE EXCEPTION 'submit permit requires an assisted or unattended browser job'
      USING ERRCODE = '55000';
  END IF;

  IF handoff.submit_permit_hash <> permit_hash
     OR handoff.submit_permit_expires_at <= statement_timestamp()
     OR handoff.submit_permit_consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'submit permit is invalid, expired, or already consumed'
      USING ERRCODE = '42501';
  END IF;
  block_reason := geo.publication_assisted_block_reason(handoff.job_id);
  IF block_reason IS NOT NULL THEN
    RAISE EXCEPTION 'submit permit blocked: %', block_reason USING ERRCODE = '42501';
  END IF;

  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = CASE
        WHEN job.execution_level = 'unattended' THEN 'awaiting_operator_submit'
        ELSE assisted_handoff.state
      END,
      submit_permit_consumed_at = statement_timestamp(),
      submit_permit_consumed_by_principal_id = actor_value,
      updated_at = clock_timestamp()
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id
    AND assisted_handoff.submit_permit_consumed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submit permit was concurrently consumed' USING ERRCODE = '40001';
  END IF;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.submit_permit_consumed',
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    permit_hash,
    jsonb_build_object(
      'confirmed', false,
      'externalWriteObserved', false,
      'executionLevel', job.execution_level,
      'stateTransitionCommitted', job.execution_level = 'unattended'
    )
  );
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION geo.claim_next_ctrip_unattended_submit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.claim_next_ctrip_unattended_submit() TO geo_runtime;
REVOKE ALL ON FUNCTION geo.consume_publication_assisted_submit_permit(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.consume_publication_assisted_submit_permit(uuid, text)
  TO geo_runtime;
