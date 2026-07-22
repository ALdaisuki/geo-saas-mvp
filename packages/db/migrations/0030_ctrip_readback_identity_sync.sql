-- A browser submit can cross the publish boundary before the bridge observes
-- a candidate URL. Once an independent public readback confirms the audited
-- payload, make the durable candidate and readback audit reflect that evidence.
CREATE OR REPLACE FUNCTION geo.prepare_ctrip_readback_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF NEW.state <> 'confirmed'
     OR NEW.readback_outcome <> 'confirmed'
     OR NEW.readback_evidence_kind <> 'platform_readback'
     OR NEW.submit_evidence_kind <> 'browser'
     OR NEW.external_id IS NULL
     OR NEW.external_url IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.submit_candidate_external_id IS NOT NULL
     AND (NEW.submit_candidate_external_id IS DISTINCT FROM NEW.external_id
          OR NEW.submit_candidate_external_url IS DISTINCT FROM NEW.external_url) THEN
    RAISE EXCEPTION 'confirmed readback conflicts with submit candidate identity'
      USING ERRCODE = '23514';
  END IF;

  NEW.submit_candidate_external_id := COALESCE(NEW.submit_candidate_external_id, NEW.external_id);
  NEW.submit_candidate_external_url := COALESCE(NEW.submit_candidate_external_url, NEW.external_url);
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION geo.sync_ctrip_readback_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF NEW.state <> 'confirmed'
     OR NEW.readback_outcome <> 'confirmed'
     OR NEW.readback_evidence_kind <> 'platform_readback'
     OR NEW.external_id IS NULL
     OR NEW.external_url IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    NEW.tenant_id,
    NEW.bridge_service_principal_id,
    'publication_assisted_handoff.readback_identity_reconciled',
    'publication_assisted_handoff',
    NEW.id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), NEW.id::text),
    NEW.readback_evidence_hash,
    jsonb_build_object(
      'externalIdHash', encode(public.digest(NEW.external_id, 'sha256'), 'hex'),
      'externalUrlHash', encode(public.digest(NEW.external_url, 'sha256'), 'hex'),
      'receiptId', NEW.publication_receipt_id,
      'evidenceKind', NEW.readback_evidence_kind
    )
  );

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION geo.prepare_ctrip_readback_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.sync_ctrip_readback_identity() FROM PUBLIC;

CREATE TRIGGER publication_assisted_handoffs_readback_identity_prepare
BEFORE UPDATE OF state ON geo.publication_assisted_handoffs
FOR EACH ROW EXECUTE FUNCTION geo.prepare_ctrip_readback_identity();

CREATE TRIGGER publication_assisted_handoff_readback_identity_sync
AFTER UPDATE OF state ON geo.publication_assisted_handoffs
FOR EACH ROW EXECUTE FUNCTION geo.sync_ctrip_readback_identity();
