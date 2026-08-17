-- Offline historical publication imports are an append-only source for duplicate-content audit.
-- They deliberately do not fabricate campaigns, grants, jobs, attempts, or live publication receipts.

CREATE TABLE geo.historical_publications (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_account_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'ctrip_community'
    CHECK (platform = 'ctrip_community'),
  external_id text NOT NULL CHECK (external_id ~ '^[0-9]{1,20}$'),
  external_url text NOT NULL,
  normalized_title text NOT NULL CHECK (length(normalized_title) BETWEEN 1 AND 1000),
  normalized_body text NOT NULL CHECK (length(normalized_body) BETWEEN 1 AND 1000000),
  public_content_hash geo.sha256_hex NOT NULL,
  published_at timestamptz,
  observed_at timestamptz NOT NULL,
  source_evidence_hash geo.sha256_hex NOT NULL,
  source_reference text NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 2000),
  bound_by_actor_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (
    length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  request_hash geo.sha256_hex NOT NULL,
  audit_log_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, platform, external_id),
  UNIQUE (tenant_id, platform, external_url),
  UNIQUE (tenant_id, platform, public_content_hash),
  FOREIGN KEY (tenant_id, channel_account_id, platform)
    REFERENCES geo.channel_accounts (tenant_id, id, platform) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, bound_by_actor_id)
    REFERENCES geo.tenant_memberships (tenant_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, audit_log_id)
    REFERENCES geo.audit_log (tenant_id, id) ON DELETE RESTRICT,
  CHECK (
    external_url = 'https://m.ctrip.com/webapp/you/community/detail?articleId=' || external_id
  ),
  CHECK (published_at IS NULL OR published_at <= observed_at)
);

CREATE INDEX historical_publications_audit_history
  ON geo.historical_publications (tenant_id, observed_at DESC, id DESC);

CREATE TRIGGER historical_publications_append_only
BEFORE UPDATE OR DELETE ON geo.historical_publications
FOR EACH ROW EXECUTE FUNCTION geo.prevent_append_only_mutation();

ALTER TABLE geo.historical_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.historical_publications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON geo.historical_publications TO geo_runtime
  USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

CREATE OR REPLACE FUNCTION geo.ctrip_protected_history_baseline_bound(
  p_channel_account_id uuid
)
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
    FROM geo.historical_publications AS history
    WHERE history.tenant_id = tenant_value
      AND history.channel_account_id = p_channel_account_id
      AND history.platform = 'ctrip_community'
      AND history.external_id = '123450005'
      AND history.external_url =
        'https://m.ctrip.com/webapp/you/community/detail?articleId=123450005'
  );
END
$$;

REVOKE ALL ON FUNCTION geo.ctrip_protected_history_baseline_bound(uuid)
  FROM PUBLIC, geo_runtime, geo_dispatcher, geo_identity;

REVOKE ALL ON TABLE geo.historical_publications
  FROM PUBLIC, geo_dispatcher, geo_identity, geo_runtime;
GRANT SELECT ON TABLE geo.historical_publications TO geo_runtime;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE geo.historical_publications FROM geo_runtime;

CREATE OR REPLACE FUNCTION geo.bind_historical_publication(
  p_channel_account_id uuid,
  p_external_id text,
  p_external_url text,
  p_normalized_title text,
  p_normalized_body text,
  p_public_content_hash geo.sha256_hex,
  p_published_at timestamptz,
  p_observed_at timestamptz,
  p_source_evidence_hash geo.sha256_hex,
  p_source_reference text,
  p_idempotency_key text,
  p_request_hash geo.sha256_hex
)
RETURNS TABLE (
  historical_publication_id uuid,
  binding_audit_log_id uuid,
  was_created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  request_id_value text := NULLIF(current_setting('app.request_id', true), '');
  expected_url text;
  expected_content_hash text;
  existing geo.historical_publications%ROWTYPE;
  conflicting_id uuid;
  history_value uuid := gen_random_uuid();
  audit_value uuid := gen_random_uuid();
BEGIN
  IF request_id_value IS NULL OR length(request_id_value) > 200 THEN
    RAISE EXCEPTION 'a bounded app.request_id transaction context is required'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM geo.tenant_memberships AS membership
    JOIN geo.tenants AS tenant
      ON tenant.id = membership.tenant_id
     AND tenant.status = 'active'
    WHERE membership.tenant_id = tenant_value
      AND membership.user_id = actor_value
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'historical publication binding requires an active tenant owner or admin'
      USING ERRCODE = '42501';
  END IF;
  IF p_channel_account_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM geo.channel_accounts AS account
    WHERE account.tenant_id = tenant_value
      AND account.id = p_channel_account_id
      AND account.platform = 'ctrip_community'
  ) THEN
    RAISE EXCEPTION 'historical publication channel account is not a tenant Ctrip account'
      USING ERRCODE = '42501';
  END IF;
  IF p_external_id IS NULL OR p_external_id !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'historical Ctrip external ID must contain 1 to 20 digits'
      USING ERRCODE = '22023';
  END IF;
  expected_url := 'https://m.ctrip.com/webapp/you/community/detail?articleId=' || p_external_id;
  IF p_external_url IS DISTINCT FROM expected_url THEN
    RAISE EXCEPTION 'historical Ctrip external URL must be canonical and match the external ID'
      USING ERRCODE = '22023';
  END IF;
  IF p_normalized_title IS NULL
     OR length(p_normalized_title) NOT BETWEEN 1 AND 1000
     OR p_normalized_title ~ '[[:cntrl:]]'
     OR p_normalized_title IS DISTINCT FROM
       btrim(regexp_replace(normalize(p_normalized_title, NFC), '[[:space:]]+', ' ', 'g')) THEN
    RAISE EXCEPTION 'historical publication title is not normalized public content'
      USING ERRCODE = '22023';
  END IF;
  IF p_normalized_body IS NULL
     OR length(p_normalized_body) NOT BETWEEN 1 AND 1000000
     OR p_normalized_body ~ '[[:cntrl:]]'
     OR p_normalized_body IS DISTINCT FROM
       btrim(regexp_replace(normalize(p_normalized_body, NFC), '[[:space:]]+', ' ', 'g')) THEN
    RAISE EXCEPTION 'historical publication body is not normalized public content'
      USING ERRCODE = '22023';
  END IF;
  expected_content_hash := encode(
    public.digest(
      convert_to(
        '{"body":' || to_jsonb(p_normalized_body)::text ||
        ',"schemaVersion":"geo.ctrip-public-content.v1","title":' ||
        to_jsonb(p_normalized_title)::text || '}',
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  IF p_public_content_hash IS NULL OR p_public_content_hash <> expected_content_hash THEN
    RAISE EXCEPTION 'historical publication public-content hash does not match normalized content'
      USING ERRCODE = '22023';
  END IF;
  IF p_observed_at IS NULL OR p_observed_at > statement_timestamp() + interval '5 minutes'
     OR (p_published_at IS NOT NULL AND p_published_at > p_observed_at) THEN
    RAISE EXCEPTION 'historical publication timestamps are invalid'
      USING ERRCODE = '22023';
  END IF;
  IF p_source_evidence_hash IS NULL
     OR p_source_reference IS NULL
     OR length(p_source_reference) NOT BETWEEN 1 AND 2000
     OR p_source_reference ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'bounded offline source evidence is required'
      USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL
     OR length(p_idempotency_key) NOT BETWEEN 8 AND 200
     OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
     OR p_request_hash IS NULL THEN
    RAISE EXCEPTION 'historical publication idempotency input is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(tenant_value::text || ':historical-publication:' || p_idempotency_key, 0)
  );

  SELECT * INTO existing
  FROM geo.historical_publications AS history
  WHERE history.tenant_id = tenant_value
    AND history.idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF existing.id IS NOT NULL THEN
    IF existing.channel_account_id IS DISTINCT FROM p_channel_account_id
       OR existing.external_id IS DISTINCT FROM p_external_id
       OR existing.external_url IS DISTINCT FROM p_external_url
       OR existing.normalized_title IS DISTINCT FROM p_normalized_title
       OR existing.normalized_body IS DISTINCT FROM p_normalized_body
       OR existing.public_content_hash IS DISTINCT FROM p_public_content_hash
       OR existing.published_at IS DISTINCT FROM p_published_at
       OR existing.observed_at IS DISTINCT FROM p_observed_at
       OR existing.source_evidence_hash IS DISTINCT FROM p_source_evidence_hash
       OR existing.source_reference IS DISTINCT FROM p_source_reference
       OR existing.bound_by_actor_id IS DISTINCT FROM actor_value
       OR existing.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'historical publication idempotency key conflicts with another binding'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT existing.id, existing.audit_log_id, false;
    RETURN;
  END IF;

  SELECT history.id INTO conflicting_id
  FROM geo.historical_publications AS history
  WHERE history.tenant_id = tenant_value
    AND history.platform = 'ctrip_community'
    AND (
      history.external_id = p_external_id
      OR history.external_url = p_external_url
      OR history.public_content_hash = p_public_content_hash
    )
  LIMIT 1
  FOR UPDATE;
  IF conflicting_id IS NOT NULL THEN
    RAISE EXCEPTION 'historical publication identity or content conflicts with an existing binding'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO geo.audit_log (
    tenant_id, id, actor_id, action, resource_type, resource_id, request_id,
    before_hash, after_hash, details
  ) VALUES (
    tenant_value, audit_value, actor_value, 'historical_publication.bound',
    'historical_publication', history_value, request_id_value, NULL, p_request_hash,
    jsonb_build_object(
      'schemaVersion', 'geo.historical-publication-binding-receipt.v1',
      'channelAccountId', p_channel_account_id,
      'platform', 'ctrip_community',
      'externalId', p_external_id,
      'externalUrl', p_external_url,
      'publicContentHash', p_public_content_hash,
      'publishedAt', p_published_at,
      'observedAt', p_observed_at,
      'sourceEvidenceHash', p_source_evidence_hash,
      'sourceReference', p_source_reference,
      'idempotencyKey', p_idempotency_key
    )
  );

  INSERT INTO geo.historical_publications (
    tenant_id, id, channel_account_id, platform, external_id, external_url,
    normalized_title, normalized_body, public_content_hash, published_at, observed_at,
    source_evidence_hash, source_reference, bound_by_actor_id, idempotency_key,
    request_hash, audit_log_id
  ) VALUES (
    tenant_value, history_value, p_channel_account_id, 'ctrip_community', p_external_id,
    p_external_url, p_normalized_title, p_normalized_body, p_public_content_hash,
    p_published_at, p_observed_at, p_source_evidence_hash, p_source_reference, actor_value,
    p_idempotency_key, p_request_hash, audit_value
  );

  RETURN QUERY SELECT history_value, audit_value, true;
END
$$;

REVOKE ALL ON FUNCTION geo.bind_historical_publication(
  uuid, text, text, text, text, geo.sha256_hex, timestamptz, timestamptz,
  geo.sha256_hex, text, text, geo.sha256_hex
) FROM PUBLIC, geo_runtime, geo_dispatcher, geo_identity;

-- Phase A preparation is unavailable until the protected pre-migration article
-- is bound to the exact tenant Ctrip account. The existing block-reason function
-- is the common handoff, preparation, permit, and recovery admission boundary.
DO $$
DECLARE
  definition text;
  updated_definition text;
BEGIN
  SELECT pg_get_functiondef('geo.publication_assisted_block_reason(uuid)'::regprocedure)
  INTO definition;
  updated_definition := replace(
    definition,
    '  SELECT item.* INTO content_item',
    '  IF NOT geo.ctrip_protected_history_baseline_bound(job.channel_account_id) THEN
    RETURN ''ctrip_protected_history_baseline_missing'';
  END IF;

  SELECT item.* INTO content_item'
  );
  IF updated_definition = definition THEN
    RAISE EXCEPTION 'Ctrip protected history baseline insertion point was not found';
  END IF;
  EXECUTE updated_definition;
END
$$;
