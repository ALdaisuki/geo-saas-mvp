\set ON_ERROR_STOP 1

SELECT
  (
    SELECT count(*) = 3
      AND bool_and(NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
        AND NOT rolcreaterole AND NOT rolinherit AND NOT rolbypassrls)
    FROM pg_catalog.pg_roles
    WHERE rolname IN ('geo_runtime', 'geo_dispatcher', 'geo_identity')
  )
  AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = :'api_user'
      AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND rolinherit AND NOT rolbypassrls
  )
  AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = :'worker_user'
      AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND rolinherit AND NOT rolbypassrls
  )
  AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = :'identity_user'
      AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND rolinherit AND NOT rolbypassrls
  )
  AND pg_has_role(:'api_user', 'geo_runtime', 'MEMBER')
  AND NOT pg_has_role(:'api_user', 'geo_dispatcher', 'MEMBER')
  AND pg_has_role(:'worker_user', 'geo_runtime', 'MEMBER')
  AND pg_has_role(:'worker_user', 'geo_dispatcher', 'MEMBER')
  AND pg_has_role(:'identity_user', 'geo_identity', 'MEMBER')
  AND has_table_privilege(:'api_user', 'geo.tenants', 'SELECT')
  AND has_table_privilege(:'worker_user', 'geo.brands', 'INSERT')
  AND NOT has_table_privilege(:'api_user', 'geo.audit_log', 'UPDATE')
  AND NOT has_table_privilege(:'api_user', 'geo.publication_receipts', 'DELETE')
  AND NOT has_table_privilege(:'identity_user', 'geo.users', 'SELECT')
  AND has_function_privilege(
    :'identity_user', 'geo.find_login_identity(text)', 'EXECUTE'
  ) AS acl_and_role_boundaries_ok
\gset
\if :acl_and_role_boundaries_ok
\else
  \echo 'restore rehearsal role or ACL verification failed'
  \quit 1
\endif

SELECT count(*) = 3
  AND bool_and(relation.relrowsecurity AND relation.relforcerowsecurity)
  AND count(policy.policyname) = 3 AS required_rls_ok
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
LEFT JOIN pg_catalog.pg_policies AS policy
  ON policy.schemaname = namespace.nspname
  AND policy.tablename = relation.relname
  AND policy.policyname IN ('tenant_self', 'tenant_isolation')
WHERE namespace.nspname = 'geo'
  AND relation.relname IN ('tenants', 'brands', 'publication_receipts')
\gset
\if :required_rls_ok
\else
  \echo 'restore rehearsal RLS metadata verification failed'
  \quit 1
\endif

BEGIN;
SELECT gen_random_uuid() AS id,
  'restore-rehearsal-a-' || substr(md5(clock_timestamp()::text || random()::text), 1, 20) AS slug
\gset tenant_a_
SELECT gen_random_uuid() AS id,
  'restore-rehearsal-b-' || substr(md5(clock_timestamp()::text || random()::text), 1, 20) AS slug
\gset tenant_b_

INSERT INTO geo.tenants (id, slug, legal_name, display_name, industry)
VALUES
  (:'tenant_a_id', :'tenant_a_slug', 'Restore Rehearsal A', 'Restore Rehearsal A', 'test'),
  (:'tenant_b_id', :'tenant_b_slug', 'Restore Rehearsal B', 'Restore Rehearsal B', 'test');

SET LOCAL ROLE :"api_user";
SELECT set_config('app.tenant_id', :'tenant_a_id', true);
SELECT set_config('app.actor_id', :'tenant_a_id', true);
SELECT count(*) = 1
  AND bool_and(id = :'tenant_a_id'::uuid) AS tenant_a_read_isolated
FROM geo.tenants
WHERE id IN (:'tenant_a_id'::uuid, :'tenant_b_id'::uuid)
\gset
\if :tenant_a_read_isolated
\else
  \echo 'restore rehearsal cross-tenant read denial failed'
  \quit 1
\endif

WITH cross_tenant_update AS (
  UPDATE geo.tenants
  SET display_name = 'cross-tenant mutation must remain invisible'
  WHERE id = :'tenant_b_id'::uuid
  RETURNING id
)
SELECT count(*) = 0 AS tenant_b_update_denied
FROM cross_tenant_update
\gset
\if :tenant_b_update_denied
\else
  \echo 'restore rehearsal cross-tenant update denial failed'
  \quit 1
\endif

SELECT set_config('app.tenant_id', :'tenant_b_id', true);
SELECT count(*) = 1
  AND bool_and(id = :'tenant_b_id'::uuid)
  AND bool_and(display_name = 'Restore Rehearsal B') AS tenant_b_read_isolated
FROM geo.tenants
WHERE id IN (:'tenant_a_id'::uuid, :'tenant_b_id'::uuid)
\gset
\if :tenant_b_read_isolated
\else
  \echo 'restore rehearsal reverse tenant isolation failed'
  \quit 1
\endif

RESET ROLE;
ROLLBACK;
