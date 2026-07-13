CREATE TABLE geo.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (email = lower(email))
);

CREATE UNIQUE INDEX users_email_unique ON geo.users (lower(email));

CREATE TABLE geo.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  legal_name text NOT NULL,
  display_name text NOT NULL,
  industry text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  default_locale text NOT NULL DEFAULT 'zh-CN',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE geo.tenant_memberships (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES geo.users (id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'auditor', 'publisher', 'viewer')),
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(capabilities) = 'array'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE geo.service_principals (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('api', 'worker', 'agent', 'integration')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE geo.api_keys (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_principal_id uuid NOT NULL,
  key_prefix text NOT NULL,
  secret_hash geo.sha256_hex NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, key_prefix),
  FOREIGN KEY (tenant_id, service_principal_id)
    REFERENCES geo.service_principals (tenant_id, id) ON DELETE RESTRICT,
  CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE TABLE geo.sessions (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  token_hash geo.sha256_hex NOT NULL,
  csrf_hash geo.sha256_hex NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, token_hash),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES geo.tenant_memberships (tenant_id, user_id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at)
);

CREATE TABLE geo.brands (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name text NOT NULL,
  display_name text NOT NULL,
  aliases jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(aliases) = 'array'),
  description text,
  industry text NOT NULL,
  website_url text,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, canonical_name)
);

CREATE UNIQUE INDEX brands_one_primary_per_tenant
  ON geo.brands (tenant_id)
  WHERE is_primary;

CREATE TABLE geo.tenant_contacts (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('phone', 'wechat', 'email', 'website', 'address')),
  label text NOT NULL,
  value text NOT NULL,
  normalized_value text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_until timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, type, normalized_value, valid_from),
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);

CREATE INDEX tenant_contacts_current_lookup
  ON geo.tenant_contacts (tenant_id, type, is_primary)
  WHERE valid_until IS NULL;

CREATE TABLE geo.policy_bundles (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
  policy_hash geo.sha256_hex NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  effective_at timestamptz NOT NULL,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, version),
  UNIQUE (tenant_id, policy_hash),
  CHECK (retired_at IS NULL OR retired_at > effective_at)
);

CREATE TABLE geo.automation_controls (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL CHECK (scope_type IN ('tenant', 'platform', 'account', 'campaign', 'topic')),
  scope_key text NOT NULL DEFAULT '*',
  mode text NOT NULL CHECK (mode IN ('shadow', 'supervised', 'unattended', 'paused', 'stopped')),
  quota jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(quota) = 'object'),
  kill_switch_enabled boolean NOT NULL DEFAULT false,
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, scope_type, scope_key),
  CHECK ((scope_type = 'tenant' AND scope_key = '*') OR scope_type <> 'tenant')
);

CREATE TABLE geo.channel_accounts (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL CHECK (platform IN ('toutiao', 'sohu', 'ctrip_community')),
  display_name text NOT NULL,
  capability text NOT NULL CHECK (capability IN ('public_api', 'partner_api', 'browser_assisted', 'manual_only', 'disabled')),
  supported_execution_levels text[] NOT NULL DEFAULT ARRAY['dry_run']::text[],
  credential_ref text,
  capability_evidence_type text NOT NULL CHECK (capability_evidence_type IN ('fixture', 'preview', 'manual_import', 'browser_screenshot', 'api_response', 'platform_readback')),
  capability_evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(capability_evidence_refs) = 'array'),
  status text NOT NULL DEFAULT 'needs_verification' CHECK (status IN ('active', 'disabled', 'needs_verification')),
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, platform),
  UNIQUE (tenant_id, platform, display_name),
  CHECK (supported_execution_levels <@ ARRAY['dry_run', 'assisted', 'unattended']::text[]),
  CHECK (cardinality(supported_execution_levels) > 0),
  CHECK (capability IN ('public_api', 'partner_api') OR NOT ('unattended' = ANY(supported_execution_levels)))
);

CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON geo.users
FOR EACH ROW EXECUTE FUNCTION geo.set_updated_at();

CREATE TRIGGER tenants_set_updated_at
BEFORE UPDATE ON geo.tenants
FOR EACH ROW EXECUTE FUNCTION geo.set_updated_at();

CREATE TRIGGER service_principals_set_updated_at
BEFORE UPDATE ON geo.service_principals
FOR EACH ROW EXECUTE FUNCTION geo.set_updated_at();

CREATE TRIGGER brands_set_updated_at
BEFORE UPDATE ON geo.brands
FOR EACH ROW EXECUTE FUNCTION geo.set_updated_at();

CREATE TRIGGER automation_controls_set_updated_at
BEFORE UPDATE ON geo.automation_controls
FOR EACH ROW EXECUTE FUNCTION geo.set_updated_at();

CREATE TRIGGER channel_accounts_set_updated_at
BEFORE UPDATE ON geo.channel_accounts
FOR EACH ROW EXECUTE FUNCTION geo.set_updated_at();
