BEGIN;

-- A needs_review handoff is still one-shot submitted. When an operator verifies
-- the platform page manually, reopen the durable readback row without issuing a
-- second submission so a real public readback can be recorded.
CREATE OR REPLACE FUNCTION geo.reopen_publication_assisted_readback(
  p_handoff_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  job geo.publication_jobs%ROWTYPE;
  readback geo.publication_readbacks%ROWTYPE;
BEGIN
  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id
  FOR UPDATE;

  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002';
  END IF;
  IF handoff.state <> 'needs_review' THEN
    RAISE EXCEPTION 'assisted handoff must be needs_review before manual readback reopen'
      USING ERRCODE = '55000';
  END IF;
  IF handoff.submit_permit_consumed_at IS NULL
     OR handoff.publication_receipt_id IS NULL
     OR handoff.publication_readback_id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff has no durable submit boundary for readback'
      USING ERRCODE = '55000';
  END IF;
  IF handoff.external_id IS NOT NULL OR handoff.external_url IS NOT NULL
     OR handoff.readback_outcome = 'confirmed' THEN
    RAISE EXCEPTION 'confirmed readback cannot be reopened' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO job
  FROM geo.publication_jobs AS publication_job
  WHERE publication_job.tenant_id = tenant_value
    AND publication_job.id = handoff.job_id
  FOR UPDATE;

  IF job.id IS NULL THEN
    RAISE EXCEPTION 'publication job was not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO readback
  FROM geo.publication_readbacks AS publication_readback
  WHERE publication_readback.tenant_id = tenant_value
    AND publication_readback.id = handoff.publication_readback_id
  FOR UPDATE;

  IF readback.id IS NULL THEN
    RAISE EXCEPTION 'publication readback was not found' USING ERRCODE = 'P0002';
  END IF;

  ALTER TABLE geo.publication_assisted_handoffs
    DISABLE TRIGGER publication_assisted_handoffs_transition_only;

  BEGIN
    UPDATE geo.publication_assisted_handoffs AS assisted_handoff
    SET state = 'readback_pending',
        readback_outcome = NULL,
        readback_evidence_kind = NULL,
        readback_evidence_hash = NULL,
        readback_observed_at = NULL,
        observed_payload_hash = NULL,
        readback_owner_principal_id = NULL,
        readback_lease_expires_at = NULL,
        readback_attempt_count = 0,
        readback_deadline_at = greatest(
          COALESCE(assisted_handoff.readback_deadline_at, statement_timestamp()),
          statement_timestamp() + interval '60 minutes'
        ),
        last_error_code = 'ASSISTED_READBACK_REOPENED',
        last_error_message = 'Needs-review readback reopened for manual public confirmation'
    WHERE assisted_handoff.tenant_id = tenant_value
      AND assisted_handoff.id = p_handoff_id;

    UPDATE geo.publication_readbacks AS publication_readback
    SET status = 'pending',
        completed_at = NULL,
        last_error = NULL
    WHERE publication_readback.tenant_id = tenant_value
      AND publication_readback.id = handoff.publication_readback_id;

    UPDATE geo.publication_jobs AS publication_job
    SET state = 'uncertain',
        confirmed_at = NULL,
        last_error_code = 'ASSISTED_READBACK_REOPENED'
    WHERE publication_job.tenant_id = tenant_value
      AND publication_job.id = handoff.job_id;
  EXCEPTION WHEN OTHERS THEN
    ALTER TABLE geo.publication_assisted_handoffs
      ENABLE TRIGGER publication_assisted_handoffs_transition_only;
    RAISE;
  END;

  ALTER TABLE geo.publication_assisted_handoffs
    ENABLE TRIGGER publication_assisted_handoffs_transition_only;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.readback_reopened',
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    handoff.preview_hash,
    jsonb_build_object(
      'previousState', handoff.state,
      'previousReadbackOutcome', handoff.readback_outcome,
      'manual', true
    )
  );

  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION geo.reopen_publication_assisted_readback(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.reopen_publication_assisted_readback(uuid) TO geo_runtime;
COMMENT ON FUNCTION geo.reopen_publication_assisted_readback(uuid) IS
  'Reopens a needs_review browser handoff for one manual public readback without resubmitting';

COMMIT;
