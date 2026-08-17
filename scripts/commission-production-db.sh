#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly SECRET_ROOT=/srv/geo-saas/secrets
readonly POSTGRES_DATA_ROOT=/srv/geo-saas/data/postgres
readonly DEFAULT_ENV_FILE=${SECRET_ROOT}/commissioning.env
readonly HISTORICAL_PUBLICATION_MANIFEST=${SECRET_ROOT}/historical-publication.json
readonly LOCAL_DOCKER_HOST=unix:///var/run/docker.sock
readonly WAIT_TIMEOUT_SECONDS=300

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/commission-production-db.sh <action>

Actions must be run separately and in this order:
  database            Start PostgreSQL, run migrations, then reconcile roles and ACLs
  provision-tenant    Provision or exactly replay one approved tenant request
  bootstrap-operator  Bind the initial owner to the already-provisioned tenant
  commission-ctrip-bridge
                      Create or rotate the credential-less, tenant-bound Bridge identity
  bind-historical-publication
                      Bind the reviewed offline publication manifest after owner bootstrap

All commissioning values are read only from
/srv/geo-saas/secrets/commissioning.env (or GEO_COMMISSION_ENV_FILE). Never pass
a password or tenant value as a command argument.
USAGE
  exit 64
}

die() {
  printf 'Production DB commissioning refused: %s\n' "$1" >&2
  exit 1
}

[[ $# -eq 1 ]] || usage
readonly ACTION=$1
case "${ACTION}" in
  database | provision-tenant | bootstrap-operator | commission-ctrip-bridge | bind-historical-publication) ;;
  *) usage ;;
esac

[[ "$(uname -s)" == Linux ]] ||
  die 'this command must run on the Linux production server, never on macOS'
((EUID != 0)) || die 'run as the non-root deploy user, not with sudo'

readonly ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly COMPOSE_FILE=${ROOT_DIR}/compose.production-db.yaml
readonly REQUESTED_ENV_FILE=${GEO_COMMISSION_ENV_FILE:-${DEFAULT_ENV_FILE}}
readonly RELEASE_MARKER=${ROOT_DIR}/.geo-release
readonly CURRENT_UID="$(id -u)"
readonly CURRENT_GID="$(id -g)"
readonly DEPLOYMENT_LOCK_FILE=${SECRET_ROOT}/.geo-deployment.lock
readonly DEPLOYMENT_JOURNAL_FILE=${SECRET_ROOT}/.geo-deployment-journal
readonly DEPLOYMENT_JOURNAL_STAGE_FILE=${SECRET_ROOT}/.geo-deployment-journal.stage
readonly DEPLOYMENT_GEO_STAGE_FILE=${SECRET_ROOT}/.geo.env.rollback-stage
readonly DEPLOYMENT_COMMISSIONING_STAGE_FILE=${SECRET_ROOT}/.commissioning.env.rollback-stage
readonly DEPLOYMENT_CURRENT_STAGE_FILE=/srv/geo-saas/app/.current.rollback-stage
readonly RESTORE_INHIBIT_MARKER=${SECRET_ROOT}/.geo-restore-inhibit
readonly RESTORE_CLEARANCE_GATE=${SECRET_ROOT}/.geo-restore-inhibit-clearance

lock_identity() {
  local path=$1
  stat -c '%d:%i:%u:%h:%a' -- "${path}"
}

fd_identity() {
  local fd=$1
  local fd_path=/proc/self/fd/${fd}
  [[ -e "${fd_path}" ]] || fd_path=/dev/fd/${fd}
  stat -Lc '%d:%i:%u:%h:%a' -- "${fd_path}"
}

acquire_deployment_lock() {
  local path_identity
  local opened_identity

  command -v flock >/dev/null 2>&1 || die 'flock is unavailable'
  [[ -d "${SECRET_ROOT}" && ! -L "${SECRET_ROOT}" ]] ||
    die "secret root is missing or is a symlink: ${SECRET_ROOT}"
  [[ "$(stat -c '%u' -- "${SECRET_ROOT}")" == "${CURRENT_UID}" ]] ||
    die 'secret root must be owned by the deploy user'
  [[ "$(stat -c '%g' -- "${SECRET_ROOT}")" == "${CURRENT_GID}" ]] ||
    die 'secret root group must match the deploy user'
  [[ "$(stat -c '%a' -- "${SECRET_ROOT}")" == 700 ]] ||
    die 'secret root mode must be exactly 700'
  if [[ -e "${DEPLOYMENT_LOCK_FILE}" || -L "${DEPLOYMENT_LOCK_FILE}" ]]; then
    [[ -f "${DEPLOYMENT_LOCK_FILE}" && ! -L "${DEPLOYMENT_LOCK_FILE}" ]] ||
      die 'deployment lock must be a regular non-symlink file'
    [[ "$(stat -c '%u' -- "${DEPLOYMENT_LOCK_FILE}")" == "${CURRENT_UID}" ]] ||
      die 'deployment lock must be owned by the deploy user'
    [[ "$(stat -c '%h' -- "${DEPLOYMENT_LOCK_FILE}")" == 1 ]] ||
      die 'deployment lock must have exactly one link'
    [[ "$(stat -c '%a' -- "${DEPLOYMENT_LOCK_FILE}")" == 600 ]] ||
      die 'deployment lock mode must be exactly 600'
  fi
  exec 9>>"${DEPLOYMENT_LOCK_FILE}"
  [[ -f "${DEPLOYMENT_LOCK_FILE}" && ! -L "${DEPLOYMENT_LOCK_FILE}" ]] ||
    die 'deployment lock changed to a symlink while it was opened'
  chmod 0600 "${DEPLOYMENT_LOCK_FILE}"
  path_identity="$(lock_identity "${DEPLOYMENT_LOCK_FILE}")"
  opened_identity="$(fd_identity 9)"
  [[ "${path_identity}" == "${opened_identity}" ]] ||
    die 'deployment lock changed while it was opened'
  flock --nonblock 9 || die 'another production deployment operation is already running'
}

acquire_deployment_lock
[[ ! -e "${RESTORE_INHIBIT_MARKER}" && ! -L "${RESTORE_INHIBIT_MARKER}" ]] ||
  die 'database commissioning is inhibited until the persistent incident-restore marker is cleared'
[[ ! -e "${RESTORE_CLEARANCE_GATE}" && ! -L "${RESTORE_CLEARANCE_GATE}" ]] ||
  die 'database commissioning is inhibited by an incomplete restore clearance transaction'
[[ ! -e "${DEPLOYMENT_JOURNAL_FILE}" && ! -L "${DEPLOYMENT_JOURNAL_FILE}" ]] ||
  die 'a pending deployment journal exists; run rollback recovery before DB commissioning'
[[ ! -e "${DEPLOYMENT_JOURNAL_STAGE_FILE}" && ! -L "${DEPLOYMENT_JOURNAL_STAGE_FILE}" ]] ||
  die 'a pending deployment journal stage exists; run rollback recovery before DB commissioning'
for deployment_stage in \
  "${DEPLOYMENT_GEO_STAGE_FILE}" \
  "${DEPLOYMENT_COMMISSIONING_STAGE_FILE}" \
  "${DEPLOYMENT_CURRENT_STAGE_FILE}"; do
  [[ ! -e "${deployment_stage}" && ! -L "${deployment_stage}" ]] ||
    die "a pending rollback stage exists; run rollback recovery before DB commissioning: ${deployment_stage}"
done

[[ -f "${RELEASE_MARKER}" && ! -L "${RELEASE_MARKER}" ]] ||
  die "release marker is missing, not regular, or is a symlink: ${RELEASE_MARKER}"
[[ "$(stat -c '%u' -- "${RELEASE_MARKER}")" == "${CURRENT_UID}" ]] ||
  die "release marker must be owned by uid ${CURRENT_UID}"
[[ "$(stat -c '%a' -- "${RELEASE_MARKER}")" == 444 ]] ||
  die 'release marker mode must be exactly 444'
[[ "$(stat -c '%h' -- "${RELEASE_MARKER}")" == 1 ]] ||
  die 'release marker must not have hard links'
[[ "$(stat -c '%s' -- "${RELEASE_MARKER}")" == 41 ]] ||
  die 'release marker must contain exactly one 40-character commit and a newline'
IFS= read -r RELEASE_REVISION <"${RELEASE_MARKER}"
readonly RELEASE_REVISION
[[ "${RELEASE_REVISION}" =~ ^[0-9a-f]{40}$ ]] ||
  die 'release marker must contain a lowercase 40-character commit'

require_directory() {
  local path=$1
  local expected_uid=$2
  local expected_gid=$3
  local expected_mode=$4
  local actual_uid
  local actual_gid
  local actual_mode

  [[ -d "${path}" && ! -L "${path}" ]] || die "required directory is missing or unsafe: ${path}"
  actual_uid="$(stat -c '%u' -- "${path}")"
  actual_gid="$(stat -c '%g' -- "${path}")"
  actual_mode="$(stat -c '%a' -- "${path}")"
  [[ "${actual_uid}" == "${expected_uid}" ]] ||
    die "directory owner mismatch for ${path}: expected uid ${expected_uid}, got ${actual_uid}"
  [[ "${actual_gid}" == "${expected_gid}" ]] ||
    die "directory group mismatch for ${path}: expected gid ${expected_gid}, got ${actual_gid}"
  [[ "${actual_mode}" == "${expected_mode}" ]] ||
    die "directory mode mismatch for ${path}: expected ${expected_mode}, got ${actual_mode}"
}

require_directory "${SECRET_ROOT}" "${CURRENT_UID}" "${CURRENT_GID}" 700
require_directory "${POSTGRES_DATA_ROOT}" 999 999 700

[[ -f "${REQUESTED_ENV_FILE}" && ! -L "${REQUESTED_ENV_FILE}" ]] ||
  die "commissioning env file is missing, not regular, or is a symlink: ${REQUESTED_ENV_FILE}"
readonly RESOLVED_ENV_FILE="$(realpath -e -- "${REQUESTED_ENV_FILE}")"
[[ "${RESOLVED_ENV_FILE}" == "${SECRET_ROOT}/"* ]] ||
  die "commissioning env file must be inside ${SECRET_ROOT}"
[[ "$(stat -c '%u' -- "${RESOLVED_ENV_FILE}")" == "${CURRENT_UID}" ]] ||
  die "commissioning env file must be owned by uid ${CURRENT_UID}"
[[ "$(stat -c '%a' -- "${RESOLVED_ENV_FILE}")" == 600 ]] ||
  die 'commissioning env file mode must be exactly 600'
[[ "$(stat -c '%h' -- "${RESOLVED_ENV_FILE}")" == 1 ]] ||
  die 'commissioning env file must not have hard links'
[[ ! -s "${RESOLVED_ENV_FILE}" || "$(tail -c 1 -- "${RESOLVED_ENV_FILE}" | od -An -t x1 | tr -d '[:space:]')" == 0a ]] ||
  die 'commissioning env file must end with a newline'

if [[ "${ACTION}" == bind-historical-publication ]]; then
  [[ -f "${HISTORICAL_PUBLICATION_MANIFEST}" && ! -L "${HISTORICAL_PUBLICATION_MANIFEST}" ]] ||
    die "historical publication manifest is missing, not regular, or is a symlink: ${HISTORICAL_PUBLICATION_MANIFEST}"
  [[ "$(realpath -e -- "${HISTORICAL_PUBLICATION_MANIFEST}")" == "${HISTORICAL_PUBLICATION_MANIFEST}" ]] ||
    die 'historical publication manifest must use the fixed server path'
  [[ "$(stat -c '%u' -- "${HISTORICAL_PUBLICATION_MANIFEST}")" == "${CURRENT_UID}" ]] ||
    die "historical publication manifest must be owned by uid ${CURRENT_UID}"
  [[ "$(stat -c '%a' -- "${HISTORICAL_PUBLICATION_MANIFEST}")" == 600 ]] ||
    die 'historical publication manifest mode must be exactly 600'
  [[ "$(stat -c '%h' -- "${HISTORICAL_PUBLICATION_MANIFEST}")" == 1 ]] ||
    die 'historical publication manifest must not have hard links'
  readonly HISTORICAL_MANIFEST_SIZE="$(stat -c '%s' -- "${HISTORICAL_PUBLICATION_MANIFEST}")"
  [[ "${HISTORICAL_MANIFEST_SIZE}" =~ ^[1-9][0-9]{0,6}$ ]] &&
    ((HISTORICAL_MANIFEST_SIZE <= 2000000)) ||
    die 'historical publication manifest must contain 1 to 2000000 bytes'
fi

declare -Ar ALLOWED_ENV_KEYS=(
  [COMPOSE_PROJECT_NAME]=1
  [GEO_IMAGE_PREFIX]=1
  [GEO_IMAGE_TAG]=1
  [GEO_IMAGE_REVISION]=1
  [NODE_IMAGE]=1
  [NPM_REGISTRY]=1
  [POSTGRES_DB]=1
  [POSTGRES_ADMIN_USER]=1
  [POSTGRES_ADMIN_PASSWORD]=1
  [GEO_API_DB_USER]=1
  [GEO_API_DB_PASSWORD]=1
  [GEO_WORKER_DB_USER]=1
  [GEO_WORKER_DB_PASSWORD]=1
  [GEO_IDENTITY_DB_USER]=1
  [GEO_IDENTITY_DB_PASSWORD]=1
  [GEO_PROVISION_IDEMPOTENCY_KEY]=1
  [GEO_PROVISION_TENANT_SLUG]=1
  [GEO_PROVISION_LEGAL_NAME]=1
  [GEO_PROVISION_DISPLAY_NAME]=1
  [GEO_PROVISION_INDUSTRY]=1
  [GEO_PROVISION_DEFAULT_LOCALE]=1
  [GEO_PROVISION_BRAND_CANONICAL_NAME]=1
  [GEO_PROVISION_BRAND_DISPLAY_NAME]=1
  [GEO_PROVISION_CONTACTS_JSON]=1
  [GEO_PROVISION_WORKER_NAME]=1
  [GEO_BOOTSTRAP_TENANT_SLUG]=1
  [GEO_BOOTSTRAP_EMAIL]=1
  [GEO_BOOTSTRAP_DISPLAY_NAME]=1
  [GEO_BOOTSTRAP_PASSWORD]=1
  [GEO_CTRIP_BRIDGE_TENANT_SLUG]=1
  [GEO_CTRIP_BRIDGE_OPERATOR_EMAIL]=1
  [GEO_CTRIP_BRIDGE_IDEMPOTENCY_KEY]=1
  [GEO_CTRIP_BRIDGE_PRINCIPAL_NAME]=1
)
declare -A seen_env_keys=()
declare -A env_values=()
line_number=0
while IFS= read -r line || [[ -n "${line}" ]]; do
  ((line_number += 1))
  [[ "${line}" != *$'\r'* ]] ||
    die "commissioning env line ${line_number} contains CR"
  [[ -z "${line}" || "${line}" == \#* ]] && continue
  [[ "${line}" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] ||
    die "commissioning env line ${line_number} must be KEY=value with no leading whitespace"
  key=${BASH_REMATCH[1]}
  value=${BASH_REMATCH[2]}
  [[ -n "${ALLOWED_ENV_KEYS[${key}]+present}" ]] ||
    die "commissioning env contains a non-commissioning key: ${key}"
  [[ -z "${seen_env_keys[${key}]+present}" ]] ||
    die "commissioning env contains a duplicate key: ${key}"
  seen_env_keys["${key}"]=1
  env_values["${key}"]=${value}
done <"${RESOLVED_ENV_FILE}"
unset line key value line_number

require_env_keys() {
  local key
  for key in "$@"; do
    [[ -n "${seen_env_keys[${key}]+present}" ]] ||
      die "${key} is required in ${RESOLVED_ENV_FILE} for ${ACTION}"
  done
}

enforce_bootstrap_password_scope() {
  local action=$1
  local password_key_presence=$2

  [[ "${action}" == bootstrap-operator || "${password_key_presence}" != present ]] ||
    die 'GEO_BOOTSTRAP_PASSWORD must be absent for every action except bootstrap-operator'
}

enforce_bootstrap_password_scope \
  "${ACTION}" \
  "${seen_env_keys[GEO_BOOTSTRAP_PASSWORD]+present}"

readonly -a DATABASE_ENV_KEYS=(
  POSTGRES_DB
  POSTGRES_ADMIN_USER
  POSTGRES_ADMIN_PASSWORD
  GEO_API_DB_USER
  GEO_API_DB_PASSWORD
  GEO_WORKER_DB_USER
  GEO_WORKER_DB_PASSWORD
  GEO_IDENTITY_DB_USER
  GEO_IDENTITY_DB_PASSWORD
  GEO_IMAGE_TAG
  GEO_IMAGE_REVISION
)
readonly -a TENANT_ENV_KEYS=(
  GEO_PROVISION_IDEMPOTENCY_KEY
  GEO_PROVISION_TENANT_SLUG
  GEO_PROVISION_LEGAL_NAME
  GEO_PROVISION_DISPLAY_NAME
  GEO_PROVISION_INDUSTRY
  GEO_PROVISION_DEFAULT_LOCALE
  GEO_PROVISION_BRAND_CANONICAL_NAME
  GEO_PROVISION_BRAND_DISPLAY_NAME
  GEO_PROVISION_CONTACTS_JSON
  GEO_PROVISION_WORKER_NAME
)
readonly -a OPERATOR_ENV_KEYS=(
  GEO_BOOTSTRAP_TENANT_SLUG
  GEO_BOOTSTRAP_EMAIL
  GEO_BOOTSTRAP_DISPLAY_NAME
  GEO_BOOTSTRAP_PASSWORD
)
readonly -a CTRIP_BRIDGE_ENV_KEYS=(
  GEO_CTRIP_BRIDGE_TENANT_SLUG
  GEO_CTRIP_BRIDGE_OPERATOR_EMAIL
  GEO_CTRIP_BRIDGE_IDEMPOTENCY_KEY
  GEO_CTRIP_BRIDGE_PRINCIPAL_NAME
)

require_env_keys "${DATABASE_ENV_KEYS[@]}"
case "${ACTION}" in
  provision-tenant) require_env_keys "${TENANT_ENV_KEYS[@]}" ;;
  bootstrap-operator) require_env_keys "${OPERATOR_ENV_KEYS[@]}" ;;
  commission-ctrip-bridge) require_env_keys "${CTRIP_BRIDGE_ENV_KEYS[@]}" ;;
esac

validate_identifier() {
  local key=$1
  local value=${env_values[${key}]}
  [[ "${value}" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] ||
    die "${key} must be an unquoted lowercase PostgreSQL identifier"
}

validate_database_secret() {
  local key=$1
  local value=${env_values[${key}]}
  local lowered=${value,,}
  [[ "${value}" =~ ^[A-Za-z0-9._~-]{32,256}$ ]] ||
    die "${key} must be an unquoted 32-256 character URL-safe random value"
  case "${lowered}" in
    replace-* | changeme* | password* | secret* | example* | fixture*)
      die "${key} must not be a placeholder or fixture value"
      ;;
  esac
}

for identifier_key in POSTGRES_DB POSTGRES_ADMIN_USER GEO_API_DB_USER GEO_WORKER_DB_USER GEO_IDENTITY_DB_USER; do
  validate_identifier "${identifier_key}"
done
for application_role_key in GEO_API_DB_USER GEO_WORKER_DB_USER GEO_IDENTITY_DB_USER; do
  case "${env_values[${application_role_key}]}" in
    geo_runtime | geo_dispatcher | geo_identity)
      die "${application_role_key} must not reuse a NOLOGIN database role"
      ;;
  esac
done
for secret_key in POSTGRES_ADMIN_PASSWORD GEO_API_DB_PASSWORD GEO_WORKER_DB_PASSWORD GEO_IDENTITY_DB_PASSWORD; do
  validate_database_secret "${secret_key}"
done

[[ "${env_values[POSTGRES_ADMIN_USER]}" != "${env_values[GEO_API_DB_USER]}" &&
  "${env_values[POSTGRES_ADMIN_USER]}" != "${env_values[GEO_WORKER_DB_USER]}" &&
  "${env_values[POSTGRES_ADMIN_USER]}" != "${env_values[GEO_IDENTITY_DB_USER]}" &&
  "${env_values[GEO_API_DB_USER]}" != "${env_values[GEO_WORKER_DB_USER]}" &&
  "${env_values[GEO_API_DB_USER]}" != "${env_values[GEO_IDENTITY_DB_USER]}" &&
  "${env_values[GEO_WORKER_DB_USER]}" != "${env_values[GEO_IDENTITY_DB_USER]}" ]] ||
  die 'database admin and application login role names must all be distinct'

[[ "${env_values[POSTGRES_ADMIN_PASSWORD]}" != "${env_values[GEO_API_DB_PASSWORD]}" &&
  "${env_values[POSTGRES_ADMIN_PASSWORD]}" != "${env_values[GEO_WORKER_DB_PASSWORD]}" &&
  "${env_values[POSTGRES_ADMIN_PASSWORD]}" != "${env_values[GEO_IDENTITY_DB_PASSWORD]}" &&
  "${env_values[GEO_API_DB_PASSWORD]}" != "${env_values[GEO_WORKER_DB_PASSWORD]}" &&
  "${env_values[GEO_API_DB_PASSWORD]}" != "${env_values[GEO_IDENTITY_DB_PASSWORD]}" &&
  "${env_values[GEO_WORKER_DB_PASSWORD]}" != "${env_values[GEO_IDENTITY_DB_PASSWORD]}" ]] ||
  die 'database admin and application login passwords must all be independently generated'

if [[ -n "${seen_env_keys[COMPOSE_PROJECT_NAME]+present}" ]]; then
  [[ "${env_values[COMPOSE_PROJECT_NAME]}" =~ ^[a-z0-9][a-z0-9_-]*$ ]] ||
    die 'COMPOSE_PROJECT_NAME is invalid'
fi
readonly COMPOSE_PROJECT=${env_values[COMPOSE_PROJECT_NAME]:-geo-saas}
readonly EXPECTED_POSTGRES_VOLUME=${COMPOSE_PROJECT}-postgres-data
if [[ -n "${seen_env_keys[GEO_IMAGE_PREFIX]+present}" ]]; then
  [[ "${env_values[GEO_IMAGE_PREFIX]}" =~ ^[a-z0-9][a-z0-9./_-]*$ ]] ||
    die 'GEO_IMAGE_PREFIX is invalid'
fi
if [[ -n "${seen_env_keys[GEO_IMAGE_TAG]+present}" ]]; then
  [[ "${env_values[GEO_IMAGE_TAG]}" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] ||
    die 'GEO_IMAGE_TAG is invalid'
fi
readonly IMAGE_PREFIX=${env_values[GEO_IMAGE_PREFIX]:-geo-saas}
readonly IMAGE_TAG=${env_values[GEO_IMAGE_TAG]}
readonly IMAGE_REVISION=${env_values[GEO_IMAGE_REVISION]}
[[ "${IMAGE_REVISION}" =~ ^[0-9a-f]{40}$ ]] ||
  die 'GEO_IMAGE_REVISION must be the exact lowercase 40-character release commit'
[[ "${IMAGE_REVISION}" == "${RELEASE_REVISION}" ]] ||
  die 'GEO_IMAGE_REVISION does not match the immutable release marker'
[[ "${IMAGE_TAG}" == "${RELEASE_REVISION}" ]] ||
  die 'GEO_IMAGE_TAG must equal the immutable release commit'
if [[ -n "${seen_env_keys[NODE_IMAGE]+present}" ]]; then
  [[ "${env_values[NODE_IMAGE]}" =~ ^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$ ]] ||
    die 'NODE_IMAGE must be a digest-pinned image reference'
fi
if [[ -n "${seen_env_keys[NPM_REGISTRY]+present}" ]]; then
  [[ "${env_values[NPM_REGISTRY]}" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[^?#[:space:]]*)?$ ]] ||
    die 'NPM_REGISTRY must be an HTTPS URL without credentials, query, or fragment'
fi
unset env_values

[[ -f "${COMPOSE_FILE}" && ! -L "${COMPOSE_FILE}" ]] ||
  die "release DB-only Compose file is missing or unsafe: ${COMPOSE_FILE}"
command -v docker >/dev/null 2>&1 || die 'docker is not installed on this Linux server'
command -v flock >/dev/null 2>&1 || die 'flock is unavailable'
[[ -S /var/run/docker.sock ]] || die 'the local Docker socket is unavailable'

readonly PASSWD_ENTRY="$(getent passwd "${CURRENT_UID}")"
[[ -n "${PASSWD_ENTRY}" ]] || die "could not resolve passwd entry for uid ${CURRENT_UID}"
IFS=: read -r _ _ _ _ _ DEPLOY_HOME _ <<<"${PASSWD_ENTRY}"
readonly DEPLOY_HOME
[[ -d "${DEPLOY_HOME}" ]] || die 'deploy user home directory is unavailable'

docker_local() {
  env -i \
    HOME="${DEPLOY_HOME}" \
    PATH="${PATH}" \
    DOCKER_HOST="${LOCAL_DOCKER_HOST}" \
    COMPOSE_DISABLE_ENV_FILE=1 \
    docker "$@"
}

compose() {
  docker_local compose \
    --env-file "${RESOLVED_ENV_FILE}" \
    -f "${COMPOSE_FILE}" \
    --profile database-commissioning \
    --profile tenant-provisioning \
    --profile operator-bootstrap \
    --profile ctrip-bridge-commissioning \
    --profile historical-publication-binding \
    "$@"
}

resolve_project_image_ref() {
  local service_name=$1
  local image_suffix=$2
  local expected_ref="${IMAGE_PREFIX}-${image_suffix}:${IMAGE_TAG}"
  local rendered_refs
  local rendered_ref
  local matches=0

  rendered_refs="$(compose config --images "${service_name}")" ||
    die "could not resolve Compose image references for ${service_name}"
  while IFS= read -r rendered_ref; do
    if [[ "${rendered_ref}" == "${expected_ref}" ]]; then
      ((matches += 1))
    fi
  done <<<"${rendered_refs}"
  [[ "${matches}" == 1 ]] ||
    die "could not resolve the release-matched project image for ${service_name}"
  printf '%s' "${expected_ref}"
}

docker_local compose version >/dev/null 2>&1 || die 'the Docker Compose v2 plugin is unavailable'
docker_local info >/dev/null 2>&1 || die 'the deploy user cannot access the local Docker daemon'

readonly LOCK_FILE=${SECRET_ROOT}/.commission-production-db.lock
[[ ! -e "${LOCK_FILE}" || (-f "${LOCK_FILE}" && ! -L "${LOCK_FILE}") ]] ||
  die "commissioning lock path is unsafe: ${LOCK_FILE}"
exec 10>"${LOCK_FILE}"
chmod 0600 "${LOCK_FILE}"
flock --nonblock 10 || die 'another production DB commissioning action is already running'

compose config --quiet
readonly EXPECTED_SERVICES=$'postgres\ndb-migrate\ndb-bootstrap\ndb-provision-tenant\ndb-bootstrap-operator\ndb-commission-ctrip-bridge\ndb-bind-historical-publication'
EXPECTED_SERVICES_CANONICAL="$(LC_ALL=C sort <<<"${EXPECTED_SERVICES}")"
readonly EXPECTED_SERVICES_CANONICAL
ACTUAL_SERVICES="$(compose config --services)"
readonly ACTUAL_SERVICES
ACTUAL_SERVICES_CANONICAL="$(LC_ALL=C sort <<<"${ACTUAL_SERVICES}")"
readonly ACTUAL_SERVICES_CANONICAL
[[ "${ACTUAL_SERVICES_CANONICAL}" == "${EXPECTED_SERVICES_CANONICAL}" ]] ||
  die 'DB-only Compose service allowlist changed; review the release before commissioning'

validate_postgres_volume() {
  local must_exist=$1
  local driver
  local option_type
  local option_mode
  local option_device

  if ! driver="$(docker_local volume inspect --format '{{.Driver}}' "${EXPECTED_POSTGRES_VOLUME}" 2>/dev/null)"; then
    [[ "${must_exist}" == false ]] && return
    die "expected PostgreSQL volume is missing: ${EXPECTED_POSTGRES_VOLUME}"
  fi
  option_type="$(docker_local volume inspect \
    --format '{{ index .Options "type" }}' "${EXPECTED_POSTGRES_VOLUME}")"
  option_mode="$(docker_local volume inspect \
    --format '{{ index .Options "o" }}' "${EXPECTED_POSTGRES_VOLUME}")"
  option_device="$(docker_local volume inspect \
    --format '{{ index .Options "device" }}' "${EXPECTED_POSTGRES_VOLUME}")"
  [[ "${driver}" == local && "${option_type}" == none && "${option_mode}" == bind &&
    "${option_device}" == "${POSTGRES_DATA_ROOT}" ]] ||
    die "PostgreSQL volume does not bind the approved host data directory: ${EXPECTED_POSTGRES_VOLUME}"
}

validate_postgres_container_mount() {
  local container_id=$1
  local mount_binding

  mount_binding="$(docker_local inspect --format \
    '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}}|{{.Name}}|{{.RW}}{{"\n"}}{{end}}{{end}}' \
    "${container_id}")"
  [[ "${mount_binding}" == "volume|${EXPECTED_POSTGRES_VOLUME}|true" ]] ||
    die 'existing PostgreSQL container is not mounted from the approved named volume'
}

validate_postgres_volume false

start_postgres() {
  local container_id
  local container_status
  local health_status
  local deadline

  container_id="$(compose ps --all --quiet postgres)"
  if [[ -z "${container_id}" ]]; then
    compose up --detach --wait --wait-timeout "${WAIT_TIMEOUT_SECONDS}" postgres >&2
    container_id="$(compose ps --all --quiet postgres)"
    [[ -n "${container_id}" && "${container_id}" != *$'\n'* ]] ||
      die 'PostgreSQL container was not created uniquely'
    validate_postgres_volume true
    validate_postgres_container_mount "${container_id}"
    return
  fi
  [[ "${container_id}" != *$'\n'* ]] ||
    die 'multiple PostgreSQL containers exist for this Compose project'
  validate_postgres_volume true
  validate_postgres_container_mount "${container_id}"

  container_status="$(docker_local inspect --format '{{.State.Status}}' "${container_id}")"
  health_status="$(docker_local inspect \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
    "${container_id}")"
  if [[ "${container_status}" == running && "${health_status}" == healthy ]]; then
    printf 'Reusing the healthy PostgreSQL container without Compose reconciliation.\n' >&2
    return
  fi
  case "${container_status}" in
    created | exited)
      docker_local start "${container_id}" >&2
      ;;
    running)
      [[ "${health_status}" == starting ]] ||
        die "existing PostgreSQL container is not safely reusable: ${container_status}/${health_status}"
      ;;
    *) die "existing PostgreSQL container is not safely reusable: ${container_status}/${health_status}" ;;
  esac

  deadline=$((SECONDS + WAIT_TIMEOUT_SECONDS))
  while ((SECONDS < deadline)); do
    container_status="$(docker_local inspect --format '{{.State.Status}}' "${container_id}")"
    health_status="$(docker_local inspect \
      --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
      "${container_id}")"
    if [[ "${container_status}" == running && "${health_status}" == healthy ]]; then
      return
    fi
    if [[ "${container_status}" != running || "${health_status}" != starting ]]; then
      die "existing PostgreSQL container failed while starting: ${container_status}/${health_status}"
    fi
    sleep 2
  done
  die 'existing PostgreSQL container did not become healthy before the timeout'
}

printf 'Building the release-matched DB tools image on the Linux server...\n' >&2
compose build db-migrate >&2
DB_TOOLS_IMAGE_REF="$(resolve_project_image_ref db-migrate db-tools-commissioning)"
readonly DB_TOOLS_IMAGE_REF
readonly DB_TOOLS_IMAGE_REVISION="$(docker_local image inspect \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
  "${DB_TOOLS_IMAGE_REF}")"
[[ "${DB_TOOLS_IMAGE_REVISION}" == "${IMAGE_REVISION}" ]] ||
  die 'built commissioning DB tools image revision does not match GEO_IMAGE_REVISION'

case "${ACTION}" in
  database)
    printf 'Starting PostgreSQL and applying the migration/role chain...\n' >&2
    start_postgres
    compose run --rm --no-deps db-migrate
    compose run --rm --no-deps db-bootstrap
    printf 'Production database commissioning completed; no application service was started.\n' >&2
    ;;
  provision-tenant)
    start_postgres
    compose run --rm --no-deps db-provision-tenant
    printf 'Tenant provisioning completed; retain the emitted identifiers in the approved ticket.\n' >&2
    ;;
  bootstrap-operator)
    start_postgres
    compose run --rm --no-deps db-bootstrap-operator
    printf 'Initial operator bootstrap completed; no application service was started.\n' >&2
    ;;
  commission-ctrip-bridge)
    start_postgres
    compose run --rm --no-deps db-commission-ctrip-bridge
    printf 'Ctrip Bridge identity commissioning completed; no credential or application service was created.\n' >&2
    ;;
  bind-historical-publication)
    start_postgres
    compose run --rm --no-deps -T db-bind-historical-publication <"${HISTORICAL_PUBLICATION_MANIFEST}"
    printf 'Historical publication binding completed; retain the emitted receipt before Phase A.\n' >&2
    ;;
esac
