DO $$
BEGIN
  IF current_user IN ('geo_runtime', 'geo_dispatcher') THEN
    RAISE EXCEPTION 'migrations must not run as a runtime role';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geo_runtime') THEN
    CREATE ROLE geo_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geo_dispatcher') THEN
    CREATE ROLE geo_dispatcher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE geo_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
ALTER ROLE geo_dispatcher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

CREATE SCHEMA IF NOT EXISTS geo;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

REVOKE ALL ON SCHEMA geo FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA geo TO geo_runtime, geo_dispatcher;

ALTER DEFAULT PRIVILEGES IN SCHEMA geo REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA geo REVOKE ALL ON FUNCTIONS FROM PUBLIC;

CREATE DOMAIN geo.sha256_hex AS text
  CHECK (VALUE ~ '^[0-9a-f]{64}$');

CREATE OR REPLACE FUNCTION geo.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION geo.current_actor_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(current_setting('app.actor_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION geo.require_tenant_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  value uuid := geo.current_tenant_id();
BEGIN
  IF value IS NULL THEN
    RAISE EXCEPTION 'app.tenant_id transaction context is required' USING ERRCODE = '42501';
  END IF;
  RETURN value;
END
$$;

CREATE OR REPLACE FUNCTION geo.require_actor_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  value uuid := geo.current_actor_id();
BEGIN
  IF value IS NULL THEN
    RAISE EXCEPTION 'app.actor_id transaction context is required' USING ERRCODE = '42501';
  END IF;
  RETURN value;
END
$$;

CREATE OR REPLACE FUNCTION geo.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION geo.prevent_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA geo FROM PUBLIC;
