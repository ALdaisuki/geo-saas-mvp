#!/usr/bin/env bash
set -Eeuo pipefail

ACL_RECONCILIATION_FILE="${ACL_RECONCILIATION_FILE:-/bootstrap/reconcile-application-acls.sql}"
APPLICATION_ROLES_FILE="${APPLICATION_ROLES_FILE:-/bootstrap/ensure-application-roles.sql}"

required_variables=(
  PGHOST
  PGUSER
  PGPASSWORD
  PGDATABASE
  GEO_API_DB_USER
  GEO_API_DB_PASSWORD
  GEO_WORKER_DB_USER
  GEO_WORKER_DB_PASSWORD
  GEO_IDENTITY_DB_USER
  GEO_IDENTITY_DB_PASSWORD
)

for variable_name in "${required_variables[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "${variable_name} is required" >&2
    exit 1
  fi
done

for variable_name in GEO_API_DB_USER GEO_WORKER_DB_USER GEO_IDENTITY_DB_USER; do
  if [[ ! "${!variable_name}" =~ ^[a-z_][a-z0-9_]*$ ]]; then
    echo "${variable_name} must be a lowercase PostgreSQL identifier" >&2
    exit 1
  fi
  case "${!variable_name}" in
    geo_runtime|geo_dispatcher|geo_identity|"${PGUSER}")
      echo "${variable_name} must not reuse a NOLOGIN or admin role" >&2
      exit 1
      ;;
  esac
done

if [[ "${GEO_API_DB_USER}" == "${GEO_WORKER_DB_USER}" ||
      "${GEO_API_DB_USER}" == "${GEO_IDENTITY_DB_USER}" ||
      "${GEO_WORKER_DB_USER}" == "${GEO_IDENTITY_DB_USER}" ]]; then
  echo "application login roles must be distinct" >&2
  exit 1
fi

if [[ ! -r "${APPLICATION_ROLES_FILE}" ]]; then
  echo "Application roles file is not readable: ${APPLICATION_ROLES_FILE}" >&2
  exit 1
fi

psql --no-psqlrc --set=ON_ERROR_STOP=1 --file="${APPLICATION_ROLES_FILE}"

if [[ "$(psql --no-psqlrc --tuples-only --no-align --command "select to_regclass('geo.users') is not null and to_regprocedure('geo.find_login_identity(text)') is not null and to_regprocedure('geo.find_login_identity_by_user(uuid)') is not null")" != "t" ]]; then
  echo "geo migrations are incomplete; refusing to reconcile ACLs or bootstrap login roles" >&2
  exit 1
fi

if [[ ! -r "${ACL_RECONCILIATION_FILE}" ]]; then
  echo "ACL reconciliation file is not readable: ${ACL_RECONCILIATION_FILE}" >&2
  exit 1
fi

psql --no-psqlrc --set=ON_ERROR_STOP=1 --file="${ACL_RECONCILIATION_FILE}"

psql \
  --no-psqlrc \
  --set=ON_ERROR_STOP=1 \
  --set=db_name="${PGDATABASE}" \
  --set=api_user="${GEO_API_DB_USER}" \
  --set=worker_user="${GEO_WORKER_DB_USER}" \
  --set=identity_user="${GEO_IDENTITY_DB_USER}" <<'SQL'
\getenv api_password GEO_API_DB_PASSWORD
\getenv worker_password GEO_WORKER_DB_PASSWORD
\getenv identity_password GEO_IDENTITY_DB_PASSWORD

SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS CONNECTION LIMIT 30',
  :'api_user', :'api_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'api_user')
\gexec

SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS CONNECTION LIMIT 20',
  :'worker_user', :'worker_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'worker_user')
\gexec

SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS CONNECTION LIMIT 5',
  :'identity_user', :'identity_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'identity_user')
\gexec

SELECT format('ALTER ROLE %I PASSWORD %L', :'api_user', :'api_password')
\gexec
SELECT format('ALTER ROLE %I PASSWORD %L', :'worker_user', :'worker_password')
\gexec
SELECT format('ALTER ROLE %I PASSWORD %L', :'identity_user', :'identity_password')
\gexec

ALTER ROLE :"api_user" NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS CONNECTION LIMIT 30;
ALTER ROLE :"worker_user" NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS CONNECTION LIMIT 20;
ALTER ROLE :"identity_user" NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS CONNECTION LIMIT 5;

GRANT geo_runtime TO :"api_user";
GRANT geo_runtime, geo_dispatcher TO :"worker_user";
GRANT geo_identity TO :"identity_user";
GRANT CONNECT ON DATABASE :"db_name" TO :"api_user", :"worker_user", :"identity_user";

REVOKE ALL ON SCHEMA geo FROM :"identity_user";
REVOKE ALL ON ALL TABLES IN SCHEMA geo FROM :"identity_user";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA geo FROM :"identity_user";
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA geo FROM :"identity_user";

ALTER DEFAULT PRIVILEGES IN SCHEMA geo REVOKE ALL ON TABLES FROM :"identity_user";
ALTER DEFAULT PRIVILEGES IN SCHEMA geo REVOKE ALL ON SEQUENCES FROM :"identity_user";
ALTER DEFAULT PRIVILEGES IN SCHEMA geo REVOKE ALL ON FUNCTIONS FROM :"identity_user";

ALTER ROLE :"api_user" SET search_path = geo, public;
ALTER ROLE :"worker_user" SET search_path = geo, public;
ALTER ROLE :"identity_user" SET search_path = geo, public;
ALTER ROLE :"identity_user" SET default_transaction_read_only = on;
ALTER ROLE :"identity_user" SET statement_timeout = '5s';
SQL

psql --no-psqlrc --set=ON_ERROR_STOP=1 --command "\
  select case when \
    pg_has_role('${GEO_API_DB_USER}', 'geo_runtime', 'MEMBER') and \
    pg_has_role('${GEO_WORKER_DB_USER}', 'geo_runtime', 'MEMBER') and \
    pg_has_role('${GEO_WORKER_DB_USER}', 'geo_dispatcher', 'MEMBER') and \
    pg_has_role('${GEO_IDENTITY_DB_USER}', 'geo_identity', 'MEMBER') and \
    has_schema_privilege('${GEO_IDENTITY_DB_USER}', 'geo', 'USAGE') and \
    has_function_privilege('${GEO_IDENTITY_DB_USER}', 'geo.find_login_identity(text)', 'EXECUTE') and \
    has_function_privilege('${GEO_IDENTITY_DB_USER}', 'geo.find_login_identity_by_user(uuid)', 'EXECUTE') and \
    not exists ( \
      select 1 \
      from pg_proc as function_row \
      join pg_namespace as schema_row on schema_row.oid = function_row.pronamespace \
      where schema_row.nspname = 'geo' \
        and function_row.oid not in ( \
          'geo.find_login_identity(text)'::regprocedure, \
          'geo.find_login_identity_by_user(uuid)'::regprocedure \
        ) \
        and has_function_privilege('${GEO_IDENTITY_DB_USER}', function_row.oid, 'EXECUTE') \
    ) and \
    not has_table_privilege('${GEO_IDENTITY_DB_USER}', 'geo.users', 'SELECT') and \
    not has_table_privilege('${GEO_IDENTITY_DB_USER}', 'geo.audit_log', 'SELECT') \
  then 'login role ACLs verified' \
  else pg_catalog.current_setting('geo.login_role_acl_verification_failed') \
  end"
