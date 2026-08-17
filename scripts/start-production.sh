#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
readonly PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'Production Docker deployment and image builds must run on Linux, never on macOS.\n' >&2
  exit 1
fi

if ((EUID == 0)); then
  printf 'Run production as the non-root deploy user, not with sudo.\n' >&2
  exit 1
fi

readonly ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly ENV_FILE="${GEO_ENV_FILE:-/srv/geo-saas/secrets/geo.env}"
readonly SECRET_ROOT=/srv/geo-saas/secrets
readonly DEPLOYMENT_LOCK_FILE=/srv/geo-saas/secrets/.geo-deployment.lock
readonly DEPLOYMENT_JOURNAL_FILE=/srv/geo-saas/secrets/.geo-deployment-journal
readonly DEPLOYMENT_JOURNAL_STAGE_FILE=/srv/geo-saas/secrets/.geo-deployment-journal.stage
readonly DEPLOYMENT_GEO_STAGE_FILE=/srv/geo-saas/secrets/.geo.env.rollback-stage
readonly DEPLOYMENT_COMMISSIONING_STAGE_FILE=/srv/geo-saas/secrets/.commissioning.env.rollback-stage
readonly DEPLOYMENT_CURRENT_STAGE_FILE=/srv/geo-saas/app/.current.rollback-stage
readonly RESTORE_INHIBIT_MARKER=/srv/geo-saas/secrets/.geo-restore-inhibit
readonly RESTORE_CLEARANCE_GATE=/srv/geo-saas/secrets/.geo-restore-inhibit-clearance
readonly RESTORE_INHIBIT_UNIT=geo-saas-restore-inhibit.service
readonly HEALTH_TIMER=geo-saas-health.timer
readonly BACKUP_TIMER=geo-saas-backup.timer
readonly HEALTH_SERVICE=geo-saas-health.service
readonly BACKUP_SERVICE=geo-saas-backup.service
readonly LOG_ROOT=/srv/geo-saas/logs
readonly WAIT_TIMEOUT_SECONDS="${GEO_COMPOSE_WAIT_TIMEOUT_SECONDS:-300}"
readonly DEPLOYMENT_TIMEOUT_SECONDS="${GEO_DEPLOYMENT_TIMEOUT_SECONDS:-3600}"
readonly DEPLOYMENT_COMMAND_TIMEOUT_SECONDS=1800
readonly BROWSER_APPARMOR_PROFILE=geo-saas-browser-host
readonly BROWSER_APPARMOR_SOURCE="${ROOT_DIR}/deploy/apparmor/${BROWSER_APPARMOR_PROFILE}"
readonly BROWSER_APPARMOR_TARGET="/etc/apparmor.d/${BROWSER_APPARMOR_PROFILE}"
readonly BROWSER_SECCOMP_SOURCE="${ROOT_DIR}/deploy/seccomp/geo-saas-browser-host.json"
readonly BROWSER_VNC_PASSWORD_FILE=/srv/geo-saas/secrets/ctrip-vnc.passwd
readonly LOCAL_DOCKER_HOST=unix:///var/run/docker.sock
readonly APPROVED_CADDY_IMAGE=public.ecr.aws/docker/library/caddy@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d
readonly RELEASE_MARKER="${ROOT_DIR}/.geo-release"
readonly CONVERGENCE_MANAGER="${ROOT_DIR}/scripts/manage-production-convergence.sh"
readonly CURRENT_UID="$(id -u)"

die() {
  printf 'Production startup refused: %s\n' "$1" >&2
  exit 1
}

restore_recovery=false
case "$#" in
  0) ;;
  1)
    [[ "$1" == --restore-recovery ]] ||
      die 'usage: start-production.sh [--restore-recovery]'
    restore_recovery=true
    ;;
  *) die 'usage: start-production.sh [--restore-recovery]' ;;
esac
readonly RESTORE_RECOVERY="${restore_recovery}"

require_inactive_unit() {
  local unit=$1
  local load_state
  local active_state

  load_state="$(systemctl show --property=LoadState --value "${unit}")" ||
    die "could not inspect ${unit}"
  active_state="$(systemctl show --property=ActiveState --value "${unit}")" ||
    die "could not inspect ${unit}"
  [[ "${load_state}" == loaded && "${active_state}" == inactive ]] ||
    die "${unit} must be installed and inactive during restore recovery startup"
}

require_disabled_timer() {
  local timer=$1
  local enabled_state

  require_inactive_unit "${timer}"
  enabled_state="$(systemctl is-enabled "${timer}" 2>/dev/null || :)"
  [[ "${enabled_state}" == disabled ]] ||
    die "${timer} must remain disabled during restore recovery startup"
}

validate_restore_marker() {
  local created_at
  local -a lines=()

  [[ -f "${RESTORE_INHIBIT_MARKER}" && ! -L "${RESTORE_INHIBIT_MARKER}" ]] ||
    die 'restore recovery requires the persistent restore inhibit marker'
  [[ "$(stat -c '%u:%a:%h' -- "${RESTORE_INHIBIT_MARKER}")" == "${CURRENT_UID}:600:1" ]] ||
    die 'restore inhibit marker must be deploy-owned, mode 600, and single-linked'
  [[ "$(stat -c '%s' -- "${RESTORE_INHIBIT_MARKER}")" -le 512 ]] ||
    die 'restore inhibit marker is unexpectedly large'
  [[ -s "${RESTORE_INHIBIT_MARKER}" &&
    "$(tail -c 1 -- "${RESTORE_INHIBIT_MARKER}" | od -An -t x1 | tr -d '[:space:]')" == 0a ]] ||
    die 'restore inhibit marker must be non-empty and newline-terminated'
  if grep -avEq '^[ -~]*$' -- "${RESTORE_INHIBIT_MARKER}"; then
    die 'restore inhibit marker contains a non-printable byte'
  fi
  mapfile -t lines <"${RESTORE_INHIBIT_MARKER}"
  [[ "${#lines[@]}" == 6 ]] || die 'restore inhibit marker has an invalid field count'
  [[ "${lines[0]}" == schema=geo.production-restore-inhibit.v1 &&
    "${lines[1]}" == state=active ]] || die 'restore inhibit marker schema or state is invalid'
  [[ "${lines[2]}" =~ ^created_at_utc=([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)$ ]] ||
    die 'restore inhibit marker timestamp is invalid'
  created_at=${BASH_REMATCH[1]}
  [[ "$(date --utc --date="${created_at}" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" == "${created_at}" ]] ||
    die 'restore inhibit marker timestamp is not a real UTC time'
  [[ "${lines[3]}" == "created_by_uid=${CURRENT_UID}" ]] ||
    die 'restore inhibit marker creator is invalid'
  [[ "${lines[4]}" =~ ^pre_restore_backup_id=[0-9]{8}T[0-9]{6}Z-pre-restore$ ]] ||
    die 'restore inhibit marker backup ID is invalid'
  [[ "${lines[5]}" =~ ^pre_restore_checksum_sha256=[0-9a-f]{64}$ ]] ||
    die 'restore inhibit marker checksum binding is invalid'
}

validate_restore_start_boundary() {
  [[ ! -e "${RESTORE_CLEARANCE_GATE}" && ! -L "${RESTORE_CLEARANCE_GATE}" ]] ||
    die 'restore inhibit clearance is incomplete; rerun the clearance helper before startup'
  if [[ "${RESTORE_RECOVERY}" == true ]]; then
    command -v systemctl >/dev/null 2>&1 || die 'systemctl is required for restore recovery startup'
    validate_restore_marker
    require_inactive_unit "${RESTORE_INHIBIT_UNIT}"
    require_disabled_timer "${HEALTH_TIMER}"
    require_disabled_timer "${BACKUP_TIMER}"
    require_inactive_unit "${HEALTH_SERVICE}"
    require_inactive_unit "${BACKUP_SERVICE}"
  else
    [[ ! -e "${RESTORE_INHIBIT_MARKER}" && ! -L "${RESTORE_INHIBIT_MARKER}" ]] ||
      die 'persistent restore inhibit is active; use --restore-recovery only within the reviewed restore runbook'
  fi
}

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

validate_strict_env_file() {
  local path=$1
  local line
  local line_number=0
  local key
  declare -A seen_keys=()

  [[ -f "${path}" && ! -L "${path}" ]] || die "production env file is missing or unsafe: ${path}"
  [[ "$(stat -c '%h' -- "${path}")" == 1 ]] || die 'production env file must not have hard links'
  [[ ! -s "${path}" || "$(tail -c 1 -- "${path}" | od -An -t x1 | tr -d '[:space:]')" == 0a ]] ||
    die 'production env file must end with a newline'
  while IFS= read -r line || [[ -n "${line}" ]]; do
    ((line_number += 1))
    [[ "${line}" != *$'\r'* ]] || die "production env line ${line_number} contains CR"
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    [[ "${line}" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] ||
      die "production env line ${line_number} must be KEY=value with no leading whitespace or export"
    key=${BASH_REMATCH[1]}
    [[ -z "${seen_keys[${key}]+present}" ]] ||
      die "production env contains a duplicate key: ${key}"
    seen_keys["${key}"]=1
  done <"${path}"
}

validate_restore_start_boundary
acquire_deployment_lock
validate_restore_start_boundary
[[ ! -e "${DEPLOYMENT_JOURNAL_FILE}" && ! -L "${DEPLOYMENT_JOURNAL_FILE}" ]] ||
  die 'a pending deployment journal exists; run rollback recovery before startup'
[[ ! -e "${DEPLOYMENT_JOURNAL_STAGE_FILE}" && ! -L "${DEPLOYMENT_JOURNAL_STAGE_FILE}" ]] ||
  die 'a pending deployment journal stage exists; run rollback recovery before startup'
for deployment_stage in \
  "${DEPLOYMENT_GEO_STAGE_FILE}" \
  "${DEPLOYMENT_COMMISSIONING_STAGE_FILE}" \
  "${DEPLOYMENT_CURRENT_STAGE_FILE}"; do
  [[ ! -e "${deployment_stage}" && ! -L "${deployment_stage}" ]] ||
    die "a pending rollback stage exists; run rollback recovery before startup: ${deployment_stage}"
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
  local path="$1"
  local expected_uid="$2"
  local expected_mode="$3"
  local actual_uid
  local actual_mode

  [[ -d "${path}" && ! -L "${path}" ]] || die "required directory is missing or is a symlink: ${path}"
  actual_uid="$(stat -c '%u' -- "${path}")"
  actual_mode="$(stat -c '%a' -- "${path}")"
  [[ "${actual_uid}" == "${expected_uid}" ]] ||
    die "directory owner mismatch for ${path}: expected uid ${expected_uid}, got ${actual_uid}"
  [[ "${actual_mode}" == "${expected_mode}" ]] ||
    die "directory mode mismatch for ${path}: expected ${expected_mode}, got ${actual_mode}"
}

require_tenant_directory() {
  local path="$1"
  local actual_uid
  local actual_gid
  local actual_mode

  [[ -d "${path}" && ! -L "${path}" ]] ||
    die "tenant Browser Host directory is missing or is a symlink: ${path}"
  actual_uid="$(stat -c '%u' -- "${path}")"
  actual_gid="$(stat -c '%g' -- "${path}")"
  actual_mode="$(stat -c '%a' -- "${path}")"
  [[ "${actual_uid}" == 10001 ]] ||
    die "tenant Browser Host directory owner mismatch for ${path}: expected uid 10001, got ${actual_uid}"
  [[ "${actual_gid}" == 10001 ]] ||
    die "tenant Browser Host directory group mismatch for ${path}: expected gid 10001, got ${actual_gid}"
  [[ "${actual_mode}" == 700 ]] ||
    die "tenant Browser Host directory mode mismatch for ${path}: expected 700, got ${actual_mode}"
}

compose_environment_value() {
  local environment="$1"
  local variable_name="$2"
  local line
  local value=""
  local matches=0

  while IFS= read -r line; do
    if [[ "${line}" == "${variable_name}="* ]]; then
      value="${line#*=}"
      ((matches += 1))
    fi
  done <<<"${environment}"
  [[ "${matches}" == 1 ]] ||
    die "could not resolve exactly one ${variable_name} value from Docker Compose"
  printf '%s' "${value}"
}

[[ "${WAIT_TIMEOUT_SECONDS}" =~ ^[1-9][0-9]{1,3}$ ]] ||
  die 'GEO_COMPOSE_WAIT_TIMEOUT_SECONDS must be an integer from 10 to 9999'
((WAIT_TIMEOUT_SECONDS >= 10)) ||
  die 'GEO_COMPOSE_WAIT_TIMEOUT_SECONDS must be an integer from 10 to 9999'
[[ "${DEPLOYMENT_TIMEOUT_SECONDS}" =~ ^[1-9][0-9]{2,3}$ ]] ||
  die 'GEO_DEPLOYMENT_TIMEOUT_SECONDS must be an integer from 600 to 7200'
((DEPLOYMENT_TIMEOUT_SECONDS >= 600 && DEPLOYMENT_TIMEOUT_SECONDS <= 7200)) ||
  die 'GEO_DEPLOYMENT_TIMEOUT_SECONDS must be an integer from 600 to 7200'

[[ -f "${ENV_FILE}" && ! -L "${ENV_FILE}" ]] ||
  die "production env file is missing, not regular, or is a symlink: ${ENV_FILE}"
readonly RESOLVED_ENV_FILE="$(realpath -e -- "${ENV_FILE}")"
[[ "${RESOLVED_ENV_FILE}" == "${SECRET_ROOT}/"* ]] ||
  die "production env file must be inside ${SECRET_ROOT}"

readonly SECRET_OWNER_UID="$(stat -c '%u' -- "${RESOLVED_ENV_FILE}")"
readonly SECRET_MODE="$(stat -c '%a' -- "${RESOLVED_ENV_FILE}")"
[[ "${SECRET_OWNER_UID}" == "${CURRENT_UID}" ]] ||
  die "production env file must be owned by uid ${CURRENT_UID}"
[[ "${SECRET_MODE}" == 600 ]] || die 'production env file mode must be exactly 600'
[[ "$(stat -c '%h' -- "${RESOLVED_ENV_FILE}")" == 1 ]] ||
  die 'production env file must not have hard links'
validate_strict_env_file "${RESOLVED_ENV_FILE}"

require_directory "${SECRET_ROOT}" "${CURRENT_UID}" 700
require_directory "${LOG_ROOT}" "${CURRENT_UID}" 750
require_directory /srv/geo-saas/data/postgres 999 700
require_directory /srv/geo-saas/data/evidence 1000 700
require_directory /srv/geo-saas/data/media 1000 700
require_directory /srv/geo-saas/data/ctrip-runtime 1000 700
require_directory /srv/geo-saas/data/governance-proxy 1000 700
require_directory /srv/geo-saas/data/caddy-data 1000 700
require_directory /srv/geo-saas/data/caddy-config 1000 700
[[ -f "${BROWSER_VNC_PASSWORD_FILE}" && ! -L "${BROWSER_VNC_PASSWORD_FILE}" ]] ||
  die "Browser Host noVNC password file is missing or unsafe: ${BROWSER_VNC_PASSWORD_FILE}"
readonly VNC_OWNER_UID="$(stat -c '%u' -- "${BROWSER_VNC_PASSWORD_FILE}")"
readonly VNC_MODE="$(stat -c '%a' -- "${BROWSER_VNC_PASSWORD_FILE}")"
[[ "${VNC_OWNER_UID}" == "${CURRENT_UID}" ]] ||
  die "Browser Host noVNC password file must be owned by uid ${CURRENT_UID}"
[[ "${VNC_MODE}" == 604 ]] ||
  die 'Browser Host noVNC password file mode must be exactly 604 for the container uid 10001'
[[ -f "${BROWSER_APPARMOR_SOURCE}" && ! -L "${BROWSER_APPARMOR_SOURCE}" ]] ||
  die "release AppArmor policy is missing or unsafe: ${BROWSER_APPARMOR_SOURCE}"
[[ -f "${BROWSER_APPARMOR_TARGET}" && ! -L "${BROWSER_APPARMOR_TARGET}" ]] ||
  die "host AppArmor policy is missing or unsafe: ${BROWSER_APPARMOR_TARGET}"
cmp --silent -- "${BROWSER_APPARMOR_SOURCE}" "${BROWSER_APPARMOR_TARGET}" ||
  die 'host Browser Host AppArmor policy does not match this release; re-run bootstrap with sudo'
[[ -f "${BROWSER_SECCOMP_SOURCE}" && ! -L "${BROWSER_SECCOMP_SOURCE}" ]] ||
  die "release Browser Host seccomp policy is missing or unsafe: ${BROWSER_SECCOMP_SOURCE}"
[[ -f "${CONVERGENCE_MANAGER}" && ! -L "${CONVERGENCE_MANAGER}" && -x "${CONVERGENCE_MANAGER}" ]] ||
  die "release convergence manager is missing or unsafe: ${CONVERGENCE_MANAGER}"

readonly PASSWD_ENTRY="$(getent passwd "${CURRENT_UID}")"
[[ -n "${PASSWD_ENTRY}" ]] || die "could not resolve passwd entry for uid ${CURRENT_UID}"
IFS=: read -r _ _ _ _ _ DEPLOY_HOME _ <<<"${PASSWD_ENTRY}"
readonly DEPLOY_HOME
[[ -d "${DEPLOY_HOME}" ]] || die 'deploy user home directory is unavailable'

deployment_deadline=0

remaining_deployment_seconds() {
  local remaining

  ((deployment_deadline > 0)) || die 'deployment deadline requested before mutation boundary'
  remaining=$((deployment_deadline - SECONDS))
  ((remaining > 0)) || die "global ${DEPLOYMENT_TIMEOUT_SECONDS}s production deployment deadline expired"
  printf '%s' "${remaining}"
}

run_deployment_command() {
  local remaining
  local command_timeout

  if ((deployment_deadline > 0)); then
    remaining="$(remaining_deployment_seconds)"
    command_timeout=${remaining}
    ((command_timeout <= DEPLOYMENT_COMMAND_TIMEOUT_SECONDS)) ||
      command_timeout=${DEPLOYMENT_COMMAND_TIMEOUT_SECONDS}
    timeout --signal=TERM --kill-after=5s "${command_timeout}s" "$@"
  else
    "$@"
  fi
}

manage_convergence() {
  local requested_action=$1
  if [[ "${RESTORE_RECOVERY}" == true ]]; then
    run_deployment_command env -i HOME="${DEPLOY_HOME}" PATH="${PATH}" GEO_ENV_FILE="${RESOLVED_ENV_FILE}" \
      GEO_DEPLOYMENT_LOCK_FD=9 GEO_RESTORE_RECOVERY=1 \
      "${CONVERGENCE_MANAGER}" "${requested_action}"
  else
    run_deployment_command env -i HOME="${DEPLOY_HOME}" PATH="${PATH}" GEO_ENV_FILE="${RESOLVED_ENV_FILE}" \
      GEO_DEPLOYMENT_LOCK_FD=9 "${CONVERGENCE_MANAGER}" "${requested_action}"
  fi
}

docker_local() {
  run_deployment_command env -i \
    HOME="${DEPLOY_HOME}" \
    PATH="${PATH}" \
    DOCKER_HOST="${LOCAL_DOCKER_HOST}" \
    COMPOSE_DISABLE_ENV_FILE=1 \
    docker "$@"
}

for command_name in docker timeout; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command is unavailable: ${command_name}"
done
[[ -S /var/run/docker.sock ]] || die 'the local Docker socket is unavailable'
docker_local compose version >/dev/null 2>&1 || die 'the Docker Compose v2 plugin is unavailable'
docker_local info >/dev/null 2>&1 || die 'the deploy user cannot access the local Docker daemon'

readonly START_LOG="${LOG_ROOT}/start-$(date -u +%Y%m%dT%H%M%SZ).log"
: >"${START_LOG}"
chmod 0600 "${START_LOG}"
exec > >(tee -a "${START_LOG}" 9>&-) 2>&1

cd "${ROOT_DIR}"

# This is the server entrypoint. It intentionally does not read Codex settings,
# invoke a desktop client, or enable fixture seed/demo profiles.
compose=(
  docker_local compose
  --env-file "${RESOLVED_ENV_FILE}"
  -f compose.yaml
  -f compose.production.yaml
  --profile production
)

"${compose[@]}" config --quiet
compose_environment="$("${compose[@]}" config --environment)" ||
  die 'could not resolve the production Docker Compose environment'
BROWSER_TENANT_ID="$(compose_environment_value "${compose_environment}" CTRIP_BROWSER_TENANT_ID)"
BROWSER_PROFILE_ROOT="$(compose_environment_value "${compose_environment}" GEO_BROWSER_PROFILE_ROOT)"
BROWSER_DOWNLOAD_ROOT="$(compose_environment_value "${compose_environment}" GEO_BROWSER_DOWNLOAD_ROOT)"
BROWSER_ARTIFACT_ROOT="$(compose_environment_value "${compose_environment}" GEO_BROWSER_ARTIFACT_ROOT)"
IMAGE_PREFIX="$(compose_environment_value "${compose_environment}" GEO_IMAGE_PREFIX)"
IMAGE_TAG="$(compose_environment_value "${compose_environment}" GEO_IMAGE_TAG)"
IMAGE_REVISION="$(compose_environment_value "${compose_environment}" GEO_IMAGE_REVISION)"
CADDY_IMAGE="$(compose_environment_value "${compose_environment}" CADDY_IMAGE)"
PUBLIC_DOMAIN="$(compose_environment_value "${compose_environment}" GEO_PUBLIC_DOMAIN)"
unset compose_environment
readonly BROWSER_TENANT_ID BROWSER_PROFILE_ROOT BROWSER_DOWNLOAD_ROOT BROWSER_ARTIFACT_ROOT IMAGE_PREFIX IMAGE_TAG IMAGE_REVISION CADDY_IMAGE PUBLIC_DOMAIN

[[ "${BROWSER_TENANT_ID}" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$ ]] ||
  die 'CTRIP_BROWSER_TENANT_ID must be a UUID'
[[ "${IMAGE_PREFIX}" =~ ^[a-z0-9][a-z0-9./_-]*$ ]] ||
  die 'GEO_IMAGE_PREFIX is invalid'
[[ "${IMAGE_REVISION}" =~ ^[0-9a-f]{40}$ ]] ||
  die 'GEO_IMAGE_REVISION must be the exact lowercase 40-character release commit'
[[ "${IMAGE_REVISION}" == "${RELEASE_REVISION}" ]] ||
  die 'GEO_IMAGE_REVISION does not match the immutable release marker'
[[ "${IMAGE_TAG}" == "${RELEASE_REVISION}" ]] ||
  die 'GEO_IMAGE_TAG must equal the immutable release commit'
[[ "${CADDY_IMAGE}" == "${APPROVED_CADDY_IMAGE}" ]] ||
  die 'CADDY_IMAGE must equal the release-approved digest-pinned public ECR image'
[[ "${PUBLIC_DOMAIN}" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ && "${PUBLIC_DOMAIN}" == *.* ]] ||
  die 'GEO_PUBLIC_DOMAIN must be a lowercase FQDN'
require_tenant_directory "${BROWSER_PROFILE_ROOT}/${BROWSER_TENANT_ID}/ctrip"
require_tenant_directory "${BROWSER_DOWNLOAD_ROOT}/${BROWSER_TENANT_ID}"
require_tenant_directory "${BROWSER_ARTIFACT_ROOT}/${BROWSER_TENANT_ID}"

resolve_project_image_ref() {
  local service_name=$1
  local image_suffix=$2
  local expected_ref="${IMAGE_PREFIX}-${image_suffix}:${IMAGE_TAG}"
  local rendered_refs
  local rendered_ref
  local matches=0

  rendered_refs="$("${compose[@]}" config --images "${service_name}")" ||
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

resolve_edge_image_ref() {
  local rendered_refs
  local rendered_ref
  local matches=0

  rendered_refs="$("${compose[@]}" config --images edge)" ||
    die 'could not resolve the production edge image'
  while IFS= read -r rendered_ref; do
    if [[ "${rendered_ref}" == "${CADDY_IMAGE}" ]]; then
      ((matches += 1))
    fi
  done <<<"${rendered_refs}"
  [[ "${matches}" == 1 ]] ||
    die 'production edge image does not resolve exactly once to CADDY_IMAGE'
  printf '%s' "${CADDY_IMAGE}"
}

# Once this point is reached, every remaining deployment action can mutate an image,
# container, or database. Atomically remove the prior convergence proof first so a
# partially completed deployment can never be resumed as though it had converged.
deployment_deadline=$((SECONDS + DEPLOYMENT_TIMEOUT_SECONDS))
readonly deployment_deadline
manage_convergence invalidate

# Build and run the fail-closed configuration validator before any application image or
# long-running service is built/started.
"${compose[@]}" build config-preflight
PREFLIGHT_IMAGE_REF="$(resolve_project_image_ref config-preflight db-tools)"
readonly PREFLIGHT_IMAGE_REF
readonly PREFLIGHT_IMAGE_ID="$(docker_local image inspect --format '{{.Id}}' "${PREFLIGHT_IMAGE_REF}")"
[[ "${PREFLIGHT_IMAGE_ID}" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  die 'could not resolve the built config-preflight image'
readonly PREFLIGHT_IMAGE_REVISION="$(docker_local image inspect \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
  "${PREFLIGHT_IMAGE_ID}")"
[[ "${PREFLIGHT_IMAGE_REVISION}" == "${IMAGE_REVISION}" ]] ||
  die 'built config-preflight image revision does not match GEO_IMAGE_REVISION'
docker_local run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --security-opt "apparmor=${BROWSER_APPARMOR_PROFILE}" \
  --security-opt "seccomp=${BROWSER_SECCOMP_SOURCE}" \
  "${PREFLIGHT_IMAGE_ID}" node --version >/dev/null ||
  die "Browser Host AppArmor/seccomp policies are not usable: ${BROWSER_APPARMOR_PROFILE}"
"${compose[@]}" run --rm --no-deps config-preflight

EDGE_IMAGE_REF="$(resolve_edge_image_ref)"
readonly EDGE_IMAGE_REF
# A digest-pinned image is immutable. Reuse the exact local digest when present
# so a registry metadata outage cannot block an otherwise verifiable release;
# fresh hosts still pull because the image is missing.
"${compose[@]}" pull --policy missing edge
docker_local image inspect "${CADDY_IMAGE}" >/dev/null ||
  die 'digest-pinned production edge image is unavailable after pull'
docker_local run --rm --network none --read-only --user 1000:1000 \
  --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges:true \
  --env "GEO_PUBLIC_DOMAIN=${PUBLIC_DOMAIN}" \
  --tmpfs /data:rw,noexec,nosuid,nodev,size=8m \
  --tmpfs /config:rw,noexec,nosuid,nodev,size=8m \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=8m \
  --mount "type=bind,src=${ROOT_DIR}/deploy/caddy/Caddyfile,dst=/etc/caddy/Caddyfile,readonly" \
  "${EDGE_IMAGE_REF}" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile ||
  die 'release Caddyfile failed validation with the digest-pinned edge image'

"${compose[@]}" build api worker agent-mcp ctrip-bridge browser-host web
for image_service in config-preflight api worker agent-mcp ctrip-bridge browser-host web; do
  image_suffix=${image_service}
  if [[ "${image_service}" == config-preflight ]]; then
    image_suffix=db-tools
  fi
  image_ref="$(resolve_project_image_ref "${image_service}" "${image_suffix}")"
  built_revision="$(docker_local image inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "${image_ref}")"
  [[ "${built_revision}" == "${IMAGE_REVISION}" ]] ||
    die "built image revision mismatch for ${image_service}"
done
unset image_service image_suffix image_ref built_revision
"${compose[@]}" up --detach --wait --wait-timeout "${WAIT_TIMEOUT_SECONDS}"
"${compose[@]}" ps --all
manage_convergence attest
remaining_deployment_seconds >/dev/null

printf 'Internal production stack started and passed Compose health checks.\n'
printf 'Production convergence attestation was published after the final one-shot and service recheck.\n'
printf 'External HTTPS acceptance is not complete; verify it from an external network with: %s/scripts/verify-production-https.sh %s EXPECTED_PUBLIC_IPV4\n' \
  "${ROOT_DIR}" "${PUBLIC_DOMAIN}"
printf 'Deployment log: %s\n' "${START_LOG}"
