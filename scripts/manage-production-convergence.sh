#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

readonly PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly LOCAL_DOCKER_HOST=unix:///var/run/docker.sock
readonly SECRET_ROOT=/srv/geo-saas/secrets
readonly ENV_FILE="${GEO_ENV_FILE:-${SECRET_ROOT}/geo.env}"
readonly DEPLOYMENT_LOCK_FILE=${SECRET_ROOT}/.geo-deployment.lock
readonly ATTESTATION_FILE=${SECRET_ROOT}/.geo-production-convergence.attestation
readonly RESTORE_INHIBIT_MARKER=${SECRET_ROOT}/.geo-restore-inhibit
readonly RESTORE_CLEARANCE_GATE=${SECRET_ROOT}/.geo-restore-inhibit-clearance
readonly RESTORE_INHIBIT_SCHEMA=geo.production-restore-inhibit.v1
readonly CURRENT_LINK=/srv/geo-saas/app/current
readonly APPROVED_CADDY_IMAGE=public.ecr.aws/docker/library/caddy@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d
readonly RECOVERY_TIMEOUT_SECONDS=300
readonly VERIFICATION_TIMEOUT_SECONDS=420
readonly ATTESTATION_TIMEOUT_SECONDS=420
readonly ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly CURRENT_UID="$(id -u)"
readonly CURRENT_GID="$(id -g)"
readonly action=${1:-}
readonly one_shot_services=(config-preflight db-migrate db-bootstrap)
readonly long_running_services=(postgres plastic-promise-host-proxy plastic-promise-proxy browser-host api worker agent-mcp ctrip-bridge web edge)
readonly production_networks=(backend browser-control browser-egress browser-vnc bridge-api frontend governance-host)
readonly release_static_bind_sources=(
  deploy/caddy/Caddyfile
  docs/ops/postgres/bootstrap-login-roles.sh
  docs/ops/postgres/ensure-application-roles.sql
  docs/ops/postgres/reconcile-application-acls.sql
)
readonly attestation_fields=(ROLE CONFIG_HASH IMAGE_REF IMAGE_ID OCI_REVISION CONTAINER_ID NETWORK_MODE NETWORK_ATTACHMENTS_SHA256 ATTESTED_STATE ATTESTED_HEALTH ATTESTED_EXIT_CODE)
readonly network_attestation_fields=(NAME ID INTERNAL IPAM_SHA256)

die() {
  printf 'Production convergence management failed: %s\n' "$1" >&2
  exit 1
}

usage() {
  printf 'Usage: manage-production-convergence.sh invalidate|attest|verify|resume-existing\n' >&2
  exit 64
}

case "${action}" in
  invalidate|attest|verify|resume-existing) ;;
  *) usage ;;
esac
((EUID != 0)) || die 'run convergence management as the non-root deploy user'
[[ "$(uname -s)" == Linux ]] || die 'production convergence management runs only on Linux'
for command_name in cmp date docker flock grep jq od realpath sha256sum sort stat sync tail timeout tr; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command is unavailable: ${command_name}"
done

lock_identity() {
  stat -c '%d:%i:%u:%h:%a' -- "$1"
}

fd_identity() {
  stat -Lc '%d:%i:%u:%h:%a' -- "/proc/self/fd/$1"
}

acquire_deployment_lock() {
  local lock_fd

  [[ -d "${SECRET_ROOT}" && ! -L "${SECRET_ROOT}" ]] || die 'production secret root is missing or unsafe'
  [[ "$(stat -c '%u:%a' -- "${SECRET_ROOT}")" == "${CURRENT_UID}:700" ]] ||
    die 'production secret root must be deploy-owned with mode 700'
  if [[ -e "${DEPLOYMENT_LOCK_FILE}" || -L "${DEPLOYMENT_LOCK_FILE}" ]]; then
    [[ -f "${DEPLOYMENT_LOCK_FILE}" && ! -L "${DEPLOYMENT_LOCK_FILE}" ]] ||
      die 'deployment lock is not a regular non-symlink file'
    [[ "$(stat -c '%u:%a:%h' -- "${DEPLOYMENT_LOCK_FILE}")" == "${CURRENT_UID}:600:1" ]] ||
      die 'deployment lock must be deploy-owned, mode 600, with one link'
  fi

  if [[ -n "${GEO_DEPLOYMENT_LOCK_FD:-}" ]]; then
    [[ "${GEO_DEPLOYMENT_LOCK_FD}" =~ ^[3-9][0-9]?$ ]] || die 'inherited deployment lock fd is invalid'
    lock_fd=${GEO_DEPLOYMENT_LOCK_FD}
    [[ -e "/proc/self/fd/${lock_fd}" ]] || die 'inherited deployment lock fd is closed'
    [[ "$(fd_identity "${lock_fd}")" == "$(lock_identity "${DEPLOYMENT_LOCK_FILE}")" ]] ||
      die 'inherited deployment lock fd is not bound to the checked path'
  else
    exec 9>>"${DEPLOYMENT_LOCK_FILE}"
    chmod 0600 "${DEPLOYMENT_LOCK_FILE}"
    lock_fd=9
    [[ -f "${DEPLOYMENT_LOCK_FILE}" && ! -L "${DEPLOYMENT_LOCK_FILE}" ]] ||
      die 'deployment lock changed to an unsafe path while it was opened'
    [[ "$(stat -c '%u:%a:%h' -- "${DEPLOYMENT_LOCK_FILE}")" == "${CURRENT_UID}:600:1" ]] ||
      die 'deployment lock changed owner, mode, or link count while it was opened'
    [[ "$(fd_identity "${lock_fd}")" == "$(lock_identity "${DEPLOYMENT_LOCK_FILE}")" ]] ||
      die 'deployment lock fd is not bound to the checked path'
  fi
  flock --nonblock "${lock_fd}" || die 'another production deployment operation is already running'
}

validate_attestation_path_if_present() {
  [[ -e "${ATTESTATION_FILE}" || -L "${ATTESTATION_FILE}" ]] || return 0
  [[ -f "${ATTESTATION_FILE}" && ! -L "${ATTESTATION_FILE}" ]] ||
    die 'convergence attestation is not a regular non-symlink file'
  [[ "$(stat -c '%u:%a:%h' -- "${ATTESTATION_FILE}")" == "${CURRENT_UID}:600:1" ]] ||
    die 'convergence attestation must be deploy-owned, mode 600, with one link'
}

validate_restore_inhibit_file() {
  local path=$1
  local label=$2
  local marker_fd=''
  local path_identity
  local fd_file_identity
  local created_at
  local -a lines=()

  [[ -f "${path}" && ! -L "${path}" ]] || die "${label} is unsafe"
  [[ "$(stat -c '%u:%g:%h:%a' -- "${path}")" == "${CURRENT_UID}:${CURRENT_GID}:1:600" ]] ||
    die "${label} must be deploy-owned, mode 600, and single-linked"
  [[ "$(stat -c '%s' -- "${path}")" -le 512 ]] || die "${label} is unexpectedly large"
  [[ -s "${path}" && "$(tail -c 1 -- "${path}" | od -An -t x1 | tr -d '[:space:]')" == 0a ]] ||
    die "${label} must be non-empty and newline-terminated"
  if grep -avEq '^[ -~]*$' -- "${path}"; then
    die "${label} contains a non-printable byte"
  fi

  exec {marker_fd}<"${path}"
  path_identity="$(stat -c '%d:%i:%u:%g:%h:%a' -- "${path}")" ||
    die "could not inspect ${label} path"
  fd_file_identity="$(stat -Lc '%d:%i:%u:%g:%h:%a' -- "/proc/self/fd/${marker_fd}")" ||
    die "could not inspect ${label} descriptor"
  [[ "${path_identity}" == "${fd_file_identity}" ]] || die "${label} changed while it was opened"
  mapfile -t lines <"/proc/self/fd/${marker_fd}"
  exec {marker_fd}<&-

  [[ "${#lines[@]}" == 6 ]] || die "${label} has an invalid field count"
  [[ "${lines[0]}" == "schema=${RESTORE_INHIBIT_SCHEMA}" ]] || die "${label} schema is invalid"
  [[ "${lines[1]}" == state=active ]] || die "${label} state is invalid"
  [[ "${lines[2]}" =~ ^created_at_utc=([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)$ ]] ||
    die "${label} timestamp is invalid"
  created_at=${BASH_REMATCH[1]}
  [[ "${lines[3]}" == "created_by_uid=${CURRENT_UID}" ]] || die "${label} creator is invalid"
  [[ "${lines[4]}" =~ ^pre_restore_backup_id=[0-9]{8}T[0-9]{6}Z-pre-restore$ ]] ||
    die "${label} backup ID is invalid"
  [[ "${lines[5]}" =~ ^pre_restore_checksum_sha256=[0-9a-f]{64}$ ]] ||
    die "${label} checksum binding is invalid"
  [[ "$(date --utc --date="${created_at}" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" == "${created_at}" ]] ||
    die "${label} timestamp is not a real UTC time"
}

acquire_deployment_lock
validate_attestation_path_if_present
case "${GEO_RESTORE_RECOVERY:-0}" in
  0|1) ;;
  *) die 'GEO_RESTORE_RECOVERY must be 0 or 1' ;;
esac
restore_inhibit_present=false
if [[ -e "${RESTORE_INHIBIT_MARKER}" || -L "${RESTORE_INHIBIT_MARKER}" ]]; then
  restore_inhibit_present=true
  validate_restore_inhibit_file "${RESTORE_INHIBIT_MARKER}" 'persistent incident-restore marker'
fi
restore_clearance_present=false
if [[ -e "${RESTORE_CLEARANCE_GATE}" || -L "${RESTORE_CLEARANCE_GATE}" ]]; then
  restore_clearance_present=true
  validate_restore_inhibit_file "${RESTORE_CLEARANCE_GATE}" 'restore clearance transaction gate'
fi
if [[ "${restore_inhibit_present}" == true && "${restore_clearance_present}" == true ]]; then
  cmp --silent -- "${RESTORE_INHIBIT_MARKER}" "${RESTORE_CLEARANCE_GATE}" ||
    die 'restore clearance transaction gate does not match the persistent incident-restore marker'
fi
if [[ "${action}" == resume-existing &&
  ("${restore_inhibit_present}" == true || "${restore_clearance_present}" == true) ]]; then
  die 'local-only resume is inhibited until the restore marker and clearance transaction gate are absent'
fi
if [[ "${action}" == invalidate || "${action}" == attest ]]; then
  if [[ "${restore_clearance_present}" == true ]]; then
    die 'deployment mutation is inhibited while restore clearance transaction is active'
  elif [[ "${restore_inhibit_present}" == true ]]; then
    [[ "${GEO_RESTORE_RECOVERY:-0}" == 1 ]] ||
      die 'deployment mutation under restore inhibit requires explicit restore-recovery authorization'
  else
    [[ "${GEO_RESTORE_RECOVERY:-0}" == 0 ]] ||
      die 'explicit restore-recovery authorization requires the persistent restore marker'
  fi
fi

case "${action}" in
  resume-existing) readonly operation_timeout_seconds=${RECOVERY_TIMEOUT_SECONDS} ;;
  verify) readonly operation_timeout_seconds=${VERIFICATION_TIMEOUT_SECONDS} ;;
  attest) readonly operation_timeout_seconds=${ATTESTATION_TIMEOUT_SECONDS} ;;
  invalidate) readonly operation_timeout_seconds=0 ;;
esac
if ((operation_timeout_seconds > 0)); then
  readonly operation_deadline=$((SECONDS + operation_timeout_seconds))
else
  readonly operation_deadline=0
fi

remaining_operation_seconds() {
  local remaining=$((operation_deadline - SECONDS))
  ((operation_timeout_seconds > 0)) || die 'operation deadline requested for an unbounded action'
  ((remaining > 0)) || die "global ${operation_timeout_seconds}s ${action} deadline expired"
  printf '%s' "${remaining}"
}

remaining_recovery_seconds() {
  [[ "${action}" == resume-existing ]] || die 'recovery deadline requested outside local resume'
  remaining_operation_seconds
}

if [[ "${action}" == invalidate ]]; then
  rm -f -- "${ATTESTATION_FILE}"
  sync -f "${SECRET_ROOT}" || die 'could not durably invalidate the convergence attestation'
  printf 'Production convergence attestation invalidated before deployment mutation.\n'
  exit 0
fi

[[ -L "${CURRENT_LINK}" && -d "${CURRENT_LINK}" ]] || die 'current release link is missing or unsafe'
[[ "$(realpath -e -- "${CURRENT_LINK}")" == "${ROOT_DIR}" ]] ||
  die 'convergence management must run from the active immutable release'
readonly RELEASE_MARKER=${ROOT_DIR}/.geo-release
[[ -f "${RELEASE_MARKER}" && ! -L "${RELEASE_MARKER}" ]] || die 'immutable release marker is missing or unsafe'
[[ "$(stat -c '%u:%a:%h:%s' -- "${RELEASE_MARKER}")" == "${CURRENT_UID}:444:1:41" ]] ||
  die 'immutable release marker owner, mode, link count, or size is invalid'
IFS= read -r RELEASE_REVISION <"${RELEASE_MARKER}"
readonly RELEASE_REVISION
[[ "${RELEASE_REVISION}" =~ ^[0-9a-f]{40}$ ]] || die 'immutable release marker is invalid'

[[ -f "${ENV_FILE}" && ! -L "${ENV_FILE}" ]] || die 'production env file is missing or unsafe'
readonly RESOLVED_ENV_FILE="$(realpath -e -- "${ENV_FILE}")"
[[ "${RESOLVED_ENV_FILE}" == "${SECRET_ROOT}/"* ]] || die 'production env file must be inside the secret root'
[[ "$(stat -c '%u:%a:%h' -- "${RESOLVED_ENV_FILE}")" == "${CURRENT_UID}:600:1" ]] ||
  die 'production env file must be deploy-owned, mode 600, with one link'
[[ ! -s "${RESOLVED_ENV_FILE}" ||
  "$(tail -c 1 -- "${RESOLVED_ENV_FILE}" | od -An -t x1 | tr -d '[:space:]')" == 0a ]] ||
  die 'production env file must end with a newline'
declare -A env_keys=()
env_line_number=0
while IFS= read -r env_line || [[ -n "${env_line}" ]]; do
  ((env_line_number += 1))
  [[ "${env_line}" != *$'\r'* ]] || die "production env line ${env_line_number} contains CR"
  [[ -z "${env_line}" || "${env_line}" == \#* ]] && continue
  [[ "${env_line}" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] ||
    die "production env line ${env_line_number} must be KEY=value"
  env_key=${BASH_REMATCH[1]}
  [[ -z "${env_keys[${env_key}]+present}" ]] || die "production env duplicates ${env_key}"
  env_keys["${env_key}"]=1
done <"${RESOLVED_ENV_FILE}"
readonly GEO_ENV_SHA256="$(sha256sum -- "${RESOLVED_ENV_FILE}" | awk '{print $1}')"
[[ "${GEO_ENV_SHA256}" =~ ^[0-9a-f]{64}$ ]] || die 'could not hash the production env file'

[[ -f "${ROOT_DIR}/compose.yaml" && ! -L "${ROOT_DIR}/compose.yaml" &&
  -f "${ROOT_DIR}/compose.production.yaml" && ! -L "${ROOT_DIR}/compose.production.yaml" ]] ||
  die 'production Compose files are missing or unsafe'
[[ -d "${ROOT_DIR}/packages/db/migrations" && ! -L "${ROOT_DIR}/packages/db/migrations" ]] ||
  die 'release migration directory is missing or unsafe'
readonly DEPLOY_HOME="$(getent passwd "${CURRENT_UID}" | cut -d: -f6)"
[[ -d "${DEPLOY_HOME}" ]] || die 'deploy user home directory is unavailable'
[[ -S /var/run/docker.sock ]] || die 'the local Docker socket is unavailable'

docker_local() {
  local remaining
  local command_timeout
  if ((operation_timeout_seconds > 0)); then
    remaining="$(remaining_operation_seconds)"
    command_timeout=${remaining}
    ((command_timeout <= 90)) || command_timeout=90
    timeout --signal=TERM --kill-after=5s "${command_timeout}s" \
      env -i HOME="${DEPLOY_HOME}" PATH="${PATH}" DOCKER_HOST="${LOCAL_DOCKER_HOST}" \
        COMPOSE_DISABLE_ENV_FILE=1 docker "$@"
  else
    env -i HOME="${DEPLOY_HOME}" PATH="${PATH}" DOCKER_HOST="${LOCAL_DOCKER_HOST}" \
      COMPOSE_DISABLE_ENV_FILE=1 docker "$@"
  fi
}

docker_local info >/dev/null 2>&1 || die 'the deploy user cannot access the local Docker daemon'
docker_local compose version >/dev/null 2>&1 || die 'the Docker Compose v2 plugin is unavailable'
compose=(docker_local compose --project-directory "${ROOT_DIR}" --env-file "${RESOLVED_ENV_FILE}" \
  -f "${ROOT_DIR}/compose.yaml" -f "${ROOT_DIR}/compose.production.yaml" --profile production)
"${compose[@]}" config --quiet || die 'production Compose configuration is invalid'
compose_environment="$("${compose[@]}" config --environment)" || die 'could not resolve Compose environment'

compose_value() {
  local name=$1
  local value=''
  local matches=0
  local line
  while IFS= read -r line; do
    if [[ "${line}" == "${name}="* ]]; then
      value=${line#*=}
      ((matches += 1))
    fi
  done <<<"${compose_environment}"
  [[ "${matches}" == 1 ]] || die "Compose must resolve ${name} exactly once"
  printf '%s' "${value}"
}

readonly IMAGE_TAG="$(compose_value GEO_IMAGE_TAG)"
readonly IMAGE_REVISION="$(compose_value GEO_IMAGE_REVISION)"
readonly COMPOSE_PROJECT="$(compose_value COMPOSE_PROJECT_NAME)"
readonly PUBLIC_DOMAIN="$(compose_value GEO_PUBLIC_DOMAIN)"
readonly CADDY_IMAGE="$(compose_value CADDY_IMAGE)"
unset compose_environment
[[ "${IMAGE_TAG}" == "${RELEASE_REVISION}" && "${IMAGE_REVISION}" == "${RELEASE_REVISION}" ]] ||
  die 'production image tag/revision drifted from the immutable release'
[[ "${COMPOSE_PROJECT}" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || die 'Compose project name is invalid'
[[ "${PUBLIC_DOMAIN}" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ &&
  "${PUBLIC_DOMAIN}" != *..* ]] || die 'production public domain is invalid'
[[ "${CADDY_IMAGE}" == "${APPROVED_CADDY_IMAGE}" ]] ||
  die 'CADDY_IMAGE drifted from the release-approved digest'

COMPOSE_GRAPH_JSON=''
CURRENT_COMPOSE_GRAPH_SHA256=''
CURRENT_RELEASE_STATIC_BIND_COUNT=0
CURRENT_RELEASE_STATIC_BIND_MANIFEST_SHA256=''
declare -A EXPECTED_NETWORK_NAME=()
declare -A EXPECTED_NETWORK_INTERNAL=()

refresh_release_topology() {
  local graph_json
  local graph_networks
  local expected_networks
  local static_bind_paths
  local expected_static_bind_paths
  local manifest=''
  local network
  local model_name
  local model_internal
  local expected_internal
  local path
  local relative
  local before_identity
  local after_identity
  local mode
  local digest
  local static_bind_count=0

  graph_json="$("${compose[@]}" config --format json | jq --compact-output --sort-keys '.')" ||
    die 'could not render and canonicalize the production Compose graph'
  [[ -n "${graph_json}" ]] || die 'canonical production Compose graph is empty'
  printf '%s' "${graph_json}" | jq --exit-status 'type == "object"' >/dev/null ||
    die 'canonical production Compose graph is not one JSON object'
  CURRENT_COMPOSE_GRAPH_SHA256="$(printf '%s' "${graph_json}" | sha256sum | awk '{print $1}')"
  [[ "${CURRENT_COMPOSE_GRAPH_SHA256}" =~ ^[0-9a-f]{64}$ ]] ||
    die 'could not hash the canonical production Compose graph'

  graph_networks="$(printf '%s' "${graph_json}" | jq --raw-output '.networks | keys[]' | sort)" ||
    die 'could not enumerate canonical production networks'
  expected_networks="$(printf '%s\n' "${production_networks[@]}" | sort)"
  [[ "${graph_networks}" == "${expected_networks}" ]] ||
    die 'canonical production network set differs from the enforced topology'

  EXPECTED_NETWORK_NAME=()
  EXPECTED_NETWORK_INTERNAL=()
  for network in "${production_networks[@]}"; do
    model_name="$(printf '%s' "${graph_json}" | jq --raw-output --arg network "${network}" \
      '.networks[$network].name // empty')" || die "could not resolve Compose network name for ${network}"
    [[ "${model_name}" =~ ^[0-9A-Za-z][0-9A-Za-z_.-]{0,127}$ ]] ||
      die "canonical Compose network name is invalid for ${network}"
    model_internal="$(printf '%s' "${graph_json}" | jq --raw-output --arg network "${network}" \
      '.networks[$network].internal // false')" ||
      die "could not resolve Compose internal policy for ${network}"
    case "${network}" in
      backend|bridge-api|browser-control|browser-vnc|governance-host) expected_internal=true ;;
      browser-egress|frontend) expected_internal=false ;;
      *) die "unhandled production network policy: ${network}" ;;
    esac
    [[ "${model_internal}" == "${expected_internal}" ]] ||
      die "canonical Compose internal policy drifted for ${network}"
    case "${network}" in
      backend)
        printf '%s' "${graph_json}" | jq --exit-status --arg network "${network}" '
          (.networks[$network].ipam.config // []) as $config |
          ($config | length) == 1 and
          $config[0].subnet == "172.30.10.0/24" and
          $config[0].gateway == "172.30.10.1"
        ' >/dev/null || die 'canonical backend IPAM drifted from the production subnet'
        ;;
      governance-host)
        printf '%s' "${graph_json}" | jq --exit-status --arg network "${network}" '
          (.networks[$network].ipam.config // []) as $config |
          ($config | length) == 1 and
          $config[0].subnet == "172.30.11.0/29" and
          $config[0].gateway == "172.30.11.1"
        ' >/dev/null || die 'canonical governance-host IPAM drifted from the private proxy subnet'
        ;;
      *)
        printf '%s' "${graph_json}" | jq --exit-status --arg network "${network}" \
          '((.networks[$network].ipam.config // []) | length) == 0' >/dev/null ||
          die "unexpected explicit IPAM config for ${network}"
        ;;
    esac
    EXPECTED_NETWORK_NAME["${network}"]=${model_name}
    EXPECTED_NETWORK_INTERNAL["${network}"]=${expected_internal}
  done

  static_bind_paths="$(printf '%s' "${graph_json}" | jq --raw-output --arg root "${ROOT_DIR}/" '
    .services | to_entries[] | .value.volumes[]? |
    select(.type == "bind") | .source |
    select(type == "string" and startswith($root))
  ' | sort -u)" || die 'could not enumerate release-owned static bind sources'
  expected_static_bind_paths="$({
    for relative in "${release_static_bind_sources[@]}"; do
      printf '%s/%s\n' "${ROOT_DIR}" "${relative}"
    done
  })"
  [[ "${static_bind_paths}" == "${expected_static_bind_paths}" ]] ||
    die 'release-owned static bind-source set differs from the enforced manifest'
  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    [[ "${path}" == "${ROOT_DIR}/"* ]] || die 'a static bind source escaped the immutable release'
    relative=${path#"${ROOT_DIR}/"}
    [[ -f "${path}" && ! -L "${path}" ]] || die "release static bind source is missing or unsafe: ${relative}"
    before_identity="$(stat -c '%d:%i:%u:%g:%a:%h:%s' -- "${path}")" ||
      die "could not inspect release static bind source: ${relative}"
    IFS=: read -r _ _ _ _ mode _ _ <<<"${before_identity}"
    [[ "${mode}" =~ ^[0-7]{3,4}$ ]] || die "release static bind-source mode is invalid: ${relative}"
    (( (8#${mode} & 8#022) == 0 )) ||
      die "release static bind source is group- or other-writable: ${relative}"
    digest="$(sha256sum -- "${path}" | awk '{print $1}')"
    [[ "${digest}" =~ ^[0-9a-f]{64}$ ]] || die "could not hash release static bind source: ${relative}"
    after_identity="$(stat -c '%d:%i:%u:%g:%a:%h:%s' -- "${path}")" ||
      die "could not re-inspect release static bind source: ${relative}"
    [[ "${before_identity}" == "${after_identity}" ]] ||
      die "release static bind source changed while it was hashed: ${relative}"
    manifest+="${digest}  ${before_identity}  ${relative}"$'\n'
    ((static_bind_count += 1))
  done <<<"${static_bind_paths}"
  ((static_bind_count == ${#release_static_bind_sources[@]})) ||
    die 'release static bind-source manifest count is invalid'
  CURRENT_RELEASE_STATIC_BIND_COUNT=${static_bind_count}
  CURRENT_RELEASE_STATIC_BIND_MANIFEST_SHA256="$(printf '%s' "${manifest}" | sha256sum | awk '{print $1}')"
  [[ "${CURRENT_RELEASE_STATIC_BIND_MANIFEST_SHA256}" =~ ^[0-9a-f]{64}$ ]] ||
    die 'could not hash the release static bind-source manifest'
  COMPOSE_GRAPH_JSON=${graph_json}
  remaining_operation_seconds >/dev/null
}

declare -A CURRENT_NETWORK_NAME=()
declare -A CURRENT_NETWORK_ID=()
declare -A CURRENT_NETWORK_INTERNAL=()
declare -A CURRENT_NETWORK_IPAM_SHA256=()
NETWORK_STATE_READY=false

inspect_production_networks() {
  local network
  local network_ids
  local network_json
  local actual_id
  local actual_name
  local actual_internal
  local actual_project
  local actual_logical
  local ipam_canonical

  [[ -n "${COMPOSE_GRAPH_JSON}" ]] || die 'canonical Compose graph must be refreshed before network inspection'
  CURRENT_NETWORK_NAME=()
  CURRENT_NETWORK_ID=()
  CURRENT_NETWORK_INTERNAL=()
  CURRENT_NETWORK_IPAM_SHA256=()
  NETWORK_STATE_READY=false
  for network in "${production_networks[@]}"; do
    network_ids="$(docker_local network ls --no-trunc --quiet \
      --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" \
      --filter "label=com.docker.compose.network=${network}")" ||
      die "could not resolve Docker network identity for ${network}"
    [[ "${network_ids}" =~ ^[0-9a-f]{64}$ ]] ||
      die "exactly one full Docker network ID is required for ${network}"
    network_json="$(docker_local network inspect "${network_ids}")" ||
      die "could not inspect Docker network ${network}"
    printf '%s' "${network_json}" | jq --exit-status 'type == "array" and length == 1' >/dev/null ||
      die "Docker returned an ambiguous network inspection for ${network}"
    actual_id="$(printf '%s' "${network_json}" | jq --raw-output '.[0].Id // empty')"
    actual_name="$(printf '%s' "${network_json}" | jq --raw-output '.[0].Name // empty')"
    actual_internal="$(printf '%s' "${network_json}" | jq --raw-output '.[0].Internal')"
    actual_project="$(printf '%s' "${network_json}" | jq --raw-output \
      '.[0].Labels["com.docker.compose.project"] // empty')"
    actual_logical="$(printf '%s' "${network_json}" | jq --raw-output \
      '.[0].Labels["com.docker.compose.network"] // empty')"
    [[ "${actual_id}" == "${network_ids}" && "${actual_name}" == "${EXPECTED_NETWORK_NAME[${network}]}" &&
      "${actual_internal}" == "${EXPECTED_NETWORK_INTERNAL[${network}]}" &&
      "${actual_project}" == "${COMPOSE_PROJECT}" && "${actual_logical}" == "${network}" ]] ||
      die "actual Docker network identity or isolation policy drifted for ${network}"
    case "${network}" in
      backend)
        printf '%s' "${network_json}" | jq --exit-status '
          (.[0].IPAM.Config // []) as $config |
          ($config | length) == 1 and
          $config[0].Subnet == "172.30.10.0/24" and
          $config[0].Gateway == "172.30.10.1"
        ' >/dev/null || die 'actual backend Docker IPAM drifted from the production subnet'
        ;;
      governance-host)
        printf '%s' "${network_json}" | jq --exit-status '
          (.[0].IPAM.Config // []) as $config |
          ($config | length) == 1 and
          $config[0].Subnet == "172.30.11.0/29" and
          $config[0].Gateway == "172.30.11.1"
        ' >/dev/null || die 'actual governance-host Docker IPAM drifted from the private proxy subnet'
        ;;
    esac
    ipam_canonical="$(printf '%s' "${network_json}" | jq --compact-output --sort-keys '.[0].IPAM')" ||
      die "could not canonicalize Docker IPAM for ${network}"
    [[ -n "${ipam_canonical}" && "${ipam_canonical}" != null ]] ||
      die "Docker IPAM is missing for ${network}"
    CURRENT_NETWORK_NAME["${network}"]=${actual_name}
    CURRENT_NETWORK_ID["${network}"]=${actual_id}
    CURRENT_NETWORK_INTERNAL["${network}"]=${actual_internal}
    CURRENT_NETWORK_IPAM_SHA256["${network}"]="$(printf '%s' "${ipam_canonical}" | sha256sum | awk '{print $1}')"
    [[ "${CURRENT_NETWORK_IPAM_SHA256[${network}]}" =~ ^[0-9a-f]{64}$ ]] ||
      die "could not hash Docker IPAM for ${network}"
  done
  NETWORK_STATE_READY=true
  remaining_operation_seconds >/dev/null
}

service_key() {
  local key=${1^^}
  printf '%s' "${key//-/_}"
}

service_role() {
  case "$1" in
    config-preflight|db-migrate|db-bootstrap) printf 'one_shot' ;;
    *) printf 'long_running' ;;
  esac
}

service_requires_release_revision() {
  case "$1" in
    postgres|db-bootstrap|edge) return 1 ;;
    *) return 0 ;;
  esac
}

resolve_service_image_ref() {
  local service=$1
  local resolved
  [[ -n "${COMPOSE_GRAPH_JSON}" ]] ||
    die 'canonical Compose graph must be refreshed before image resolution'
  resolved="$(printf '%s' "${COMPOSE_GRAPH_JSON}" | jq --raw-output --arg service "${service}" \
    '.services[$service].image // empty')" || die "could not resolve Compose image for ${service}"
  [[ -n "${resolved}" && "${resolved}" != *[$'\t\r\n ']* ]] ||
    die "canonical Compose graph must resolve one safe image reference for ${service}"
  printf '%s' "${resolved}"
}

resolve_service_config_hash() {
  local service=$1
  local model_network_mode
  local target_service
  local target_container_id
  local line
  [[ -n "${COMPOSE_GRAPH_JSON}" ]] ||
    die 'canonical Compose graph must be refreshed before config hashing'
  model_network_mode="$(printf '%s' "${COMPOSE_GRAPH_JSON}" | jq --raw-output --arg service "${service}" \
    '.services[$service].network_mode // empty')" ||
    die "could not resolve canonical network mode before hashing ${service}"
  if [[ "${model_network_mode}" == service:* ]]; then
    target_service=${model_network_mode#service:}
    [[ "${target_service}" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] ||
      die "canonical service network target is invalid before hashing ${service}"
    target_container_id="$("${compose[@]}" ps --all --quiet "${target_service}")" ||
      die "could not resolve service network target before hashing ${service}"
    [[ "${target_container_id}" =~ ^[0-9a-f]{64}$ ]] ||
      die "service network target is ambiguous before hashing ${service}"
    line="$(printf 'services:\n  %s:\n    network_mode: container:%s\n' \
      "${service}" "${target_container_id}" | "${compose[@]}" -f - config --hash "${service}")" ||
      die "could not hash resolved shared-network Compose service ${service}"
  else
    line="$("${compose[@]}" config --hash "${service}")" ||
      die "could not hash Compose service ${service}"
  fi
  [[ "${line}" =~ ^${service}[[:space:]]([0-9a-f]{64})$ ]] ||
    die "Compose returned an invalid config hash for ${service}"
  printf '%s' "${BASH_REMATCH[1]}"
}

normalize_oci_revision() {
  local image_id=$1
  local revision
  revision="$(docker_local image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "${image_id}")" || die "could not inspect OCI revision for ${image_id}"
  case "${revision}" in
    ''|'<no value>') revision=absent ;;
  esac
  [[ "${revision}" =~ ^[0-9A-Za-z._:+/-]+$ ]] || die 'an image has an unsafe OCI revision label'
  printf '%s' "${revision}"
}

CURRENT_CONFIG_HASH=''
CURRENT_IMAGE_REF=''
CURRENT_IMAGE_ID=''
CURRENT_OCI_REVISION=''
CURRENT_CONTAINER_ID=''
CURRENT_NETWORK_MODE=''
CURRENT_NETWORK_ATTACHMENTS_SHA256=''
CURRENT_STATE=''
CURRENT_HEALTH=''
CURRENT_EXIT_CODE=''

validate_current_container_network_topology() {
  local service=$1
  local model_network_mode
  local target_service
  local target_container_id
  local model_networks
  local logical_network
  local expected_attachments=''
  local actual_attachments

  [[ "${NETWORK_STATE_READY}" == true ]] || die 'production networks must be inspected before containers'
  model_network_mode="$(printf '%s' "${COMPOSE_GRAPH_JSON}" | jq --raw-output --arg service "${service}" \
    '.services[$service].network_mode // empty')" ||
    die "could not resolve canonical network mode for ${service}"
  case "${model_network_mode}" in
    host)
      [[ "${CURRENT_NETWORK_MODE}" == host ]] || die "host network mode drifted for ${service}"
      ;;
    service:*)
      target_service=${model_network_mode#service:}
      [[ "${target_service}" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] ||
        die "canonical service network target is invalid for ${service}"
      target_container_id="$("${compose[@]}" ps --all --quiet "${target_service}")" ||
        die "could not resolve service network target for ${service}"
      [[ "${target_container_id}" =~ ^[0-9a-f]{64}$ ]] ||
        die "service network target is ambiguous for ${service}"
      [[ "${CURRENT_NETWORK_MODE}" == "container:${target_container_id}" ]] ||
        die "shared service network namespace drifted for ${service}"
      # Docker's HostConfig.NetworkMode is only the requested attachment. When the
      # target container is restarted, a dependent container can retain the old
      # network namespace while still reporting container:<target-id>. Compare the
      # live namespace inodes so a loopback-only dependency cannot appear healthy
      # while it is actually disconnected from its target service.
      local service_pid
      local target_pid
      local service_netns
      local target_netns
      service_pid="$(docker_local inspect --format '{{.State.Pid}}' "${CURRENT_CONTAINER_ID}")" ||
        die "could not inspect live process for ${service}"
      target_pid="$(docker_local inspect --format '{{.State.Pid}}' "${target_container_id}")" ||
        die "could not inspect live process for network target ${target_service}"
      [[ "${service_pid}" =~ ^[1-9][0-9]*$ && "${target_pid}" =~ ^[1-9][0-9]*$ ]] ||
        die "live process identity is invalid for shared network service ${service}"
      service_netns="$(readlink -- "/proc/${service_pid}/ns/net")" ||
        die "could not inspect live network namespace for ${service}"
      target_netns="$(readlink -- "/proc/${target_pid}/ns/net")" ||
        die "could not inspect live network namespace for ${target_service}"
      [[ "${service_netns}" =~ ^net:\[[0-9]+\]$ && "${target_netns}" =~ ^net:\[[0-9]+\]$ ]] ||
        die "live network namespace identity is invalid for ${service}"
      [[ "${service_netns}" == "${target_netns}" ]] ||
        die "live shared service network namespace drifted for ${service}"
      ;;
    '')
      [[ "${CURRENT_NETWORK_MODE}" != host && "${CURRENT_NETWORK_MODE}" != none &&
        "${CURRENT_NETWORK_MODE}" != container:* ]] ||
        die "unexpected special network mode for ${service}"
      model_networks="$(printf '%s' "${COMPOSE_GRAPH_JSON}" | jq --raw-output --arg service "${service}" \
        '(.services[$service].networks // {}) | keys[]' | sort)" ||
        die "could not enumerate canonical network attachments for ${service}"
      [[ -n "${model_networks}" ]] || die "canonical network attachment set is empty for ${service}"
      while IFS= read -r logical_network; do
        [[ -n "${logical_network}" ]] || continue
        [[ -n "${CURRENT_NETWORK_ID[${logical_network}]+present}" ]] ||
          die "service ${service} references an unenforced network: ${logical_network}"
        expected_attachments+="${CURRENT_NETWORK_NAME[${logical_network}]}=${CURRENT_NETWORK_ID[${logical_network}]}"$'\n'
      done <<<"${model_networks}"
      actual_attachments="$(printf '%s' "${CURRENT_NETWORK_ATTACHMENTS_JSON}" | jq --raw-output '
        to_entries | sort_by(.key) | .[] | "\(.key)=\(.value.NetworkID)"
      ')" || die "could not enumerate actual network attachments for ${service}"
      [[ "${actual_attachments}" == "${expected_attachments%$'\n'}" ]] ||
        die "actual Docker network attachment set drifted for ${service}"
      ;;
    *) die "unsupported canonical network mode for ${service}: ${model_network_mode}" ;;
  esac
}

inspect_service_current() {
  local service=$1
  local container_project
  local container_service
  local container_config_hash
  local container_image_id
  local network_attachments_raw

  CURRENT_CONFIG_HASH="$(resolve_service_config_hash "${service}")"
  CURRENT_IMAGE_REF="$(resolve_service_image_ref "${service}")"
  CURRENT_IMAGE_ID="$(docker_local image inspect --format '{{.Id}}' "${CURRENT_IMAGE_REF}" 2>/dev/null)" ||
    die "attested local image is unavailable for ${service}"
  [[ "${CURRENT_IMAGE_ID}" =~ ^sha256:[0-9a-f]{64}$ ]] || die "image ID is invalid for ${service}"
  CURRENT_OCI_REVISION="$(normalize_oci_revision "${CURRENT_IMAGE_ID}")"
  if service_requires_release_revision "${service}"; then
    [[ "${CURRENT_OCI_REVISION}" == "${RELEASE_REVISION}" ]] ||
      die "OCI revision does not match the immutable release for ${service}"
  fi
  CURRENT_CONTAINER_ID="$("${compose[@]}" ps --all --quiet "${service}")" ||
    die "could not resolve the existing container for ${service}"
  [[ "${CURRENT_CONTAINER_ID}" =~ ^[0-9a-f]{64}$ ]] ||
    die "exactly one existing Compose container is required for ${service}"
  container_image_id="$(docker_local inspect --format '{{.Image}}' "${CURRENT_CONTAINER_ID}")" ||
    die "could not inspect the existing container for ${service}"
  container_project="$(docker_local inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' \
    "${CURRENT_CONTAINER_ID}")" || die "could not inspect Compose project label for ${service}"
  container_service="$(docker_local inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' \
    "${CURRENT_CONTAINER_ID}")" || die "could not inspect Compose service label for ${service}"
  container_config_hash="$(docker_local inspect --format '{{ index .Config.Labels "com.docker.compose.config-hash" }}' \
    "${CURRENT_CONTAINER_ID}")" || die "could not inspect Compose config hash for ${service}"
  [[ "${container_image_id}" == "${CURRENT_IMAGE_ID}" && "${container_project}" == "${COMPOSE_PROJECT}" &&
    "${container_service}" == "${service}" && "${container_config_hash}" == "${CURRENT_CONFIG_HASH}" ]] ||
    die "container identity drifted from the current immutable Compose release for ${service}"
  CURRENT_NETWORK_MODE="$(docker_local inspect --format '{{.HostConfig.NetworkMode}}' "${CURRENT_CONTAINER_ID}")" ||
    die "could not inspect network mode for ${service}"
  [[ "${CURRENT_NETWORK_MODE}" =~ ^[0-9A-Za-z._:/+-]+$ ]] ||
    die "container network mode is invalid for ${service}"
  network_attachments_raw="$(docker_local inspect --format '{{json .NetworkSettings.Networks}}' \
    "${CURRENT_CONTAINER_ID}")" || die "could not inspect network attachments for ${service}"
  # Docker clears endpoint details during a normal stop. Network IDs remain stable and bind the
  # container to the attested network objects; Compose's config hash covers attachment settings.
  CURRENT_NETWORK_ATTACHMENTS_JSON="$(printf '%s' "${network_attachments_raw}" | jq --compact-output --sort-keys \
    'if type == "object" then
       with_entries(.value = {"NetworkID": .value.NetworkID})
     else error("network attachments are not an object") end')" ||
    die "could not canonicalize network attachments for ${service}"
  CURRENT_NETWORK_ATTACHMENTS_SHA256="$(printf '%s' "${CURRENT_NETWORK_ATTACHMENTS_JSON}" | \
    sha256sum | awk '{print $1}')"
  [[ "${CURRENT_NETWORK_ATTACHMENTS_SHA256}" =~ ^[0-9a-f]{64}$ ]] ||
    die "could not hash network attachments for ${service}"
  validate_current_container_network_topology "${service}"
  CURRENT_STATE="$(docker_local inspect --format '{{.State.Status}}' "${CURRENT_CONTAINER_ID}")" ||
    die "could not inspect state for ${service}"
  CURRENT_HEALTH="$(docker_local inspect --format \
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "${CURRENT_CONTAINER_ID}")" ||
    die "could not inspect health for ${service}"
  CURRENT_EXIT_CODE="$(docker_local inspect --format '{{.State.ExitCode}}' "${CURRENT_CONTAINER_ID}")" ||
    die "could not inspect exit code for ${service}"
  [[ "${CURRENT_EXIT_CODE}" =~ ^[0-9]+$ ]] || die "container exit code is invalid for ${service}"
}

MIGRATION_COUNT=0
MIGRATION_MANIFEST_SHA256=''
EXPECTED_MIGRATION_NAMES=''
APPLIED_MIGRATIONS_SHA256=''
MIGRATION_SET_SHA256=''

build_release_migration_inventory() {
  local migration_paths=()
  local migration_names=()
  local path
  local base
  local digest

  shopt -s nullglob
  migration_paths=("${ROOT_DIR}"/packages/db/migrations/*.sql)
  shopt -u nullglob
  ((${#migration_paths[@]} > 0)) || die 'release migration set is empty'
  for path in "${migration_paths[@]}"; do
    [[ -f "${path}" && ! -L "${path}" ]] || die "migration is missing or unsafe: ${path}"
    base=${path##*/}
    [[ "${base}" =~ ^[0-9]{4}_[a-z0-9_]+\.sql$ ]] || die "migration filename is invalid: ${base}"
    migration_names+=("${base%.sql}")
  done
  MIGRATION_COUNT=${#migration_paths[@]}
  EXPECTED_MIGRATION_NAMES="$(printf '%s\n' "${migration_names[@]}")"
  MIGRATION_MANIFEST_SHA256="$({
    for path in "${migration_paths[@]}"; do
      base=${path##*/}
      digest="$(sha256sum -- "${path}" | awk '{print $1}')"
      printf '%s  %s\n' "${digest}" "${base}"
    done
  } | sha256sum | awk '{print $1}')"
  [[ "${MIGRATION_MANIFEST_SHA256}" =~ ^[0-9a-f]{64}$ ]] || die 'could not hash the release migration set'
}

query_applied_migrations() {
  local postgres_container_id=$1
  local applied_names
  local applied_name

  applied_names="$(docker_local exec --interactive "${postgres_container_id}" sh -ceu '
    export PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is missing}"
    exec psql --no-psqlrc --host=127.0.0.1 --username="${POSTGRES_USER}" \
      --dbname="${POSTGRES_DB}" --tuples-only --no-align --set=ON_ERROR_STOP=1 \
      --command="SELECT name FROM geo.kysely_migration ORDER BY name"
  ')" || die 'could not read the applied production migration set'
  while IFS= read -r applied_name; do
    [[ "${applied_name}" =~ ^[0-9]{4}_[a-z0-9_]+$ ]] || die 'database returned an invalid migration name'
  done <<<"${applied_names}"
  [[ "${applied_names}" == "${EXPECTED_MIGRATION_NAMES}" ]] ||
    die 'applied production migrations do not exactly match the immutable release'
  APPLIED_MIGRATIONS_SHA256="$(printf '%s\n' "${applied_names}" | sha256sum | awk '{print $1}')"
  MIGRATION_SET_SHA256="$(printf 'manifest=%s\napplied=%s\ncount=%s\n' \
    "${MIGRATION_MANIFEST_SHA256}" "${APPLIED_MIGRATIONS_SHA256}" "${MIGRATION_COUNT}" |
    sha256sum | awk '{print $1}')"
}

declare -A ATTESTATION=()

parse_attestation() {
  local path=$1
  local line
  local line_number=0
  local key
  local value
  local service
  local service_token
  local field
  local network
  local network_token
  declare -A allowed=()

  [[ -f "${path}" && ! -L "${path}" ]] || die 'convergence attestation is missing or unsafe'
  [[ "$(stat -c '%u:%a:%h' -- "${path}")" == "${CURRENT_UID}:600:1" ]] ||
    die 'convergence attestation must be deploy-owned, mode 600, with one link'
  for key in ATTESTATION_VERSION RELEASE_REVISION GEO_ENV_SHA256 COMPOSE_PROJECT PUBLIC_DOMAIN CADDY_IMAGE \
    COMPOSE_GRAPH_SHA256 RELEASE_STATIC_BIND_COUNT RELEASE_STATIC_BIND_MANIFEST_SHA256 \
    MIGRATION_COUNT MIGRATION_MANIFEST_SHA256 APPLIED_MIGRATIONS_SHA256 MIGRATION_SET_SHA256 CREATED_UTC; do
    allowed["${key}"]=1
  done
  for network in "${production_networks[@]}"; do
    network_token="$(service_key "${network}")"
    for field in "${network_attestation_fields[@]}"; do
      allowed["NETWORK_${network_token}_${field}"]=1
    done
  done
  for service in "${one_shot_services[@]}" "${long_running_services[@]}"; do
    service_token="$(service_key "${service}")"
    for field in "${attestation_fields[@]}"; do
      allowed["SERVICE_${service_token}_${field}"]=1
    done
  done
  ATTESTATION=()
  [[ ! -s "${path}" || "$(tail -c 1 -- "${path}" | od -An -t x1 | tr -d '[:space:]')" == 0a ]] ||
    die 'convergence attestation must end with a newline'
  while IFS= read -r line || [[ -n "${line}" ]]; do
    ((line_number += 1))
    [[ "${line}" != *$'\r'* ]] || die "convergence attestation line ${line_number} contains CR"
    [[ "${line}" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] ||
      die "convergence attestation line ${line_number} is malformed"
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    [[ -n "${value}" ]] || die "convergence attestation contains an empty value for ${key}"
    [[ -n "${allowed[${key}]+present}" ]] || die "convergence attestation contains an unknown key: ${key}"
    [[ -z "${ATTESTATION[${key}]+present}" ]] || die "convergence attestation duplicates ${key}"
    ATTESTATION["${key}"]=${value}
  done <"${path}"
  ((${#ATTESTATION[@]} == ${#allowed[@]})) || die 'convergence attestation has missing fields'
  for key in "${!allowed[@]}"; do
    [[ -n "${ATTESTATION[${key}]+present}" ]] || die "convergence attestation is missing ${key}"
  done
}

attestation_value() {
  local service=$1
  local field=$2
  local token
  token="$(service_key "${service}")"
  printf '%s' "${ATTESTATION[SERVICE_${token}_${field}]}"
}

network_attestation_value() {
  local network=$1
  local field=$2
  local token
  token="$(service_key "${network}")"
  printf '%s' "${ATTESTATION[NETWORK_${token}_${field}]}"
}

validate_attestation_metadata() {
  local network

  [[ "${ATTESTATION[ATTESTATION_VERSION]}" == geo.production-convergence.v1 ]] ||
    die 'convergence attestation version is unsupported'
  [[ "${ATTESTATION[RELEASE_REVISION]}" == "${RELEASE_REVISION}" ]] || die 'attested release drifted'
  [[ "${ATTESTATION[GEO_ENV_SHA256]}" == "${GEO_ENV_SHA256}" ]] || die 'attested geo.env hash drifted'
  [[ "${ATTESTATION[COMPOSE_PROJECT]}" == "${COMPOSE_PROJECT}" ]] || die 'attested Compose project drifted'
  [[ "${ATTESTATION[PUBLIC_DOMAIN]}" == "${PUBLIC_DOMAIN}" ]] || die 'attested public domain drifted'
  [[ "${ATTESTATION[CADDY_IMAGE]}" == "${CADDY_IMAGE}" ]] || die 'attested Caddy image drifted'
  [[ "${ATTESTATION[COMPOSE_GRAPH_SHA256]}" == "${CURRENT_COMPOSE_GRAPH_SHA256}" ]] ||
    die 'attested canonical Compose graph drifted'
  [[ "${ATTESTATION[RELEASE_STATIC_BIND_COUNT]}" == "${CURRENT_RELEASE_STATIC_BIND_COUNT}" &&
    "${ATTESTATION[RELEASE_STATIC_BIND_MANIFEST_SHA256]}" == \
      "${CURRENT_RELEASE_STATIC_BIND_MANIFEST_SHA256}" ]] ||
    die 'attested release static bind-source manifest drifted'
  for network in "${production_networks[@]}"; do
    [[ "$(network_attestation_value "${network}" NAME)" == "${CURRENT_NETWORK_NAME[${network}]}" &&
      "$(network_attestation_value "${network}" ID)" == "${CURRENT_NETWORK_ID[${network}]}" &&
      "$(network_attestation_value "${network}" INTERNAL)" == "${CURRENT_NETWORK_INTERNAL[${network}]}" &&
      "$(network_attestation_value "${network}" IPAM_SHA256)" == \
        "${CURRENT_NETWORK_IPAM_SHA256[${network}]}" ]] ||
      die "attested Docker network identity or isolation drifted for ${network}"
  done
  [[ "${ATTESTATION[CREATED_UTC]}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
    die 'convergence attestation timestamp is invalid'
  [[ "${ATTESTATION[MIGRATION_COUNT]}" == "${MIGRATION_COUNT}" ]] || die 'attested migration count drifted'
  [[ "${ATTESTATION[MIGRATION_MANIFEST_SHA256]}" == "${MIGRATION_MANIFEST_SHA256}" ]] ||
    die 'attested release migration manifest drifted'
  [[ "${ATTESTATION[APPLIED_MIGRATIONS_SHA256]}" =~ ^[0-9a-f]{64}$ &&
    "${ATTESTATION[MIGRATION_SET_SHA256]}" =~ ^[0-9a-f]{64}$ ]] ||
    die 'attested migration hashes are invalid'
}

compare_current_service_to_attestation() {
  local service=$1
  local expected_role
  expected_role="$(service_role "${service}")"
  [[ "$(attestation_value "${service}" ROLE)" == "${expected_role}" &&
    "$(attestation_value "${service}" CONFIG_HASH)" == "${CURRENT_CONFIG_HASH}" &&
    "$(attestation_value "${service}" IMAGE_REF)" == "${CURRENT_IMAGE_REF}" &&
    "$(attestation_value "${service}" IMAGE_ID)" == "${CURRENT_IMAGE_ID}" &&
    "$(attestation_value "${service}" OCI_REVISION)" == "${CURRENT_OCI_REVISION}" &&
    "$(attestation_value "${service}" CONTAINER_ID)" == "${CURRENT_CONTAINER_ID}" &&
    "$(attestation_value "${service}" NETWORK_MODE)" == "${CURRENT_NETWORK_MODE}" &&
    "$(attestation_value "${service}" NETWORK_ATTACHMENTS_SHA256)" == \
      "${CURRENT_NETWORK_ATTACHMENTS_SHA256}" ]] ||
    die "live identity drifted from the convergence attestation for ${service}"
}

validate_one_shot_service() {
  local service=$1
  inspect_service_current "${service}"
  compare_current_service_to_attestation "${service}"
  [[ "$(attestation_value "${service}" ATTESTED_STATE)" == exited &&
    "$(attestation_value "${service}" ATTESTED_HEALTH)" == not_applicable &&
    "$(attestation_value "${service}" ATTESTED_EXIT_CODE)" == 0 ]] ||
    die "attestation does not prove a successful one-shot service: ${service}"
  [[ "${CURRENT_STATE}" == exited && "${CURRENT_EXIT_CODE}" == 0 ]] ||
    die "one-shot service is not still exited successfully: ${service}"
}

validate_long_running_identity() {
  local service=$1
  inspect_service_current "${service}"
  compare_current_service_to_attestation "${service}"
  [[ "$(attestation_value "${service}" ATTESTED_STATE)" == running &&
    "$(attestation_value "${service}" ATTESTED_HEALTH)" == healthy &&
    "$(attestation_value "${service}" ATTESTED_EXIT_CODE)" == 0 ]] ||
    die "attestation does not prove a healthy long-running service: ${service}"
}

validate_applied_migration_attestation() {
  local postgres_id
  postgres_id="$(attestation_value postgres CONTAINER_ID)"
  query_applied_migrations "${postgres_id}"
  [[ "${ATTESTATION[APPLIED_MIGRATIONS_SHA256]}" == "${APPLIED_MIGRATIONS_SHA256}" &&
    "${ATTESTATION[MIGRATION_SET_SHA256]}" == "${MIGRATION_SET_SHA256}" ]] ||
    die 'attested applied migration set drifted'
}

write_service_attestation() {
  local output=$1
  local service=$2
  local role=$3
  local token
  local attested_state
  local attested_health
  local attested_exit_code
  token="$(service_key "${service}")"
  inspect_service_current "${service}"
  if [[ "${role}" == one_shot ]]; then
    [[ "${CURRENT_STATE}" == exited && "${CURRENT_EXIT_CODE}" == 0 ]] ||
      die "one-shot service did not exit successfully: ${service}"
    attested_state=exited
    attested_health=not_applicable
    attested_exit_code=0
  else
    [[ "${CURRENT_STATE}" == running && "${CURRENT_HEALTH}" == healthy ]] ||
      die "long-running service is not healthy after Compose convergence: ${service}"
    attested_state=running
    attested_health=healthy
    attested_exit_code=0
  fi
  {
    printf 'SERVICE_%s_ROLE=%s\n' "${token}" "${role}"
    printf 'SERVICE_%s_CONFIG_HASH=%s\n' "${token}" "${CURRENT_CONFIG_HASH}"
    printf 'SERVICE_%s_IMAGE_REF=%s\n' "${token}" "${CURRENT_IMAGE_REF}"
    printf 'SERVICE_%s_IMAGE_ID=%s\n' "${token}" "${CURRENT_IMAGE_ID}"
    printf 'SERVICE_%s_OCI_REVISION=%s\n' "${token}" "${CURRENT_OCI_REVISION}"
    printf 'SERVICE_%s_CONTAINER_ID=%s\n' "${token}" "${CURRENT_CONTAINER_ID}"
    printf 'SERVICE_%s_NETWORK_MODE=%s\n' "${token}" "${CURRENT_NETWORK_MODE}"
    printf 'SERVICE_%s_NETWORK_ATTACHMENTS_SHA256=%s\n' "${token}" \
      "${CURRENT_NETWORK_ATTACHMENTS_SHA256}"
    printf 'SERVICE_%s_ATTESTED_STATE=%s\n' "${token}" "${attested_state}"
    printf 'SERVICE_%s_ATTESTED_HEALTH=%s\n' "${token}" "${attested_health}"
    printf 'SERVICE_%s_ATTESTED_EXIT_CODE=%s\n' "${token}" "${attested_exit_code}"
  } >>"${output}"
}

write_network_attestation() {
  local output=$1
  local network=$2
  local token
  token="$(service_key "${network}")"
  {
    printf 'NETWORK_%s_NAME=%s\n' "${token}" "${CURRENT_NETWORK_NAME[${network}]}"
    printf 'NETWORK_%s_ID=%s\n' "${token}" "${CURRENT_NETWORK_ID[${network}]}"
    printf 'NETWORK_%s_INTERNAL=%s\n' "${token}" "${CURRENT_NETWORK_INTERNAL[${network}]}"
    printf 'NETWORK_%s_IPAM_SHA256=%s\n' "${token}" "${CURRENT_NETWORK_IPAM_SHA256[${network}]}"
  } >>"${output}"
}

verify_healthy_attestation() {
  local path=$1
  refresh_release_topology
  inspect_production_networks
  parse_attestation "${path}"
  build_release_migration_inventory
  validate_attestation_metadata
  for service in "${one_shot_services[@]}"; do
    validate_one_shot_service "${service}"
  done
  for service in "${long_running_services[@]}"; do
    validate_long_running_identity "${service}"
    [[ "${CURRENT_STATE}" == running && "${CURRENT_HEALTH}" == healthy ]] ||
      die "long-running service is not currently healthy: ${service}"
  done
  validate_applied_migration_attestation
}

if [[ "${action}" == attest ]]; then
  refresh_release_topology
  inspect_production_networks
  build_release_migration_inventory
  inspect_service_current postgres
  [[ "${CURRENT_STATE}" == running && "${CURRENT_HEALTH}" == healthy ]] ||
    die 'postgres must be healthy before migration attestation'
  query_applied_migrations "${CURRENT_CONTAINER_ID}"
  attestation_stage="$(mktemp "${SECRET_ROOT}/.geo-production-convergence.attestation.XXXXXX")" ||
    die 'could not create an attestation staging file'
  trap 'rm -f -- "${attestation_stage}"' EXIT
  chmod 0600 "${attestation_stage}"
  {
    printf 'ATTESTATION_VERSION=geo.production-convergence.v1\n'
    printf 'RELEASE_REVISION=%s\n' "${RELEASE_REVISION}"
    printf 'GEO_ENV_SHA256=%s\n' "${GEO_ENV_SHA256}"
    printf 'COMPOSE_PROJECT=%s\n' "${COMPOSE_PROJECT}"
    printf 'PUBLIC_DOMAIN=%s\n' "${PUBLIC_DOMAIN}"
    printf 'CADDY_IMAGE=%s\n' "${CADDY_IMAGE}"
    printf 'COMPOSE_GRAPH_SHA256=%s\n' "${CURRENT_COMPOSE_GRAPH_SHA256}"
    printf 'RELEASE_STATIC_BIND_COUNT=%s\n' "${CURRENT_RELEASE_STATIC_BIND_COUNT}"
    printf 'RELEASE_STATIC_BIND_MANIFEST_SHA256=%s\n' \
      "${CURRENT_RELEASE_STATIC_BIND_MANIFEST_SHA256}"
    printf 'MIGRATION_COUNT=%s\n' "${MIGRATION_COUNT}"
    printf 'MIGRATION_MANIFEST_SHA256=%s\n' "${MIGRATION_MANIFEST_SHA256}"
    printf 'APPLIED_MIGRATIONS_SHA256=%s\n' "${APPLIED_MIGRATIONS_SHA256}"
    printf 'MIGRATION_SET_SHA256=%s\n' "${MIGRATION_SET_SHA256}"
    printf 'CREATED_UTC=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"${attestation_stage}"
  for network in "${production_networks[@]}"; do
    write_network_attestation "${attestation_stage}" "${network}"
  done
  for service in "${one_shot_services[@]}"; do
    write_service_attestation "${attestation_stage}" "${service}" one_shot
  done
  for service in "${long_running_services[@]}"; do
    write_service_attestation "${attestation_stage}" "${service}" long_running
  done
  verify_healthy_attestation "${attestation_stage}"
  sync -d "${attestation_stage}" || die 'could not sync the convergence attestation staging file'
  mv -fT -- "${attestation_stage}" "${ATTESTATION_FILE}" || die 'could not atomically publish convergence attestation'
  trap - EXIT
  sync -f "${SECRET_ROOT}" || die 'could not durably publish the convergence attestation'
  validate_attestation_path_if_present
  printf 'Production convergence attested: release=%s project=%s domain=%s\n' \
    "${RELEASE_REVISION}" "${COMPOSE_PROJECT}" "${PUBLIC_DOMAIN}"
  exit 0
fi

if [[ "${action}" == verify ]]; then
  verify_healthy_attestation "${ATTESTATION_FILE}"
  printf 'Production convergence attestation verified: release=%s project=%s domain=%s\n' \
    "${RELEASE_REVISION}" "${COMPOSE_PROJECT}" "${PUBLIC_DOMAIN}"
  exit 0
fi

refresh_release_topology
inspect_production_networks
build_release_migration_inventory
parse_attestation "${ATTESTATION_FILE}"
validate_attestation_metadata
for service in "${one_shot_services[@]}"; do
  validate_one_shot_service "${service}"
done
# Validate every attested identity before the first start or restart. Missing, recreated,
# retagged, reconfigured, or release-drifted containers are never repaired automatically.
for service in "${long_running_services[@]}"; do
  validate_long_running_identity "${service}"
  case "${CURRENT_STATE}" in
    running|exited|restarting) ;;
    *) die "attested long-running service is in a non-resumable state: ${service} (${CURRENT_STATE})" ;;
  esac
done

docker_before_deadline() {
  docker_local "$@"
}

recover_service() {
  local service=$1
  local container_id
  local recovery_action=wait
  local remaining
  local sleep_seconds

  validate_long_running_identity "${service}"
  container_id="$(attestation_value "${service}" CONTAINER_ID)"
  if [[ "${CURRENT_STATE}" == running && "${CURRENT_HEALTH}" == healthy ]]; then
    return 0
  fi
  case "${CURRENT_STATE}" in
    exited)
      recovery_action=start
      docker_before_deadline start "${container_id}" >/dev/null || die "could not start attested container for ${service}"
      ;;
    running)
      recovery_action=restart
      docker_before_deadline restart "${container_id}" >/dev/null || die "could not restart attested container for ${service}"
      ;;
    restarting) ;;
    *) die "attested container cannot be resumed for ${service}: ${CURRENT_STATE}" ;;
  esac
  while :; do
    remaining="$(remaining_recovery_seconds)"
    sleep_seconds=5
    ((sleep_seconds <= remaining)) || sleep_seconds=${remaining}
    sleep "${sleep_seconds}"
    validate_long_running_identity "${service}"
    if [[ "${CURRENT_STATE}" == running && "${CURRENT_HEALTH}" == healthy ]]; then
      printf 'Recovered attested service with local-only %s: %s\n' "${recovery_action}" "${service}"
      return 0
    fi
    case "${CURRENT_STATE}" in
      running|restarting) ;;
      *) die "attested service exited during bounded recovery: ${service}" ;;
    esac
  done
}

recover_service postgres
validate_applied_migration_attestation
recover_service plastic-promise-host-proxy
recover_service plastic-promise-proxy
recover_service browser-host
recover_service api
recover_service worker
recover_service agent-mcp
recover_service ctrip-bridge
recover_service web
recover_service edge
verify_healthy_attestation "${ATTESTATION_FILE}"
remaining_recovery_seconds >/dev/null
printf 'Local-only production resume passed within the global %ss deadline: release=%s domain=%s\n' \
  "${RECOVERY_TIMEOUT_SECONDS}" "${RELEASE_REVISION}" "${PUBLIC_DOMAIN}"
