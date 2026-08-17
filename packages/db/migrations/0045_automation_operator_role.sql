ALTER TABLE geo.tenant_memberships
  DROP CONSTRAINT IF EXISTS tenant_memberships_role_check;

ALTER TABLE geo.tenant_memberships
  ADD CONSTRAINT tenant_memberships_role_check
    CHECK (
      role IN ('owner', 'admin', 'editor', 'auditor', 'publisher', 'automation_operator', 'viewer')
    );

ALTER TABLE geo.tenant_memberships
  ADD CONSTRAINT tenant_memberships_automation_operator_scope
    CHECK (
      role <> 'automation_operator' OR (
        jsonb_array_length(capabilities) = 8 AND
        capabilities @> '[
          "tenant:read",
          "content:read",
          "content:write",
          "audit:read",
          "audit:run",
          "publish:request",
          "receipt:read",
          "automation:execute"
        ]'::jsonb AND
        capabilities <@ '[
          "tenant:read",
          "content:read",
          "content:write",
          "audit:read",
          "audit:run",
          "publish:request",
          "receipt:read",
          "automation:execute"
        ]'::jsonb
      )
    );

CREATE OR REPLACE FUNCTION geo.create_tenant_member_identity(
  p_membership_id uuid,
  p_user_id uuid,
  p_email text,
  p_display_name text,
  p_password_hash text,
  p_role text
)
RETURNS TABLE (
  membership_id uuid,
  member_user_id uuid,
  member_email text,
  member_display_name text,
  member_role text,
  member_capabilities jsonb,
  member_status text,
  member_created_at timestamptz,
  identity_created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  actor_role text;
  user_row geo.users%ROWTYPE;
  user_id_value uuid;
  membership_row geo.tenant_memberships%ROWTYPE;
  capabilities_value jsonb;
  identity_created_value boolean := false;
BEGIN
  SELECT membership.role INTO actor_role
  FROM geo.tenant_memberships AS membership
  WHERE membership.tenant_id = tenant_value
    AND membership.user_id = actor_value
    AND membership.status = 'active';

  IF actor_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'an active owner or admin is required to create a tenant member'
      USING ERRCODE = '42501';
  END IF;
  IF p_role NOT IN (
    'owner', 'admin', 'editor', 'auditor', 'publisher', 'automation_operator', 'viewer'
  ) THEN
    RAISE EXCEPTION 'unsupported tenant role' USING ERRCODE = '22023';
  END IF;
  IF p_role = 'owner' AND actor_role <> 'owner' THEN
    RAISE EXCEPTION 'only an owner may create another owner' USING ERRCODE = '42501';
  END IF;
  IF p_email IS NULL OR p_email <> lower(trim(p_email)) OR length(p_email) > 320 OR
     p_display_name IS NULL OR length(trim(p_display_name)) NOT BETWEEN 1 AND 200 OR
     p_password_hash IS NULL OR length(p_password_hash) = 0 THEN
    RAISE EXCEPTION 'invalid tenant member identity input' USING ERRCODE = '22023';
  END IF;

  capabilities_value := CASE p_role
    WHEN 'owner' THEN '[
      "tenant:read", "tenant:manage", "member:manage", "principal:manage",
      "content:read", "content:write", "audit:read", "audit:run", "grant:revoke",
      "publish:request", "publish:cancel", "receipt:read", "visibility:read",
      "visibility:run", "automation:manage", "automation:execute"
    ]'::jsonb
    WHEN 'admin' THEN '[
      "tenant:read", "tenant:manage", "member:manage", "principal:manage",
      "content:read", "content:write", "audit:read", "audit:run", "grant:revoke",
      "publish:request", "publish:cancel", "receipt:read", "visibility:read",
      "visibility:run", "automation:manage", "automation:execute"
    ]'::jsonb
    WHEN 'editor' THEN '[
      "tenant:read", "content:read", "content:write", "audit:read", "audit:run",
      "receipt:read", "visibility:read", "visibility:run"
    ]'::jsonb
    WHEN 'auditor' THEN '[
      "tenant:read", "content:read", "audit:read", "audit:run", "receipt:read",
      "visibility:read"
    ]'::jsonb
    WHEN 'publisher' THEN '[
      "tenant:read", "content:read", "audit:read", "publish:request",
      "publish:cancel", "receipt:read", "visibility:read"
    ]'::jsonb
    WHEN 'automation_operator' THEN '[
      "tenant:read", "content:read", "content:write", "audit:read", "audit:run",
      "publish:request", "receipt:read", "automation:execute"
    ]'::jsonb
    ELSE '["tenant:read", "content:read", "audit:read", "receipt:read", "visibility:read"]'::jsonb
  END;

  SELECT users.* INTO user_row
  FROM geo.users AS users
  WHERE lower(users.email) = p_email
  FOR UPDATE;

  IF user_row.id IS NULL THEN
    INSERT INTO geo.users (id, email, password_hash, display_name, status)
    VALUES (p_user_id, p_email, p_password_hash, trim(p_display_name), 'active')
    RETURNING id INTO user_id_value;
    identity_created_value := true;
  ELSE
    IF user_row.status <> 'active' THEN
      RAISE EXCEPTION 'existing user identity is disabled' USING ERRCODE = '55000';
    END IF;
    user_id_value := user_row.id;
  END IF;

  INSERT INTO geo.tenant_memberships (
    tenant_id, id, user_id, role, capabilities, status
  ) VALUES (
    tenant_value, p_membership_id, user_id_value, p_role, capabilities_value, 'active'
  )
  RETURNING * INTO membership_row;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'tenant_member.created', 'tenant_membership',
    membership_row.id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), membership_row.id::text),
    encode(public.digest(
      membership_row.id::text || ':' || user_id_value::text || ':' || p_email || ':' ||
      p_role || ':active',
      'sha256'
    ), 'hex'),
    jsonb_build_object(
      'identityCreated', identity_created_value,
      'role', p_role,
      'status', 'active'
    )
  );

  RETURN QUERY
  SELECT membership_row.id, user_id_value, users.email, users.display_name,
         membership_row.role, membership_row.capabilities, membership_row.status,
         membership_row.created_at, identity_created_value
  FROM geo.users AS users
  WHERE users.id = user_id_value;
END
$$;

REVOKE ALL ON FUNCTION geo.create_tenant_member_identity(uuid, uuid, text, text, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.create_tenant_member_identity(uuid, uuid, text, text, text, text)
  TO geo_runtime;
