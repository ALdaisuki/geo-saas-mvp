BEGIN;

CREATE TABLE geo.runtime_provider_configurations (
  config_key text PRIMARY KEY CHECK (
    config_key ~ '^[a-z][a-z0-9_]{1,63}$'
  ),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 200),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 500),
  base_url text CHECK (base_url IS NULL OR length(base_url) BETWEEN 1 AND 2048),
  api text CHECK (api IS NULL OR api IN ('openai-responses', 'openai-completions')),
  completions_mode text NOT NULL DEFAULT 'stream'
    CHECK (completions_mode IN ('stream', 'json')),
  api_key text CHECK (api_key IS NULL OR length(api_key) BETWEEN 1 AND 4096),
  enabled boolean NOT NULL DEFAULT true,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(settings) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER runtime_provider_configurations_set_updated_at
BEFORE UPDATE ON geo.runtime_provider_configurations
FOR EACH ROW EXECUTE FUNCTION geo.set_updated_at();

REVOKE ALL ON TABLE geo.runtime_provider_configurations FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE geo.runtime_provider_configurations TO geo_runtime;

COMMIT;
