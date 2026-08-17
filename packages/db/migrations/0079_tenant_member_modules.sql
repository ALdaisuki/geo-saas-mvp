CREATE OR REPLACE FUNCTION geo.member_modules_valid(p_modules jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, geo
AS $$
DECLARE
  module_value text;
  seen_modules text[] := ARRAY[]::text[];
BEGIN
  IF p_modules IS NULL OR jsonb_typeof(p_modules) IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_modules) AS module_entry(value)
    WHERE jsonb_typeof(module_entry.value) IS DISTINCT FROM 'string'
  ) THEN
    RETURN false;
  END IF;

  FOR module_value IN SELECT value FROM jsonb_array_elements_text(p_modules)
  LOOP
    IF module_value NOT IN (
      'trend_discovery',
      'ai_content',
      'priority_distribution',
      'agent_automation'
    ) OR module_value = ANY(seen_modules) THEN
      RETURN false;
    END IF;
    seen_modules := array_append(seen_modules, module_value);
  END LOOP;
  RETURN true;
END
$$;

ALTER TABLE geo.tenant_memberships
  ADD COLUMN enabled_modules jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT tenant_memberships_enabled_modules_valid
    CHECK (
      jsonb_typeof(enabled_modules) = 'array'
      AND geo.member_modules_valid(enabled_modules)
    );

REVOKE ALL ON FUNCTION geo.member_modules_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.member_modules_valid(jsonb) TO geo_runtime;

DROP FUNCTION geo.find_login_identity(text);
CREATE FUNCTION geo.find_login_identity(p_email text)
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
  enabled_modules jsonb,
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
    memberships.enabled_modules,
    memberships.status
  FROM geo.users AS users
  LEFT JOIN geo.tenant_memberships AS memberships ON memberships.user_id = users.id
  LEFT JOIN geo.tenants AS tenants ON tenants.id = memberships.tenant_id
  WHERE lower(users.email) = lower(p_email)
  ORDER BY tenants.slug
$$;

DROP FUNCTION geo.find_login_identity_by_user(uuid);
CREATE FUNCTION geo.find_login_identity_by_user(p_user_id uuid)
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
  enabled_modules jsonb,
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
    memberships.enabled_modules,
    memberships.status
  FROM geo.users AS users
  LEFT JOIN geo.tenant_memberships AS memberships ON memberships.user_id = users.id
  LEFT JOIN geo.tenants AS tenants ON tenants.id = memberships.tenant_id
  WHERE users.id = p_user_id
  ORDER BY tenants.slug
$$;

REVOKE ALL ON FUNCTION geo.find_login_identity(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.find_login_identity_by_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.find_login_identity(text) TO geo_identity;
GRANT EXECUTE ON FUNCTION geo.find_login_identity_by_user(uuid) TO geo_identity;

DROP FUNCTION geo.list_tenant_member_identities();
CREATE FUNCTION geo.list_tenant_member_identities()
RETURNS TABLE (
  membership_id uuid,
  member_user_id uuid,
  member_email text,
  member_display_name text,
  member_role text,
  member_capabilities jsonb,
  member_enabled_modules jsonb,
  member_status text,
  member_created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  actor_role text;
BEGIN
  SELECT membership.role INTO actor_role
  FROM geo.tenant_memberships AS membership
  WHERE membership.tenant_id = tenant_value
    AND membership.user_id = actor_value
    AND membership.status = 'active';

  IF actor_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'an active owner or admin is required to list tenant members'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT membership.id, membership.user_id, users.email, users.display_name,
         membership.role, membership.capabilities, membership.enabled_modules,
         membership.status, membership.created_at
  FROM geo.tenant_memberships AS membership
  JOIN geo.users AS users ON users.id = membership.user_id
  WHERE membership.tenant_id = tenant_value
  ORDER BY membership.created_at, membership.id;
END
$$;

DROP FUNCTION geo.get_tenant_member_identity(uuid);
CREATE FUNCTION geo.get_tenant_member_identity(p_membership_id uuid)
RETURNS TABLE (
  membership_id uuid,
  member_user_id uuid,
  member_email text,
  member_display_name text,
  member_role text,
  member_capabilities jsonb,
  member_enabled_modules jsonb,
  member_status text,
  member_created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  actor_role text;
BEGIN
  SELECT membership.role INTO actor_role
  FROM geo.tenant_memberships AS membership
  WHERE membership.tenant_id = tenant_value
    AND membership.user_id = actor_value
    AND membership.status = 'active';

  IF actor_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'an active owner or admin is required to manage tenant members'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT membership.id, membership.user_id, users.email, users.display_name,
         membership.role, membership.capabilities, membership.enabled_modules,
         membership.status, membership.created_at
  FROM geo.tenant_memberships AS membership
  JOIN geo.users AS users ON users.id = membership.user_id
  WHERE membership.tenant_id = tenant_value
    AND membership.id = p_membership_id
  FOR UPDATE OF membership;
END
$$;

REVOKE ALL ON FUNCTION geo.list_tenant_member_identities() FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.get_tenant_member_identity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.list_tenant_member_identities() TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.get_tenant_member_identity(uuid) TO geo_runtime;

CREATE FUNCTION geo.update_tenant_member_modules(
  p_membership_id uuid,
  p_enabled_modules jsonb
)
RETURNS TABLE (
  membership_id uuid,
  member_user_id uuid,
  member_email text,
  member_display_name text,
  member_role text,
  member_capabilities jsonb,
  member_enabled_modules jsonb,
  member_status text,
  member_created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  actor_role text;
  target_role text;
BEGIN
  SELECT membership.role INTO actor_role
  FROM geo.tenant_memberships AS membership
  WHERE membership.tenant_id = tenant_value
    AND membership.user_id = actor_value
    AND membership.status = 'active';

  IF actor_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'an active owner or admin is required to update member modules'
      USING ERRCODE = '42501';
  END IF;
  IF NOT geo.member_modules_valid(p_enabled_modules) THEN
    RAISE EXCEPTION 'invalid tenant member modules' USING ERRCODE = '22023';
  END IF;

  SELECT membership.role INTO target_role
  FROM geo.tenant_memberships AS membership
  WHERE membership.tenant_id = tenant_value
    AND membership.id = p_membership_id;

  IF actor_role <> 'owner' AND target_role = 'owner' THEN
    RAISE EXCEPTION 'only an owner may update owner modules' USING ERRCODE = '42501';
  END IF;

  UPDATE geo.tenant_memberships AS membership
  SET enabled_modules = p_enabled_modules
  WHERE membership.tenant_id = tenant_value
    AND membership.id = p_membership_id;

  RETURN QUERY
  SELECT membership.id, membership.user_id, users.email, users.display_name,
         membership.role, membership.capabilities, membership.enabled_modules,
         membership.status, membership.created_at
  FROM geo.tenant_memberships AS membership
  JOIN geo.users AS users ON users.id = membership.user_id
  WHERE membership.tenant_id = tenant_value
    AND membership.id = p_membership_id;
END
$$;

REVOKE ALL ON FUNCTION geo.update_tenant_member_modules(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.update_tenant_member_modules(uuid, jsonb) TO geo_runtime;
