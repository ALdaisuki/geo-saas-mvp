DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geo_identity') THEN
    CREATE ROLE geo_identity NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE geo_identity NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

CREATE OR REPLACE FUNCTION geo.find_login_identity(p_email text)
RETURNS TABLE (
  user_id uuid,
  email text,
  password_hash text,
  user_display_name text,
  user_status text,
  tenant_id uuid,
  tenant_slug text,
  tenant_display_name text,
  tenant_status text,
  role text,
  capabilities jsonb,
  membership_status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
  SELECT
    users.id,
    users.email,
    users.password_hash,
    users.display_name,
    users.status,
    memberships.tenant_id,
    tenants.slug,
    tenants.display_name,
    tenants.status,
    memberships.role,
    memberships.capabilities,
    memberships.status
  FROM geo.users AS users
  LEFT JOIN geo.tenant_memberships AS memberships ON memberships.user_id = users.id
  LEFT JOIN geo.tenants AS tenants ON tenants.id = memberships.tenant_id
  WHERE lower(users.email) = lower(p_email)
  ORDER BY tenants.slug
$$;

CREATE OR REPLACE FUNCTION geo.find_login_identity_by_user(p_user_id uuid)
RETURNS TABLE (
  user_id uuid,
  email text,
  password_hash text,
  user_display_name text,
  user_status text,
  tenant_id uuid,
  tenant_slug text,
  tenant_display_name text,
  tenant_status text,
  role text,
  capabilities jsonb,
  membership_status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
  SELECT
    users.id,
    users.email,
    users.password_hash,
    users.display_name,
    users.status,
    memberships.tenant_id,
    tenants.slug,
    tenants.display_name,
    tenants.status,
    memberships.role,
    memberships.capabilities,
    memberships.status
  FROM geo.users AS users
  LEFT JOIN geo.tenant_memberships AS memberships ON memberships.user_id = users.id
  LEFT JOIN geo.tenants AS tenants ON tenants.id = memberships.tenant_id
  WHERE users.id = p_user_id
  ORDER BY tenants.slug
$$;

REVOKE ALL ON FUNCTION geo.find_login_identity(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.find_login_identity_by_user(uuid) FROM PUBLIC;
GRANT USAGE ON SCHEMA geo TO geo_identity;
GRANT EXECUTE ON FUNCTION geo.find_login_identity(text) TO geo_identity;
GRANT EXECUTE ON FUNCTION geo.find_login_identity_by_user(uuid) TO geo_identity;
REVOKE ALL ON ALL TABLES IN SCHEMA geo FROM geo_identity;
