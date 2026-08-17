CREATE OR REPLACE FUNCTION geo.research_allowed_hosts_valid(hosts text[])
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  host text;
  seen text[] := ARRAY[]::text[];
BEGIN
  IF cardinality(hosts) NOT BETWEEN 1 AND 50 THEN
    RETURN false;
  END IF;

  FOREACH host IN ARRAY hosts LOOP
    IF host IS NULL
       OR length(host) NOT BETWEEN 1 AND 253
       OR host <> lower(host)
       OR host <> rtrim(host, '.')
       OR host LIKE '%*%'
       OR host LIKE '%/%'
       OR host LIKE '%:%'
       OR host !~ '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$'
       OR host = ANY(seen) THEN
      RETURN false;
    END IF;
    seen := array_append(seen, host);
  END LOOP;
  RETURN true;
END
$$;

CREATE TABLE geo.research_source_policies (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL CHECK (
    length(source_key) BETWEEN 1 AND 100 AND
    source_key ~ '^[a-z0-9][a-z0-9._-]*$'
  ),
  version integer NOT NULL CHECK (version > 0),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  origin text NOT NULL CHECK (
    length(origin) BETWEEN 10 AND 2048 AND
    origin LIKE 'https://%'
  ),
  allowed_hosts text[] NOT NULL,
  user_agent text NOT NULL CHECK (
    length(user_agent) BETWEEN 8 AND 256 AND
    user_agent !~ E'[\\r\\n]'
  ),
  max_bytes integer NOT NULL CHECK (max_bytes BETWEEN 1024 AND 5000000),
  robots_max_bytes integer NOT NULL CHECK (robots_max_bytes BETWEEN 1024 AND 1000000),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 500 AND 30000),
  max_redirects integer NOT NULL CHECK (max_redirects BETWEEN 0 AND 5),
  max_discovered_urls integer NOT NULL CHECK (max_discovered_urls BETWEEN 1 AND 1000),
  respect_robots boolean NOT NULL DEFAULT true CHECK (respect_robots),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by_actor_id uuid NOT NULL,
  retired_by_actor_id uuid,
  retirement_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, source_key, version),
  CHECK (geo.research_allowed_hosts_valid(allowed_hosts)),
  CHECK (
    (status = 'active' AND retired_at IS NULL AND retired_by_actor_id IS NULL AND retirement_reason IS NULL) OR
    (status = 'retired' AND retired_at IS NOT NULL AND retired_by_actor_id IS NOT NULL AND
      length(retirement_reason) BETWEEN 3 AND 500)
  )
);

CREATE UNIQUE INDEX research_source_policies_one_active_version
  ON geo.research_source_policies (tenant_id, source_key)
  WHERE status = 'active';

CREATE INDEX research_source_policies_tenant_status
  ON geo.research_source_policies (tenant_id, status, source_key, version DESC);

CREATE TABLE geo.research_capture_records (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_policy_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('page_capture', 'sitemap_discovery')),
  status text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  request_url_hash geo.sha256_hex NOT NULL,
  evidence_source_id uuid,
  error_code text,
  result_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result_metadata) = 'object'),
  captured_by_actor_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, source_policy_id)
    REFERENCES geo.research_source_policies (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, evidence_source_id)
    REFERENCES geo.evidence_sources (tenant_id, id) ON DELETE RESTRICT,
  CHECK (completed_at >= started_at),
  CHECK (
    (status = 'failed' AND evidence_source_id IS NULL AND error_code IS NOT NULL AND
      error_code ~ '^RESEARCH_[A-Z0-9_]{1,100}$' AND result_metadata = '{}'::jsonb) OR
    (status = 'succeeded' AND error_code IS NULL AND
      ((operation = 'page_capture' AND evidence_source_id IS NOT NULL) OR
       (operation = 'sitemap_discovery' AND evidence_source_id IS NULL)))
  )
);

CREATE INDEX research_capture_records_source_time
  ON geo.research_capture_records (tenant_id, source_policy_id, created_at DESC);

CREATE OR REPLACE FUNCTION geo.enforce_research_source_policy_retirement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'research_source_policies is immutable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'active'
     OR NEW.status <> 'retired'
     OR NEW.retired_at IS NULL
     OR NEW.retired_by_actor_id IS NULL
     OR NEW.retirement_reason IS NULL
     OR (to_jsonb(OLD) - ARRAY['status', 'retired_at', 'retired_by_actor_id', 'retirement_reason'])
        IS DISTINCT FROM
        (to_jsonb(NEW) - ARRAY['status', 'retired_at', 'retired_by_actor_id', 'retirement_reason']) THEN
    RAISE EXCEPTION 'research source policies only permit active-to-retired transition'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER research_source_policies_retirement_only
BEFORE UPDATE OR DELETE ON geo.research_source_policies
FOR EACH ROW EXECUTE FUNCTION geo.enforce_research_source_policy_retirement();

CREATE TRIGGER research_capture_records_append_only
BEFORE UPDATE OR DELETE ON geo.research_capture_records
FOR EACH ROW EXECUTE FUNCTION geo.prevent_append_only_mutation();

ALTER TABLE geo.research_source_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.research_source_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON geo.research_source_policies TO geo_runtime
  USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

ALTER TABLE geo.research_capture_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.research_capture_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON geo.research_capture_records TO geo_runtime
  USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

REVOKE ALL ON TABLE geo.research_source_policies, geo.research_capture_records
  FROM PUBLIC, geo_dispatcher, geo_identity, geo_runtime;
GRANT SELECT, INSERT ON TABLE geo.research_source_policies TO geo_runtime;
GRANT UPDATE (status, retired_at, retired_by_actor_id, retirement_reason)
  ON TABLE geo.research_source_policies TO geo_runtime;
GRANT SELECT, INSERT ON TABLE geo.research_capture_records TO geo_runtime;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE geo.research_source_policies, geo.research_capture_records FROM geo_runtime;

REVOKE ALL ON FUNCTION geo.research_allowed_hosts_valid(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.enforce_research_source_policy_retirement() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.research_allowed_hosts_valid(text[]) TO geo_runtime;
