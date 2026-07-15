CREATE OR REPLACE FUNCTION geo.list_tenant_member_identities()
RETURNS TABLE (
  membership_id uuid,
  member_user_id uuid,
  member_email text,
  member_display_name text,
  member_role text,
  member_capabilities jsonb,
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
         membership.role, membership.capabilities, membership.status,
         membership.created_at
  FROM geo.tenant_memberships AS membership
  JOIN geo.users AS users ON users.id = membership.user_id
  WHERE membership.tenant_id = tenant_value
  ORDER BY membership.created_at, membership.id;
END
$$;

CREATE OR REPLACE FUNCTION geo.get_tenant_member_identity(p_membership_id uuid)
RETURNS TABLE (
  membership_id uuid,
  member_user_id uuid,
  member_email text,
  member_display_name text,
  member_role text,
  member_capabilities jsonb,
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
         membership.role, membership.capabilities, membership.status,
         membership.created_at
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
