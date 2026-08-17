CREATE OR REPLACE FUNCTION geo.protect_frozen_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.frozen_at IS NOT NULL THEN
    RAISE EXCEPTION '% % is frozen and immutable', TG_TABLE_NAME, OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TABLE geo.campaigns (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  name text NOT NULL,
  objective text NOT NULL,
  industry text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed')),
  topic_key text NOT NULL,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES geo.brands (tenant_id, id) ON DELETE RESTRICT,
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE geo.evidence_sources (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('url', 'document', 'manual', 'platform_readback')),
  title text NOT NULL,
  source_url text,
  content_hash geo.sha256_hex NOT NULL,
  captured_at timestamptz NOT NULL,
  valid_until timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, content_hash),
  CHECK (valid_until IS NULL OR valid_until > captured_at)
);

CREATE TABLE geo.claim_facts (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  normalized_key text NOT NULL,
  claim text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'verified', 'rejected', 'expired')),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
  valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, brand_id, normalized_key, valid_from),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES geo.brands (tenant_id, id) ON DELETE RESTRICT,
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);

CREATE TABLE geo.content_items (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  title text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('question_answer', 'guide', 'evidence', 'local_service', 'comparison', 'risk_avoidance')),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'ready_for_audit', 'audited', 'approved', 'queued', 'publishing', 'published', 'failed', 'blocked', 'withdrawn')),
  topic_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, campaign_id)
    REFERENCES geo.campaigns (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES geo.brands (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX content_items_campaign_state
  ON geo.content_items (tenant_id, campaign_id, state, updated_at DESC);

CREATE TABLE geo.content_versions (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_item_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  summary text NOT NULL,
  body_markdown text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_hash geo.sha256_hex NOT NULL,
  created_by_actor_id uuid NOT NULL,
  frozen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, content_item_id, version),
  UNIQUE (tenant_id, id, payload_hash),
  FOREIGN KEY (tenant_id, content_item_id)
    REFERENCES geo.content_items (tenant_id, id) ON DELETE RESTRICT,
  CHECK (length(body_markdown) > 0)
);

CREATE TABLE geo.media_assets (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_version_id uuid,
  sha256 geo.sha256_hex NOT NULL,
  mime_type text NOT NULL,
  storage_key text NOT NULL,
  alt_text text NOT NULL,
  source_url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, sha256),
  FOREIGN KEY (tenant_id, content_version_id)
    REFERENCES geo.content_versions (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE geo.publication_variants (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_version_id uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('toutiao', 'sohu', 'ctrip_community')),
  variant_version integer NOT NULL CHECK (variant_version > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_hash geo.sha256_hex NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'frozen', 'superseded')),
  frozen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, channel_account_id, platform),
  UNIQUE (tenant_id, content_version_id, channel_account_id, variant_version),
  FOREIGN KEY (tenant_id, content_version_id)
    REFERENCES geo.content_versions (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, channel_account_id, platform)
    REFERENCES geo.channel_accounts (tenant_id, id, platform) ON DELETE RESTRICT,
  CHECK ((state = 'draft' AND frozen_at IS NULL) OR (state <> 'draft' AND frozen_at IS NOT NULL))
);

CREATE INDEX publication_variants_payload_hash
  ON geo.publication_variants (tenant_id, payload_hash);

CREATE TABLE geo.audit_runs (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL,
  policy_bundle_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'passed', 'failed', 'errored')),
  requested_by_actor_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id)
    REFERENCES geo.publication_variants (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, policy_bundle_id)
    REFERENCES geo.policy_bundles (tenant_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'running' AND completed_at IS NULL) OR (status <> 'running' AND completed_at IS NOT NULL))
);

CREATE TABLE geo.audit_artifacts (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_run_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('toutiao', 'sohu', 'ctrip_community')),
  payload_hash geo.sha256_hex NOT NULL,
  fact_snapshot_hash geo.sha256_hex NOT NULL,
  policy_hash geo.sha256_hex NOT NULL,
  policy_version text NOT NULL,
  audit_hash geo.sha256_hex NOT NULL,
  status text NOT NULL CHECK (status IN ('passed', 'failed', 'errored')),
  findings jsonb NOT NULL CHECK (jsonb_typeof(findings) = 'array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, variant_id, channel_account_id, platform),
  UNIQUE (tenant_id, audit_hash),
  FOREIGN KEY (tenant_id, audit_run_id)
    REFERENCES geo.audit_runs (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, variant_id, channel_account_id, platform)
    REFERENCES geo.publication_variants (tenant_id, id, channel_account_id, platform) ON DELETE RESTRICT,
  CHECK (expires_at > created_at)
);

CREATE TABLE geo.publication_grants (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_artifact_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('toutiao', 'sohu', 'ctrip_community')),
  payload_hash geo.sha256_hex NOT NULL,
  audit_hash geo.sha256_hex NOT NULL,
  token_hash geo.sha256_hex NOT NULL,
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'consumed', 'expired', 'revoked')),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by_actor_id uuid,
  revoked_at timestamptz,
  revoked_by_actor_id uuid,
  revocation_reason text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, token_hash),
  FOREIGN KEY (tenant_id, audit_artifact_id, variant_id, channel_account_id, platform)
    REFERENCES geo.audit_artifacts (tenant_id, id, variant_id, channel_account_id, platform) ON DELETE RESTRICT,
  CHECK (expires_at > issued_at),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL AND consumed_by_actor_id IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL AND revoked_by_actor_id IS NOT NULL AND revocation_reason IS NOT NULL)),
  CHECK (NOT (consumed_at IS NOT NULL AND revoked_at IS NOT NULL))
);

CREATE INDEX publication_grants_consumable
  ON geo.publication_grants (tenant_id, id, expires_at)
  WHERE status = 'issued';

CREATE TABLE geo.audit_log (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  request_id text NOT NULL,
  before_hash geo.sha256_hex,
  after_hash geo.sha256_hex,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id)
);

CREATE INDEX audit_log_resource_time
  ON geo.audit_log (tenant_id, resource_type, resource_id, created_at DESC);

CREATE TRIGGER campaigns_set_updated_at
BEFORE UPDATE ON geo.campaigns
FOR EACH ROW EXECUTE FUNCTION geo.set_updated_at();

CREATE TRIGGER claim_facts_set_updated_at
BEFORE UPDATE ON geo.claim_facts
FOR EACH ROW EXECUTE FUNCTION geo.set_updated_at();

CREATE TRIGGER content_items_set_updated_at
BEFORE UPDATE ON geo.content_items
FOR EACH ROW EXECUTE FUNCTION geo.set_updated_at();

CREATE TRIGGER content_versions_protect_frozen
BEFORE UPDATE OR DELETE ON geo.content_versions
FOR EACH ROW EXECUTE FUNCTION geo.protect_frozen_row();

CREATE TRIGGER publication_variants_protect_frozen
BEFORE UPDATE OR DELETE ON geo.publication_variants
FOR EACH ROW EXECUTE FUNCTION geo.protect_frozen_row();

CREATE TRIGGER audit_artifacts_append_only
BEFORE UPDATE OR DELETE ON geo.audit_artifacts
FOR EACH ROW EXECUTE FUNCTION geo.prevent_append_only_mutation();

CREATE TRIGGER audit_log_append_only
BEFORE UPDATE OR DELETE ON geo.audit_log
FOR EACH ROW EXECUTE FUNCTION geo.prevent_append_only_mutation();
