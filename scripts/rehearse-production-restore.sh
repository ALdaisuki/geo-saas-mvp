#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly LOCAL_DOCKER_HOST=unix:///var/run/docker.sock

die() {
  printf 'Restore rehearsal refused: %s\n' "$1" >&2
  exit 1
}

require_owned_regular_file() {
  local path=$1
  local expected_mode=$2
  local label=$3
  local metadata
  local owner
  local mode
  local links

  [[ -f "${path}" && ! -L "${path}" ]] || die "${label} is missing or unsafe"
  if metadata=$(stat -c '%u %a %h' -- "${path}" 2>/dev/null); then
    :
  else
    metadata=$(stat -f '%u %Lp %l' -- "${path}" 2>/dev/null) ||
      die "could not inspect ${label} metadata"
  fi
  read -r owner mode links <<<"${metadata}"
  [[ "${owner}" == "$(id -u)" ]] || die "${label} must be owned by the deploy user"
  [[ "${mode}" == "${expected_mode}" ]] || die "${label} mode must be exactly ${expected_mode}"
  [[ "${links}" == 1 ]] || die "${label} must not have hard links"
}

validate_strict_env_file() {
  local path=$1
  local line
  local line_number=0
  local key
  local links
  local seen_keys=' '

  [[ -f "${path}" && ! -L "${path}" ]] || die "production env file is missing or unsafe: ${path}"
  if links=$(stat -c '%h' -- "${path}" 2>/dev/null); then
    :
  else
    links=$(stat -f '%l' -- "${path}" 2>/dev/null) || die 'could not inspect production env hard links'
  fi
  [[ "${links}" == 1 ]] || die 'production env file must not have hard links'
  [[ ! -s "${path}" || "$(tail -c 1 -- "${path}" | od -An -t x1 | tr -d '[:space:]')" == 0a ]] ||
    die 'production env file must end with a newline'
  while IFS= read -r line || [[ -n "${line}" ]]; do
    ((line_number += 1))
    [[ "${line}" != *$'\r'* ]] || die "production env line ${line_number} contains CR"
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    [[ "${line}" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] ||
      die "production env line ${line_number} must be KEY=value with no leading whitespace or export"
    key=${BASH_REMATCH[1]}
    [[ "${seen_keys}" != *" ${key} "* ]] ||
      die "production env contains a duplicate key: ${key}"
    seen_keys+="${key} "
  done <"${path}"
}

usage() {
  cat >&2 <<'USAGE'
Usage: rehearse-production-restore.sh \
  --bundle ABSOLUTE_PATH \
  --checksum-file ABSOLUTE_PATH \
  [--release-root ABSOLUTE_PATH] \
  [--env-file ABSOLUTE_PATH] \
  [--deployment-lock ABSOLUTE_PATH] \
  [--report ABSOLUTE_PATH] \
  [--docker-bin ABSOLUTE_PATH]

The rehearsal creates a fresh isolated Compose project and named PostgreSQL volume.
It stops the rehearsal PostgreSQL container on success but retains all isolated
containers and volumes for operator review. It never includes compose.production.yaml.
USAGE
  exit 64
}

bundle=""
checksum_file=""
release_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
env_file=/srv/geo-saas/secrets/geo.env
report=""
docker_bin=docker
deployment_lock_file=""

while (($# > 0)); do
  case "$1" in
    --bundle)
      (($# >= 2)) || usage
      bundle=$2
      shift 2
      ;;
    --checksum-file)
      (($# >= 2)) || usage
      checksum_file=$2
      shift 2
      ;;
    --release-root)
      (($# >= 2)) || usage
      release_root=$2
      shift 2
      ;;
    --env-file)
      (($# >= 2)) || usage
      env_file=$2
      shift 2
      ;;
    --deployment-lock)
      (($# >= 2)) || usage
      deployment_lock_file=$2
      shift 2
      ;;
    --report)
      (($# >= 2)) || usage
      report=$2
      shift 2
      ;;
    --docker-bin)
      (($# >= 2)) || usage
      docker_bin=$2
      shift 2
      ;;
    --help|-h)
      usage
      ;;
    *)
      usage
      ;;
  esac
done

((EUID != 0)) || die 'run restore rehearsal as the non-root deploy user'

[[ -n "${bundle}" && -n "${checksum_file}" ]] || usage
[[ "${bundle}" == /* && "${checksum_file}" == /* && "${release_root}" == /* &&
  "${env_file}" == /* ]] || die 'bundle, checksum, release, and env paths must be absolute'
[[ -z "${report}" || "${report}" == /* ]] || die 'report path must be absolute'
if [[ -z "${deployment_lock_file}" ]]; then
  deployment_lock_file="$(dirname -- "${env_file}")/.geo-deployment.lock"
fi
[[ "${deployment_lock_file}" == /* ]] || die 'deployment lock path must be absolute'
[[ -d "${bundle}" && ! -L "${bundle}" ]] || die 'bundle is missing or unsafe'
[[ -f "${checksum_file}" && ! -L "${checksum_file}" ]] ||
  die 'out-of-band checksum file is missing or unsafe'
[[ -d "${release_root}" && ! -L "${release_root}" ]] || die 'release root is missing or unsafe'
release_root="$(cd -- "${release_root}" && pwd -P)"
[[ -f "${release_root}/compose.yaml" && ! -L "${release_root}/compose.yaml" ]] ||
  die 'base Compose file is missing or unsafe'
require_owned_regular_file "${release_root}/.geo-release" 444 'immutable release marker'
[[ "$(wc -c <"${release_root}/.geo-release" | tr -d '[:space:]')" == 41 ]] ||
  die 'release marker must contain exactly one commit and newline'
IFS= read -r release_revision <"${release_root}/.geo-release"
[[ "${release_revision}" =~ ^[0-9a-f]{40}$ ]] ||
  die 'release marker must contain a lowercase 40-character commit'
[[ -f "${release_root}/docs/ops/postgres/verify-restore-rehearsal.sql" &&
  ! -L "${release_root}/docs/ops/postgres/verify-restore-rehearsal.sql" ]] ||
  die 'restore verification SQL is missing or unsafe'
[[ -d "${release_root}/packages/db/migrations" &&
  ! -L "${release_root}/packages/db/migrations" ]] || die 'migration directory is missing or unsafe'
require_owned_regular_file "${env_file}" 600 'production env file'
validate_strict_env_file "${env_file}"

if [[ "${docker_bin}" == */* ]]; then
  [[ "${docker_bin}" == /* && -x "${docker_bin}" && -f "${docker_bin}" && ! -L "${docker_bin}" ]] ||
    die 'Docker binary override must be an absolute executable non-symlink regular file'
else
  [[ "$(uname -s)" == Linux ]] ||
    die 'restore rehearsals must run on an isolated Linux Docker host, never on macOS'
  command -v "${docker_bin}" >/dev/null 2>&1 || die 'docker is not installed'
fi
command -v sudo >/dev/null 2>&1 || die 'sudo is unavailable for isolated application-file extraction'

command -v flock >/dev/null 2>&1 || die 'flock is unavailable'
deployment_lock_parent=$(dirname -- "${deployment_lock_file}")
[[ -d "${deployment_lock_parent}" && ! -L "${deployment_lock_parent}" ]] ||
  die 'shared deployment lock parent is missing or unsafe'
[[ ! -e "${deployment_lock_file}" ||
  (-f "${deployment_lock_file}" && ! -L "${deployment_lock_file}") ]] ||
  die 'shared deployment lock path is unsafe'
exec 7>>"${deployment_lock_file}"
chmod 0600 "${deployment_lock_file}"
require_owned_regular_file "${deployment_lock_file}" 600 'shared production deployment lock'
if [[ -e /proc/self/fd/7 ]]; then
  deployment_fd_identity=$(stat -Lc '%d:%i:%u:%h:%a' -- /proc/self/fd/7 2>/dev/null) ||
    die 'could not inspect shared deployment lock descriptor'
  deployment_path_identity=$(stat -c '%d:%i:%u:%h:%a' -- "${deployment_lock_file}" 2>/dev/null) ||
    die 'could not inspect shared deployment lock path'
  [[ "${deployment_fd_identity}" == "${deployment_path_identity}" ]] ||
    die 'shared deployment lock descriptor is not bound to the checked path'
fi
flock --nonblock 7 || die 'another production deployment operation is already running'

pending_transaction_artifacts=()
release_parent=$(dirname -- "${release_root}")
app_root_candidate=$(dirname -- "${release_parent}")
for pending_artifact in \
  "${deployment_lock_parent}/.geo-deployment-journal" \
  "${deployment_lock_parent}/.geo-deployment-journal.stage" \
  "${deployment_lock_parent}/.geo.env.rollback-stage" \
  "${deployment_lock_parent}/.commissioning.env.rollback-stage" \
  "${release_parent}/.current.rollback-stage" \
  "${app_root_candidate}/.current.rollback-stage" \
  "${release_parent}/.rollback-current."* \
  "${app_root_candidate}/.rollback-current."* \
  "${deployment_lock_parent}/geo.env.rollback."* \
  "${deployment_lock_parent}/geo.env.previous."*; do
  [[ -e "${pending_artifact}" || -L "${pending_artifact}" ]] || continue
  pending_transaction_artifacts+=("${pending_artifact}")
done
((${#pending_transaction_artifacts[@]} == 0)) ||
  die 'a pending rollback transaction artifact exists; reconcile it before rehearsal'

readonly RELEASE_ROOT="${release_root}"
readonly ENV_FILE="${env_file}"
readonly RELEASE_REVISION="${release_revision}"
readonly DOCKER_BIN="${docker_bin}"
readonly SOURCE_BUNDLE="$(cd -- "${bundle}" && pwd -P)"
readonly SOURCE_CHECKSUM_PARENT="$(cd -- "$(dirname -- "${checksum_file}")" && pwd -P)"
readonly SOURCE_CHECKSUM_FILE="${SOURCE_CHECKSUM_PARENT}/$(basename -- "${checksum_file}")"
readonly BACKUP_ID="$(basename -- "${SOURCE_BUNDLE}")"
[[ "${BACKUP_ID}" =~ ^[0-9]{8}T[0-9]{6}Z(-[a-z0-9][a-z0-9-]{0,31})?$ ]] ||
  die 'bundle directory name is not a valid backup ID'

verified_snapshot_parent=$(mktemp -d "${TMPDIR:-/tmp}/geo-restore-input.XXXXXX") ||
  die 'could not allocate a private verified bundle parent'
verified_snapshot_root="${verified_snapshot_parent}/snapshot"
cleanup_verified_snapshot() {
  [[ -z "${verified_snapshot_parent:-}" || ! -d "${verified_snapshot_parent}" ||
    -L "${verified_snapshot_parent}" ]] || rm -rf -- "${verified_snapshot_parent}"
}
trap cleanup_verified_snapshot EXIT

docker_local() {
  env -i \
    HOME="${HOME:-/tmp}" \
    PATH="${PATH}" \
    DOCKER_HOST="${LOCAL_DOCKER_HOST}" \
    COMPOSE_DISABLE_ENV_FILE=1 \
    "${DOCKER_BIN}" "$@"
}

source_compose=(
  docker_local compose
  --project-directory "${RELEASE_ROOT}"
  --env-file "${ENV_FILE}"
  -f "${RELEASE_ROOT}/compose.yaml"
)
"${source_compose[@]}" config --quiet || die 'base Compose configuration is invalid'
compose_environment=$("${source_compose[@]}" config --environment) ||
  die 'could not resolve the Compose environment'

compose_value() {
  local variable_name=$1
  local default_value=$2
  local resolved_value=${default_value}
  local matches=0
  local line
  while IFS= read -r line; do
    if [[ "${line}" == "${variable_name}="* ]]; then
      resolved_value=${line#*=}
      ((matches += 1))
    fi
  done <<<"${compose_environment}"
  [[ "${matches}" -le 1 ]] || die "Compose environment resolved ${variable_name} more than once"
  printf '%s' "${resolved_value}"
}

source_project=$(compose_value COMPOSE_PROJECT_NAME '')
postgres_db=$(compose_value POSTGRES_DB geo_saas)
postgres_admin_user=$(compose_value POSTGRES_ADMIN_USER geo_admin)
api_user=$(compose_value GEO_API_DB_USER geo_api)
worker_user=$(compose_value GEO_WORKER_DB_USER geo_worker)
identity_user=$(compose_value GEO_IDENTITY_DB_USER geo_identity_login)
image_tag=$(compose_value GEO_IMAGE_TAG '')
image_revision=$(compose_value GEO_IMAGE_REVISION '')
unset compose_environment

[[ "${source_project}" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] ||
  die 'source Compose project did not resolve exactly once or is invalid'
[[ "${postgres_db}" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ &&
  "${postgres_admin_user}" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] ||
  die 'PostgreSQL database or admin role name is invalid'
for role_name in "${api_user}" "${worker_user}" "${identity_user}"; do
  [[ "${role_name}" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] ||
    die 'application role name is invalid'
done
[[ "${api_user}" != "${worker_user}" && "${api_user}" != "${identity_user}" &&
  "${worker_user}" != "${identity_user}" ]] || die 'application roles must be distinct'
[[ "${image_tag}" == "${RELEASE_REVISION}" && "${image_revision}" == "${RELEASE_REVISION}" ]] ||
  die 'GEO_IMAGE_TAG and GEO_IMAGE_REVISION must equal the immutable release marker'

"$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/verify-backup-bundle.sh" \
  --bundle "${SOURCE_BUNDLE}" \
  --checksum-file "${SOURCE_CHECKSUM_FILE}" \
  --expected-release "${RELEASE_REVISION}" \
  --expected-project "${source_project}" \
  --compose-file "${RELEASE_ROOT}/compose.yaml" \
  --docker-bin "${DOCKER_BIN}" \
  --snapshot-root "${verified_snapshot_root}" || die 'backup bundle verification failed'

readonly BUNDLE="${verified_snapshot_root}/${BACKUP_ID}"
readonly CHECKSUM_PARENT="${verified_snapshot_root}"
readonly CHECKSUM_FILE="${verified_snapshot_root}/$(basename -- "${SOURCE_CHECKSUM_FILE}")"
[[ -d "${BUNDLE}" && -f "${CHECKSUM_FILE}" ]] ||
  die 'verified bundle snapshot is incomplete'

project_id=$(printf '%s' "${BACKUP_ID}" | tr '[:upper:]' '[:lower:]')
project_id=${project_id:0:40}
rehearsal_project="geo-restore-${project_id}-$$"
[[ "${rehearsal_project}" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] ||
  die 'generated rehearsal project name is invalid'
[[ "${rehearsal_project}" != "${source_project}" ]] ||
  die 'rehearsal project unexpectedly matches the source project'
postgres_volume="${rehearsal_project}-postgres-data"

docker_rehearsal() {
  env -i \
    HOME="${HOME:-/tmp}" \
    PATH="${PATH}" \
    DOCKER_HOST="${LOCAL_DOCKER_HOST}" \
    COMPOSE_DISABLE_ENV_FILE=1 \
    COMPOSE_PROJECT_NAME="${rehearsal_project}" \
    "${DOCKER_BIN}" "$@"
}

rehearsal_compose=(
  docker_rehearsal compose
  --project-directory "${RELEASE_ROOT}"
  --project-name "${rehearsal_project}"
  --env-file "${ENV_FILE}"
  -f "${RELEASE_ROOT}/compose.yaml"
)
"${rehearsal_compose[@]}" config --quiet || die 'isolated rehearsal Compose config is invalid'
[[ -z "$("${rehearsal_compose[@]}" ps --all --quiet)" ]] ||
  die 'generated rehearsal project already has containers'
if docker_rehearsal volume inspect "${postgres_volume}" >/dev/null 2>&1; then
  die 'generated rehearsal project already has a PostgreSQL volume'
fi
[[ -z "$(docker_rehearsal network ls --quiet \
  --filter "label=com.docker.compose.project=${rehearsal_project}")" ]] ||
  die 'generated rehearsal project already has a Compose network'

created_volume=$(docker_rehearsal volume create \
  --driver local \
  --label "com.docker.compose.project=${rehearsal_project}" \
  --label 'com.docker.compose.volume=postgres-data' \
  "${postgres_volume}") ||
  die "could not create the fresh isolated PostgreSQL volume; project retained: ${rehearsal_project}"
[[ "${created_volume}" == "${postgres_volume}" ]] ||
  die "Docker returned an unexpected isolated PostgreSQL volume; project retained: ${rehearsal_project}"
volume_name=$(docker_rehearsal volume inspect --format '{{.Name}}' "${postgres_volume}") ||
  die "could not inspect the fresh isolated PostgreSQL volume; project retained: ${rehearsal_project}"
volume_driver=$(docker_rehearsal volume inspect --format '{{.Driver}}' "${postgres_volume}") ||
  die "could not inspect isolated PostgreSQL volume driver; project retained: ${rehearsal_project}"
volume_options=$(docker_rehearsal volume inspect --format '{{json .Options}}' "${postgres_volume}") ||
  die "could not inspect isolated PostgreSQL volume options; project retained: ${rehearsal_project}"
volume_project_label=$(docker_rehearsal volume inspect \
  --format '{{index .Labels "com.docker.compose.project"}}' "${postgres_volume}") ||
  die "could not inspect isolated PostgreSQL volume project label; project retained: ${rehearsal_project}"
volume_service_label=$(docker_rehearsal volume inspect \
  --format '{{index .Labels "com.docker.compose.volume"}}' "${postgres_volume}") ||
  die "could not inspect isolated PostgreSQL volume service label; project retained: ${rehearsal_project}"
[[ "${volume_name}" == "${postgres_volume}" && "${volume_driver}" == local &&
  ("${volume_options}" == '{}' || "${volume_options}" == null) &&
  "${volume_project_label}" == "${rehearsal_project}" &&
  "${volume_service_label}" == postgres-data ]] ||
  die "isolated PostgreSQL volume metadata is unsafe; project retained: ${rehearsal_project}"

"${rehearsal_compose[@]}" create --no-build --pull never postgres ||
  die "could not create the isolated PostgreSQL container; project retained: ${rehearsal_project}"
postgres_container=$("${rehearsal_compose[@]}" ps --all --quiet postgres) ||
  die "could not resolve isolated PostgreSQL container; project retained: ${rehearsal_project}"
[[ "${postgres_container}" =~ ^[0-9a-f]{12,64}$ ]] ||
  die "isolated PostgreSQL container identity is ambiguous; project retained: ${rehearsal_project}"
postgres_state=$(docker_rehearsal inspect --format '{{.State.Status}}' "${postgres_container}") ||
  die "could not inspect isolated PostgreSQL container state; project retained: ${rehearsal_project}"
[[ "${postgres_state}" == created ]] ||
  die "isolated PostgreSQL container started before its mount was checked; project retained: ${rehearsal_project}"
postgres_data_mount=$(docker_rehearsal inspect \
  --format '{{ range .Mounts }}{{ if eq .Destination "/var/lib/postgresql/data" }}{{ printf "%s|%s|%s|%t" .Destination .Type .Name .RW }}{{ "\n" }}{{ end }}{{ end }}' \
  "${postgres_container}") ||
  die "could not inspect isolated PostgreSQL mounts; project retained: ${rehearsal_project}"
[[ "${postgres_data_mount}" == "/var/lib/postgresql/data|volume|${postgres_volume}|true" ]] ||
  die "isolated PostgreSQL is not using the expected fresh named volume; project retained: ${rehearsal_project}"
docker_rehearsal start "${postgres_container}" >/dev/null ||
  die "could not start the isolated PostgreSQL container; project retained: ${rehearsal_project}"
postgres_healthy=false
for ((health_attempt = 0; health_attempt < 90; health_attempt += 1)); do
  postgres_health=$(docker_rehearsal inspect \
    --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "${postgres_container}") ||
    die "could not inspect isolated PostgreSQL health; project retained: ${rehearsal_project}"
  if [[ "${postgres_health}" == 'running|healthy' ]]; then
    postgres_healthy=true
    break
  fi
  [[ "${postgres_health}" != exited\|* && "${postgres_health}" != dead\|* ]] ||
    die "isolated PostgreSQL exited before becoming healthy; project retained: ${rehearsal_project}"
  sleep 2
done
[[ "${postgres_healthy}" == true ]] ||
  die "isolated PostgreSQL did not become healthy; project retained: ${rehearsal_project}"

rehearsal_files_parent="${SOURCE_CHECKSUM_PARENT}/restore-rehearsals"
rehearsal_files_root="${rehearsal_files_parent}/${rehearsal_project}/application-files"
[[ ! -e "${rehearsal_files_root}" && ! -L "${rehearsal_files_root}" ]] ||
  die "isolated application-file root already exists; refuse to overwrite: ${rehearsal_files_root}"
install -d -m 0700 "${rehearsal_files_parent}/${rehearsal_project}" ||
  die "could not create isolated application-file parent; project retained: ${rehearsal_project}"
mkdir -m 0700 "${rehearsal_files_root}" ||
  die "could not create isolated application-file root; project retained: ${rehearsal_project}"
sudo -- tar --extract --gzip --numeric-owner --acls --xattrs \
  --file="${BUNDLE}/application-files.tar.gz" --directory="${rehearsal_files_root}" ||
  die "application-file extraction failed; project retained: ${rehearsal_project}"
for application_root in evidence media ctrip-runtime; do
  [[ -d "${rehearsal_files_root}/${application_root}" &&
    ! -L "${rehearsal_files_root}/${application_root}" ]] ||
    die "extracted application-file root is missing or unsafe; project retained: ${rehearsal_project}"
done
application_entries=0
for application_entry in "${rehearsal_files_root}"/*; do
  [[ -e "${application_entry}" || -L "${application_entry}" ]] || continue
  ((application_entries += 1))
done
[[ "${application_entries}" == 3 ]] ||
  die "extracted application-file top-level shape is unexpected; project retained: ${rehearsal_project}"
"${rehearsal_compose[@]}" --profile restore-tools run --no-deps -T db-restore-roles ||
  die "restore role preparation failed; project retained: ${rehearsal_project}"

"${rehearsal_compose[@]}" exec -T postgres sh -lc \
  'umask 077; cat > /tmp/geo-saas-restore.dump' <"${BUNDLE}/postgres.dump" ||
  die "could not stage dump in isolated PostgreSQL; project retained: ${rehearsal_project}"
"${rehearsal_compose[@]}" exec -T postgres sh -lc \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore \
    --host=127.0.0.1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
    --no-owner --no-acl --exit-on-error /tmp/geo-saas-restore.dump' ||
  die "database restore failed; project retained: ${rehearsal_project}"
"${rehearsal_compose[@]}" exec -T postgres rm -f /tmp/geo-saas-restore.dump ||
  die "staged dump cleanup failed; project retained: ${rehearsal_project}"

"${rehearsal_compose[@]}" run --no-deps -T db-migrate ||
  die "post-restore migration failed; project retained: ${rehearsal_project}"
"${rehearsal_compose[@]}" run --no-deps -T db-bootstrap ||
  die "post-restore role/ACL bootstrap failed; project retained: ${rehearsal_project}"

temporary_root=${TMPDIR:-/tmp}
expected_migrations=$(mktemp "${temporary_root%/}/geo-expected-migrations.XXXXXX") ||
  die "could not allocate migration verification state; project retained: ${rehearsal_project}"
actual_migrations=$(mktemp "${temporary_root%/}/geo-actual-migrations.XXXXXX") || {
  rm -f -- "${expected_migrations}"
  die "could not allocate migration verification state; project retained: ${rehearsal_project}"
}
cleanup() {
  rm -f -- "${expected_migrations}" "${actual_migrations}"
  cleanup_verified_snapshot
}
trap cleanup EXIT

for migration_path in "${RELEASE_ROOT}"/packages/db/migrations/[0-9][0-9][0-9][0-9]_*.sql; do
  [[ -f "${migration_path}" && ! -L "${migration_path}" ]] ||
    die "migration file is missing or unsafe; project retained: ${rehearsal_project}"
  migration_name=$(basename -- "${migration_path}")
  printf '%s\n' "${migration_name%.sql}"
done | LC_ALL=C sort >"${expected_migrations}"
[[ -s "${expected_migrations}" ]] ||
  die "release has no migrations; project retained: ${rehearsal_project}"

"${rehearsal_compose[@]}" exec -T postgres sh -lc \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql --no-psqlrc --tuples-only --no-align \
    --host=127.0.0.1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
    --command="SELECT name FROM geo.kysely_migration ORDER BY name"' \
  >"${actual_migrations}" ||
  die "could not read restored migration inventory; project retained: ${rehearsal_project}"
cmp --silent -- "${expected_migrations}" "${actual_migrations}" ||
  die "restored migration inventory differs from the release; project retained: ${rehearsal_project}"

"${rehearsal_compose[@]}" exec -T postgres sh -lc \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql --no-psqlrc \
    --host=127.0.0.1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
    --set=ON_ERROR_STOP=1 --set=api_user="$1" --set=worker_user="$2" \
    --set=identity_user="$3"' \
  restore-rehearsal "${api_user}" "${worker_user}" "${identity_user}" \
  <"${RELEASE_ROOT}/docs/ops/postgres/verify-restore-rehearsal.sql" ||
  die "ACL/RLS/tenant isolation verification failed; project retained: ${rehearsal_project}"

"${rehearsal_compose[@]}" stop postgres ||
  die "verification passed but isolated PostgreSQL could not be stopped: ${rehearsal_project}"

if [[ -z "${report}" ]]; then
  report_directory="${SOURCE_CHECKSUM_PARENT}/restore-rehearsals"
  install -d -m 0700 "${report_directory}" ||
    die "verification passed but report directory could not be created: ${rehearsal_project}"
  report="${report_directory}/${BACKUP_ID}-$(date -u +%Y%m%dT%H%M%SZ).txt"
else
  report_directory=$(dirname -- "${report}")
  [[ -d "${report_directory}" && ! -L "${report_directory}" ]] ||
    die "verification passed but report parent is missing or unsafe: ${rehearsal_project}"
fi
[[ ! -e "${report}" && ! -L "${report}" ]] ||
  die "verification passed but report path already exists: ${rehearsal_project}"
report_stage=$(mktemp "${report}.partial.XXXXXX") ||
  die "verification passed but report could not be staged: ${rehearsal_project}"
checksum_file_sha=$(sha256sum -- "${CHECKSUM_FILE}") ||
  die "verification passed but checksum evidence could not be hashed: ${rehearsal_project}"
checksum_file_sha=${checksum_file_sha%% *}
verified_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
{
  printf 'rehearsal_version=1\n'
  printf 'backup_id=%s\n' "${BACKUP_ID}"
  printf 'verified_utc=%s\n' "${verified_utc}"
  printf 'release=%s\n' "${RELEASE_REVISION}"
  printf 'source_compose_project=%s\n' "${source_project}"
  printf 'rehearsal_compose_project=%s\n' "${rehearsal_project}"
  printf 'postgres_volume=%s\n' "${postgres_volume}"
  printf 'out_of_band_checksum_sha256=%s\n' "${checksum_file_sha}"
  printf 'database_restore=passed\n'
  printf 'application_files_restore=passed\n'
  printf 'application_files_root=%s\n' "${rehearsal_files_root}"
  printf 'caddy_state_recovery=excluded_reissue_required\n'
  printf 'migration_inventory=passed\n'
  printf 'role_acl_verification=passed\n'
  printf 'rls_cross_tenant_denial=passed\n'
  printf 'rehearsal_postgres=stopped\n'
  printf 'isolated_resources=retained_for_review\n'
} >"${report_stage}"
chmod 0600 "${report_stage}"
mv -- "${report_stage}" "${report}"

printf 'Restore rehearsal passed; isolated resources are stopped and retained for review.\n'
printf 'Caddy ACME state was not restored; production recovery still requires reissuance and external HTTPS verification.\n'
printf 'Rehearsal project: %s\n' "${rehearsal_project}"
printf 'Report: %s\n' "${report}"
