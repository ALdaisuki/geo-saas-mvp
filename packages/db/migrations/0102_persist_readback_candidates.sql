BEGIN;

CREATE OR REPLACE FUNCTION geo.record_publication_assisted_candidate_discovery(
  p_handoff_id uuid,
  p_external_id text,
  p_external_url text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  normalized_external_id text := NULLIF(trim(p_external_id), '');
  normalized_external_url text := NULLIF(trim(p_external_url), '');
BEGIN
  IF normalized_external_id IS NULL OR normalized_external_url IS NULL
     OR length(normalized_external_id) > 200
     OR length(normalized_external_url) > 2000 THEN
    RAISE EXCEPTION 'readback candidate identity is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs
  WHERE tenant_id = tenant_value AND id = p_handoff_id
  FOR UPDATE;
  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'publication assisted handoff was not found' USING ERRCODE = 'P0002';
  END IF;
  IF handoff.bridge_service_principal_id <> actor_value
     OR handoff.state NOT IN ('readback_pending', 'needs_review') THEN
    RAISE EXCEPTION 'publication assisted readback candidate is not writable' USING ERRCODE = '55000';
  END IF;
  IF NOT geo.browser_publication_identity_allowed(
    handoff.platform,
    normalized_external_id,
    normalized_external_url
  ) THEN
    RAISE EXCEPTION 'readback candidate identity is outside the platform allowlist'
      USING ERRCODE = '22023';
  END IF;
  IF (handoff.submit_candidate_external_id IS NOT NULL
      AND handoff.submit_candidate_external_id <> normalized_external_id)
     OR (handoff.submit_candidate_external_url IS NOT NULL
      AND handoff.submit_candidate_external_url <> normalized_external_url) THEN
    RAISE EXCEPTION 'readback candidate identity conflicts with the submitted candidate'
      USING ERRCODE = '55000';
  END IF;

  UPDATE geo.publication_assisted_handoffs
  SET submit_candidate_external_id = normalized_external_id,
      submit_candidate_external_url = normalized_external_url,
      updated_at = clock_timestamp()
  WHERE tenant_id = tenant_value AND id = p_handoff_id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, details
  ) VALUES (
    tenant_value,
    actor_value,
    'publication_assisted_handoff.readback_candidate_recorded',
    'publication_assisted_handoff',
    p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    jsonb_build_object(
      'platform', handoff.platform,
      'externalIdHash', encode(public.digest(normalized_external_id, 'sha256'), 'hex'),
      'externalUrlHash', encode(public.digest(normalized_external_url, 'sha256'), 'hex')
    )
  );
END
$$;

REVOKE ALL ON FUNCTION geo.record_publication_assisted_candidate_discovery(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_candidate_discovery(uuid, text, text)
  TO geo_runtime;

COMMIT;
