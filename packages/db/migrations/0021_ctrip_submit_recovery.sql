CREATE OR REPLACE FUNCTION geo.recover_publication_assisted_submit_uncertain(
  p_handoff_id uuid,
  p_evidence_kind text
)
RETURNS TABLE (
  publication_receipt_id uuid,
  publication_readback_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_bound_ctrip_bridge(p_handoff_id);
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  evidence_hash_value geo.sha256_hex;
  receipt_value uuid;
  readback_value uuid;
BEGIN
  IF p_evidence_kind IS NULL OR p_evidence_kind NOT IN ('simulation', 'browser') THEN
    RAISE EXCEPTION 'invalid assisted submit recovery evidence kind'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id
  FOR UPDATE;

  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002';
  END IF;

  IF handoff.submit_outcome IS NOT NULL THEN
    IF handoff.publication_receipt_id IS NULL OR handoff.publication_readback_id IS NULL THEN
      RAISE EXCEPTION 'durable submit observation is missing reconciliation evidence'
        USING ERRCODE = '55000';
    END IF;
    RETURN QUERY SELECT handoff.publication_receipt_id, handoff.publication_readback_id;
    RETURN;
  END IF;

  IF handoff.state <> 'awaiting_operator_submit'
     OR handoff.submit_permit_consumed_at IS NULL
     OR handoff.submit_permit_consumed_by_principal_id <> actor_value
     OR handoff.submit_permit_issued_by_actor_id IS NULL
     OR handoff.submit_evidence_hash IS NOT NULL THEN
    RAISE EXCEPTION 'submit recovery requires one consumed bound permit'
      USING ERRCODE = '55000';
  END IF;

  evidence_hash_value := encode(public.digest(
    'geo.ctrip-submit-recovery.v1|' || handoff.id::text || '|' ||
    handoff.preview_hash::text || '|' ||
    extract(epoch from handoff.submit_permit_consumed_at)::text || '|' ||
    handoff.adapter_version || '|' || p_evidence_kind,
    'sha256'
  ), 'hex');

  SELECT observed.publication_receipt_id, observed.publication_readback_id
  INTO receipt_value, readback_value
  FROM geo.record_publication_assisted_submit_observation(
    p_handoff_id,
    'uncertain',
    p_evidence_kind,
    evidence_hash_value,
    statement_timestamp()
  ) AS observed;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value,
    'publication_assisted_handoff.submit_observation_recovered',
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    evidence_hash_value,
    jsonb_build_object(
      'outcome', 'uncertain',
      'evidenceKind', p_evidence_kind,
      'permitConsumedAt', handoff.submit_permit_consumed_at,
      'receiptId', receipt_value,
      'readbackId', readback_value,
      'retryForbidden', true
    )
  );

  RETURN QUERY SELECT receipt_value, readback_value;
END
$$;

REVOKE ALL ON FUNCTION geo.recover_publication_assisted_submit_uncertain(
  uuid, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION geo.recover_publication_assisted_submit_uncertain(
  uuid, text
) TO geo_runtime;
