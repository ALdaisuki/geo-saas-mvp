BEGIN;

-- 0141 expanded the generic publication constraints and grant admission, but
-- the handoff creation function still carried the pre-Zhihu platform list.
-- Replace that function explicitly so an assisted Zhihu job can create its
-- audited browser handoff before any browser work starts.
CREATE OR REPLACE FUNCTION geo.create_publication_assisted_handoff(
  p_handoff_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_bridge_service_principal_id uuid,
  p_preview_hash geo.sha256_hex,
  p_adapter_version text,
  p_idempotency_key text,
  p_expires_at timestamptz
)
RETURNS TABLE (
  publication_assisted_handoff_id uuid,
  was_created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  job geo.publication_jobs%ROWTYPE;
  attempt geo.publication_attempts%ROWTYPE;
  artifact geo.audit_artifacts%ROWTYPE;
  existing geo.publication_assisted_handoffs%ROWTYPE;
  block_reason text;
BEGIN
  IF p_handoff_id IS NULL OR p_job_id IS NULL OR p_attempt_id IS NULL
     OR p_adapter_version IS NULL
     OR length(trim(p_adapter_version)) NOT BETWEEN 1 AND 100
     OR p_idempotency_key IS NULL
     OR length(p_idempotency_key) NOT BETWEEN 1 AND 200
     OR p_expires_at <= statement_timestamp()
     OR p_expires_at > statement_timestamp() + interval '2 hours' THEN
    RAISE EXCEPTION 'invalid assisted handoff arguments'
      USING ERRCODE = '22023';
  END IF;

  PERFORM geo.require_ctrip_bridge_principal(p_bridge_service_principal_id);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    tenant_value::text || ':assisted-handoff:' || p_job_id::text,
    0
  ));

  SELECT * INTO job
  FROM geo.publication_jobs AS publication_job
  WHERE publication_job.tenant_id = tenant_value
    AND publication_job.id = p_job_id;

  SELECT * INTO existing
  FROM geo.publication_assisted_handoffs AS handoff
  WHERE handoff.tenant_id = tenant_value
    AND handoff.job_id = p_job_id;

  IF existing.id IS NOT NULL THEN
    IF job.id IS NULL
       OR existing.id <> p_handoff_id
       OR existing.attempt_id <> p_attempt_id
       OR existing.bridge_service_principal_id <> p_bridge_service_principal_id
       OR existing.preview_hash <> p_preview_hash
       OR existing.adapter_version <> trim(p_adapter_version)
       OR existing.idempotency_key <> p_idempotency_key
       OR existing.channel_account_id <> job.channel_account_id
       OR existing.variant_id <> job.variant_id
       OR existing.platform <> job.platform
       OR existing.payload_hash <> job.payload_hash THEN
      RAISE EXCEPTION 'assisted handoff idempotency conflict'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT existing.id, false;
    RETURN;
  END IF;

  block_reason := geo.publication_assisted_block_reason(p_job_id);
  IF block_reason IS NOT NULL THEN
    RAISE EXCEPTION 'assisted handoff blocked: %', block_reason
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO job
  FROM geo.publication_jobs AS publication_job
  WHERE publication_job.tenant_id = tenant_value
    AND publication_job.id = p_job_id
  FOR UPDATE;

  SELECT * INTO attempt
  FROM geo.publication_attempts AS publication_attempt
  WHERE publication_attempt.tenant_id = tenant_value
    AND publication_attempt.id = p_attempt_id
    AND publication_attempt.job_id = p_job_id
  FOR UPDATE;

  SELECT * INTO artifact
  FROM geo.audit_artifacts AS audit_artifact
  WHERE audit_artifact.tenant_id = tenant_value
    AND audit_artifact.id = job.audit_artifact_id;

  IF job.id IS NULL
     OR job.platform NOT IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community', 'zhihu')
     OR job.state <> 'dispatching'
     OR job.lease_owner IS NULL
     OR job.lease_expires_at < statement_timestamp()
     OR attempt.id IS NULL
     OR attempt.state <> 'started'
     OR attempt.request_hash <> job.request_hash
     OR artifact.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff requires an active audited publication attempt'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO geo.publication_assisted_handoffs (
    tenant_id, id, job_id, attempt_id, bridge_service_principal_id,
    channel_account_id, variant_id, platform, state, payload_hash, audit_hash,
    preview_hash, adapter_version, idempotency_key, expires_at, created_by_actor_id
  ) VALUES (
    tenant_value, p_handoff_id, job.id, attempt.id, p_bridge_service_principal_id,
    job.channel_account_id, job.variant_id, job.platform, 'handoff_pending',
    job.payload_hash, artifact.audit_hash, p_preview_hash, trim(p_adapter_version),
    p_idempotency_key, p_expires_at, actor_value
  );

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.created',
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_idempotency_key),
    p_preview_hash,
    jsonb_build_object(
      'jobId', job.id,
      'attemptId', attempt.id,
      'bridgePrincipalId', p_bridge_service_principal_id,
      'platform', job.platform,
      'adapterVersion', trim(p_adapter_version),
      'expiresAt', p_expires_at
    )
  );

  RETURN QUERY SELECT p_handoff_id, true;
END
$$;

COMMIT;
