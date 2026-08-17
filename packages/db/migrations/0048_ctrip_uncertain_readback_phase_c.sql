-- A browser submit observation can remain uncertain even when an independent,
-- content-bound public readback later proves that the exact canary was published.
-- Preserve the original observation and admit that reconciled outcome to Phase C.

CREATE OR REPLACE FUNCTION geo.ctrip_phase_b_canary_succeeded(p_channel_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
BEGIN
  PERFORM geo.require_actor_id();
  IF p_channel_account_id IS NULL THEN RETURN false; END IF;

  RETURN EXISTS (
    SELECT 1
    FROM geo.ctrip_phase_b_canaries AS canary
    JOIN geo.publication_assisted_handoffs AS handoff
      ON handoff.tenant_id = canary.tenant_id
     AND handoff.id = canary.handoff_id
     AND handoff.channel_account_id = canary.channel_account_id
    JOIN geo.publication_jobs AS job
      ON job.tenant_id = handoff.tenant_id
     AND job.id = handoff.job_id
    WHERE canary.tenant_id = tenant_value
      AND canary.channel_account_id = p_channel_account_id
      AND job.execution_level = 'assisted'
      AND handoff.state = 'confirmed'
      AND handoff.submit_permit_issued_by_actor_id = canary.authorized_by_actor_id
      AND handoff.submit_permit_issued_by_principal_id IS NULL
      AND handoff.submit_permit_consumed_at IS NOT NULL
      AND handoff.submit_permit_consumed_by_principal_id = handoff.bridge_service_principal_id
      AND handoff.submit_outcome IN ('accepted', 'uncertain')
      AND handoff.submit_evidence_kind = 'browser'
      AND handoff.submit_evidence_hash IS NOT NULL
      AND handoff.readback_outcome = 'confirmed'
      AND handoff.readback_evidence_kind = 'platform_readback'
      AND handoff.readback_evidence_hash IS NOT NULL
      AND handoff.public_content_hash IS NOT NULL
      AND handoff.observed_payload_hash = handoff.public_content_hash
      AND handoff.external_id IS NOT NULL
      AND handoff.external_url IS NOT NULL
  );
END
$$;

REVOKE ALL ON FUNCTION geo.ctrip_phase_b_canary_succeeded(uuid)
  FROM PUBLIC, geo_runtime, geo_dispatcher, geo_identity;
GRANT EXECUTE ON FUNCTION geo.ctrip_phase_b_canary_succeeded(uuid) TO geo_runtime;

COMMENT ON FUNCTION geo.ctrip_phase_b_canary_succeeded(uuid) IS
  'True for an accepted submit or an uncertain submit reconciled by matching content-bound public readback';
