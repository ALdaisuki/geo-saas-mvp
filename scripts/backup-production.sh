#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly LOCAL_DOCKER_HOST=unix:///var/run/docker.sock
readonly STOPPED_WRITER_TIMEOUT_SECONDS=900

stopped_writer_deadline=0

die() {
  printf 'Production backup refused: %s\n' "$1" >&2
  exit 1
}

remaining_stopped_writer_seconds() {
  local remaining

  ((stopped_writer_deadline > 0)) || die 'stopped-writer deadline requested before writer shutdown'
  remaining=$((stopped_writer_deadline - SECONDS))
  ((remaining > 0)) || die "global ${STOPPED_WRITER_TIMEOUT_SECONDS}s stopped-writer deadline expired"
  printf '%s' "${remaining}"
}

run_backup_command() {
  local remaining

  if ((stopped_writer_deadline > 0)); then
    remaining="$(remaining_stopped_writer_seconds)"
    timeout --signal=TERM --kill-after=5s "${remaining}s" "$@"
  else
    "$@"
  fi
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

require_owned_directory() {
  local path=$1
  local expected_owner=$2
  local expected_mode=$3
  local label=$4
  local metadata
  local owner
  local mode

  [[ -d "${path}" && ! -L "${path}" ]] || die "${label} is missing or unsafe"
  if metadata=$(stat -c '%u %a' -- "${path}" 2>/dev/null); then
    :
  else
    metadata=$(stat -f '%u %Lp' -- "${path}" 2>/dev/null) ||
      die "could not inspect ${label} metadata"
  fi
  read -r owner mode <<<"${metadata}"
  [[ "${owner}" == "${expected_owner}" ]] ||
    die "${label} must be owned by uid ${expected_owner}"
  [[ "${mode}" == "${expected_mode}" ]] || die "${label} mode must be exactly ${expected_mode}"
}

verify_archive_tree() {
  local root=$1
  local label=$2
  local listing
  local entry
  local root_device
  local entry_device
  local entry_owner
  local entry_links
  local unsafe=false

  if root_device=$(run_backup_command stat -c '%d' -- "${root}" 2>/dev/null); then
    :
  else
    root_device=$(run_backup_command stat -f '%d' -- "${root}") ||
      die "could not inspect ${label} device"
  fi
  listing=$(run_backup_command mktemp "${TMPDIR:-/tmp}/geo-backup-tree.XXXXXX") ||
    die "could not stage ${label} inspection"
  if ! run_backup_command find "${root}" -xdev -print0 >"${listing}"; then
    rm -f -- "${listing}"
    die "could not inspect ${label}"
  fi
  while IFS= read -r -d '' entry; do
    if entry_device=$(run_backup_command stat -c '%d' -- "${entry}" 2>/dev/null); then
      :
    else
      entry_device=$(run_backup_command stat -f '%d' -- "${entry}") || {
        unsafe=true
        break
      }
    fi
    if entry_owner=$(run_backup_command stat -c '%u' -- "${entry}" 2>/dev/null); then
      :
    else
      entry_owner=$(run_backup_command stat -f '%u' -- "${entry}") || {
        unsafe=true
        break
      }
    fi
    if [[ "${entry_device}" != "${root_device}" || "${entry_owner}" != "$(id -u)" ||
      -L "${entry}" || ! -r "${entry}" ]]; then
      unsafe=true
      break
    fi
    if [[ -d "${entry}" ]]; then
      [[ -x "${entry}" ]] || unsafe=true
    elif [[ -f "${entry}" ]]; then
      if entry_links=$(run_backup_command stat -c '%h' -- "${entry}" 2>/dev/null); then
        :
      else
        entry_links=$(run_backup_command stat -f '%l' -- "${entry}") || entry_links=0
      fi
      [[ "${entry_links}" == 1 ]] || unsafe=true
    else
      unsafe=true
    fi
    [[ "${unsafe}" == false ]] || break
  done <"${listing}"
  rm -f -- "${listing}"
  [[ "${unsafe}" == false ]] ||
    die "${label} contains an entry with unsafe ownership, readability, type, or link count"
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
Usage: backup-production.sh [options]

Options:
  --release-root ABSOLUTE_PATH  Immutable release root (default: parent of this script)
  --env-file ABSOLUTE_PATH      Production Compose env file
  --data-root ABSOLUTE_PATH     Host data root containing evidence, media, ctrip-runtime
  --backup-root ABSOLUTE_PATH   Destination root for bundle and out-of-band checksum
  --backup-id ID                UTC backup ID (default: current UTC timestamp)
  --deployment-lock ABSOLUTE_PATH
                                Shared production deployment lock (default: /srv/geo-saas/secrets/.geo-deployment.lock)
  --prepare-restore-inhibit     Publish the persistent incident-restore marker only after
                                this verified backup is complete, while the deployment lock
                                is still held. Requires both operations timers/services stopped.
  --docker-bin ABSOLUTE_PATH    Controlled Docker test double; production uses docker
USAGE
  exit 64
}

release_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
env_file=/srv/geo-saas/secrets/geo.env
data_root=/srv/geo-saas/data
backup_root=/srv/geo-saas/backups
backup_id="$(date -u +%Y%m%dT%H%M%SZ)"
deployment_lock_file=/srv/geo-saas/secrets/.geo-deployment.lock
docker_bin=docker
prepare_restore_inhibit=false

while (($# > 0)); do
  case "$1" in
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
    --data-root)
      (($# >= 2)) || usage
      data_root=$2
      shift 2
      ;;
    --backup-root)
      (($# >= 2)) || usage
      backup_root=$2
      shift 2
      ;;
    --backup-id)
      (($# >= 2)) || usage
      backup_id=$2
      shift 2
      ;;
    --deployment-lock)
      (($# >= 2)) || usage
      deployment_lock_file=$2
      shift 2
      ;;
    --prepare-restore-inhibit)
      prepare_restore_inhibit=true
      shift
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

((EUID != 0)) || die 'run production backup as the non-root deploy user'

[[ "${release_root}" == /* && "${env_file}" == /* && "${data_root}" == /* &&
  "${backup_root}" == /* && "${deployment_lock_file}" == /* ]] ||
  die 'all filesystem paths must be absolute'
[[ "${backup_id}" =~ ^[0-9]{8}T[0-9]{6}Z(-[a-z0-9][a-z0-9-]{0,31})?$ ]] ||
  die 'backup ID is invalid'
if [[ "${prepare_restore_inhibit}" == true ]]; then
  [[ "${backup_id}" =~ ^[0-9]{8}T[0-9]{6}Z-pre-restore$ ]] ||
    die '--prepare-restore-inhibit requires a backup ID ending in -pre-restore'
fi
if [[ "${docker_bin}" == */* ]]; then
  [[ "${docker_bin}" == /* && -x "${docker_bin}" && -f "${docker_bin}" && ! -L "${docker_bin}" ]] ||
    die 'Docker binary override must be an absolute executable non-symlink regular file'
else
  [[ "$(uname -s)" == Linux ]] ||
    die 'production backups must run on the Linux server, never on macOS'
  command -v "${docker_bin}" >/dev/null 2>&1 || die 'docker is not installed'
  command -v getent >/dev/null 2>&1 || die 'getent is unavailable'
fi
for command_name in flock sha256sum timeout; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command is unavailable: ${command_name}"
done
deployment_lock_parent=$(dirname -- "${deployment_lock_file}")
restore_inhibit_marker=${deployment_lock_parent}/.geo-restore-inhibit
restore_clearance_gate=${deployment_lock_parent}/.geo-restore-inhibit-clearance
maintenance_lock_file=${deployment_lock_parent}/.geo-backup-maintenance.lock
[[ -d "${deployment_lock_parent}" && ! -L "${deployment_lock_parent}" ]] ||
  die 'shared deployment lock parent is missing or unsafe'
[[ ! -e "${restore_inhibit_marker}" && ! -L "${restore_inhibit_marker}" ]] ||
  die 'production backup is inhibited until the persistent incident-restore marker is cleared'
[[ ! -e "${restore_clearance_gate}" && ! -L "${restore_clearance_gate}" ]] ||
  die 'production backup is inhibited by an incomplete restore clearance transaction'
if [[ "${prepare_restore_inhibit}" == true ]]; then
  [[ "$(uname -s)" == Linux ]] || die 'restore inhibit preparation runs only on Linux'
  for command_name in systemctl sync; do
    command -v "${command_name}" >/dev/null 2>&1 ||
      die "required restore-inhibit command is unavailable: ${command_name}"
  done
fi

# The scheduled wrapper owns this lock from before writer shutdown through the attested
# local resume. Pre-restore preparation acquires it directly before the deployment lock.
if [[ "${docker_bin}" == docker ]]; then
  if [[ -e "${maintenance_lock_file}" || -L "${maintenance_lock_file}" ]]; then
    [[ -f "${maintenance_lock_file}" && ! -L "${maintenance_lock_file}" ]] ||
      die 'backup maintenance lock path is unsafe'
    require_owned_regular_file "${maintenance_lock_file}" 600 'backup maintenance lock'
  fi
  if [[ "${prepare_restore_inhibit}" == true ]]; then
    exec 8>>"${maintenance_lock_file}"
    chmod 0600 "${maintenance_lock_file}"
  else
    [[ "${GEO_BACKUP_MAINTENANCE_LOCK_FD:-}" =~ ^[3-9][0-9]?$ ]] ||
      die 'ordinary production backup must inherit the scheduled wrapper maintenance lock'
    exec 8>&"${GEO_BACKUP_MAINTENANCE_LOCK_FD}" ||
      die 'inherited backup maintenance lock descriptor is closed'
  fi
  require_owned_regular_file "${maintenance_lock_file}" 600 'backup maintenance lock'
  [[ "$(stat -Lc '%d:%i:%u:%h:%a' -- /proc/self/fd/8)" == \
    "$(stat -c '%d:%i:%u:%h:%a' -- "${maintenance_lock_file}")" ]] ||
    die 'backup maintenance lock descriptor is not bound to the checked path'
  flock --nonblock 8 || die 'backup maintenance lock is already held by another operation'
fi
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
[[ ! -e "${restore_inhibit_marker}" && ! -L "${restore_inhibit_marker}" ]] ||
  die 'restore inhibit marker appeared while the production backup lock was acquired'
[[ ! -e "${restore_clearance_gate}" && ! -L "${restore_clearance_gate}" ]] ||
  die 'restore clearance transaction appeared while the production backup lock was acquired'
[[ -d "${release_root}" && ! -L "${release_root}" ]] ||
  die 'release root is missing or is a symlink'
release_root="$(cd -- "${release_root}" && pwd -P)"
[[ -f "${release_root}/compose.yaml" && ! -L "${release_root}/compose.yaml" &&
  -f "${release_root}/compose.production.yaml" && ! -L "${release_root}/compose.production.yaml" ]] ||
  die 'release Compose files are missing or unsafe'
require_owned_regular_file "${release_root}/.geo-release" 444 'immutable release marker'
[[ "$(wc -c <"${release_root}/.geo-release" | tr -d '[:space:]')" == 41 ]] ||
  die 'release marker must contain exactly one commit and newline'
IFS= read -r release_revision <"${release_root}/.geo-release"
[[ "${release_revision}" =~ ^[0-9a-f]{40}$ ]] ||
  die 'release marker must contain a lowercase 40-character commit'

require_owned_regular_file "${env_file}" 600 'production env file'
validate_strict_env_file "${env_file}"
[[ -d "${data_root}" && ! -L "${data_root}" ]] || die 'data root is missing or unsafe'
for data_directory in evidence media ctrip-runtime; do
  require_owned_directory "${data_root}/${data_directory}" "$(id -u)" 700 \
    "backup data directory ${data_directory}"
  verify_archive_tree "${data_root}/${data_directory}" "backup data tree ${data_directory}"
done
for caddy_directory in caddy-data caddy-config; do
  require_owned_directory "${data_root}/${caddy_directory}" 1000 700 \
    "Caddy secret state directory ${caddy_directory}"
done
[[ -d "${backup_root}" && ! -L "${backup_root}" ]] || die 'backup root is missing or unsafe'

readonly RELEASE_ROOT="${release_root}"
readonly ENV_FILE="${env_file}"
readonly DATA_ROOT="${data_root}"
readonly BACKUP_ROOT="$(cd -- "${backup_root}" && pwd -P)"
readonly RELEASE_REVISION="${release_revision}"
readonly DOCKER_BIN="${docker_bin}"
readonly BUNDLE="${BACKUP_ROOT}/${backup_id}"
readonly CHECKSUM_FILE="${BACKUP_ROOT}/${backup_id}.sha256"
readonly DEPLOYMENT_LOCK_FILE="${deployment_lock_file}"
readonly RESTORE_INHIBIT_MARKER="${restore_inhibit_marker}"
readonly RESTORE_CLEARANCE_GATE="${restore_clearance_gate}"
readonly CONVERGENCE_MANAGER=${release_root}/scripts/manage-production-convergence.sh
[[ ! -e "${BUNDLE}" && ! -L "${BUNDLE}" && ! -e "${CHECKSUM_FILE}" &&
  ! -L "${CHECKSUM_FILE}" ]] || die 'backup ID already exists'

if [[ "${DOCKER_BIN}" == docker && "${prepare_restore_inhibit}" == false ]]; then
  [[ -f "${CONVERGENCE_MANAGER}" && ! -L "${CONVERGENCE_MANAGER}" &&
    -x "${CONVERGENCE_MANAGER}" ]] ||
    die 'active release convergence manager is missing or unsafe'
  deploy_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
  [[ -d "${deploy_home}" ]] || die 'deploy user home directory is unavailable'
  env -i HOME="${deploy_home}" PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    GEO_ENV_FILE="${ENV_FILE}" GEO_DEPLOYMENT_LOCK_FD=7 \
    "${CONVERGENCE_MANAGER}" verify >/dev/null ||
    die 'refusing to stop production writers without a current healthy convergence attestation'
fi

require_restore_operations_stopped() {
  local timer
  local service
  local load_state
  local active_state
  local enabled_state

  for timer in geo-saas-health.timer geo-saas-backup.timer; do
    load_state="$(run_backup_command systemctl show --property=LoadState --value "${timer}")" ||
      die "could not inspect ${timer}"
    active_state="$(run_backup_command systemctl show --property=ActiveState --value "${timer}")" ||
      die "could not inspect ${timer}"
    enabled_state="$(run_backup_command systemctl is-enabled "${timer}" 2>/dev/null || :)"
    [[ "${load_state}" == loaded && "${enabled_state}" == disabled &&
      "${active_state}" == inactive ]] ||
      die "${timer} must be installed, disabled, and inactive before restore preparation"
  done
  for service in geo-saas-health.service geo-saas-backup.service; do
    load_state="$(run_backup_command systemctl show --property=LoadState --value "${service}")" ||
      die "could not inspect ${service}"
    active_state="$(run_backup_command systemctl show --property=ActiveState --value "${service}")" ||
      die "could not inspect ${service}"
    [[ "${load_state}" == loaded && "${active_state}" == inactive ]] ||
      die "${service} must be installed and inactive before restore preparation"
  done
}

if [[ "${prepare_restore_inhibit}" == true ]]; then
  require_restore_operations_stopped
fi

pending_transaction_artifacts=()
secret_root=$(dirname -- "${env_file}")
release_parent=$(dirname -- "${release_root}")
app_root_candidate=$(dirname -- "${release_parent}")
for pending_artifact in \
  "${deployment_lock_parent}/.geo-deployment-journal" \
  "${deployment_lock_parent}/.geo-deployment-journal.stage" \
  "${secret_root}/.geo.env.rollback-stage" \
  "${secret_root}/.commissioning.env.rollback-stage" \
  "${release_parent}/.current.rollback-stage" \
  "${app_root_candidate}/.current.rollback-stage" \
  "${release_parent}/.rollback-current."* \
  "${app_root_candidate}/.rollback-current."* \
  "${secret_root}/geo.env.rollback."* \
  "${secret_root}/geo.env.previous."*; do
  [[ -e "${pending_artifact}" || -L "${pending_artifact}" ]] || continue
  pending_transaction_artifacts+=("${pending_artifact}")
done
((${#pending_transaction_artifacts[@]} == 0)) ||
  die 'a pending rollback transaction artifact exists; reconcile it before backup'

docker_local() {
  run_backup_command env -i \
    HOME="${HOME:-/tmp}" \
    PATH="${PATH}" \
    DOCKER_HOST="${LOCAL_DOCKER_HOST}" \
    COMPOSE_DISABLE_ENV_FILE=1 \
    "${DOCKER_BIN}" "$@"
}

compose=(
  docker_local compose
  --project-directory "${RELEASE_ROOT}"
  --env-file "${ENV_FILE}"
  -f "${RELEASE_ROOT}/compose.yaml"
  -f "${RELEASE_ROOT}/compose.production.yaml"
  --profile production
)

"${compose[@]}" config --quiet || die 'production Compose configuration is invalid'
compose_environment=$("${compose[@]}" config --environment) ||
  die 'could not resolve the production Compose environment'

compose_value() {
  local variable_name=$1
  local resolved_value=""
  local matches=0
  local line
  while IFS= read -r line; do
    if [[ "${line}" == "${variable_name}="* ]]; then
      resolved_value=${line#*=}
      ((matches += 1))
    fi
  done <<<"${compose_environment}"
  [[ "${matches}" == 1 ]] ||
    die "Compose environment must resolve ${variable_name} exactly once"
  printf '%s' "${resolved_value}"
}

compose_project=$(compose_value COMPOSE_PROJECT_NAME)
image_tag=$(compose_value GEO_IMAGE_TAG)
image_revision=$(compose_value GEO_IMAGE_REVISION)
unset compose_environment
[[ "${compose_project}" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] ||
  die 'resolved Compose project name is invalid'
[[ "${image_tag}" == "${RELEASE_REVISION}" && "${image_revision}" == "${RELEASE_REVISION}" ]] ||
  die 'GEO_IMAGE_TAG and GEO_IMAGE_REVISION must equal the immutable release marker'

writers=(edge ctrip-bridge agent-mcp worker api web browser-host)
stopped_writer_deadline=$((SECONDS + STOPPED_WRITER_TIMEOUT_SECONDS))
readonly stopped_writer_deadline
"${compose[@]}" stop "${writers[@]}" || die 'could not stop every production writer'
running_services=$("${compose[@]}" ps --status running --services "${writers[@]}") ||
  die 'could not verify stopped production writers'
[[ -z "${running_services}" ]] || die 'one or more production writers are still running'
for data_directory in evidence media ctrip-runtime; do
  verify_archive_tree "${DATA_ROOT}/${data_directory}" "stopped backup data tree ${data_directory}"
done

partial_bundle=$(run_backup_command mktemp -d "${BACKUP_ROOT}/.${backup_id}.partial.XXXXXX") ||
  die 'could not create private partial bundle'
partial_checksum=$(run_backup_command mktemp "${BACKUP_ROOT}/.${backup_id}.sha256.partial.XXXXXX") ||
  die "could not create checksum staging file; partial bundle retained at ${partial_bundle}"
run_backup_command chmod 0700 "${partial_bundle}"
run_backup_command chmod 0600 "${partial_checksum}"

"${compose[@]}" exec -T postgres sh -lc \
  'umask 077; PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
    --host=127.0.0.1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
    --format=custom --compress=9 --no-owner --no-acl --file=/tmp/geo-saas-backup.dump' ||
  die "database dump failed; partial bundle retained at ${partial_bundle}"
"${compose[@]}" cp postgres:/tmp/geo-saas-backup.dump "${partial_bundle}/postgres.dump" ||
  die "database dump copy failed; partial bundle retained at ${partial_bundle}"
"${compose[@]}" exec -T postgres rm -f /tmp/geo-saas-backup.dump ||
  die "database dump cleanup failed; partial bundle retained at ${partial_bundle}"

run_backup_command tar --create --gzip --one-file-system --numeric-owner --acls --xattrs \
  --file="${partial_bundle}/application-files.tar.gz" \
  --directory="${DATA_ROOT}" evidence media ctrip-runtime ||
  die "application-files archive failed; partial bundle retained at ${partial_bundle}"

"${compose[@]}" images --format json >"${partial_bundle}/images.json" ||
  die "could not record image inventory; partial bundle retained at ${partial_bundle}"
[[ -s "${partial_bundle}/images.json" ]] ||
  die "image inventory is empty; partial bundle retained at ${partial_bundle}"

created_utc=$(run_backup_command date -u +%Y-%m-%dT%H:%M:%SZ)
{
  printf 'manifest_version=2\n'
  printf 'backup_id=%s\n' "${backup_id}"
  printf 'created_utc=%s\n' "${created_utc}"
  printf 'release=%s\n' "${RELEASE_REVISION}"
  printf 'compose_project=%s\n' "${compose_project}"
  printf 'scope=postgres,evidence,media,ctrip-runtime\n'
  printf 'caddy_state_policy=excluded-reissue\n'
  printf 'postgres_dump=postgres.dump\n'
  printf 'application_archive=application-files.tar.gz\n'
  printf 'images_file=images.json\n'
} >"${partial_bundle}/manifest.txt"
run_backup_command chmod 0600 \
  "${partial_bundle}"/{postgres.dump,application-files.tar.gz,images.json,manifest.txt}

(
  cd -- "${partial_bundle}"
  run_backup_command sha256sum -- application-files.tar.gz images.json manifest.txt postgres.dump
) >"${partial_checksum}"

run_backup_command mv -- "${partial_bundle}" "${BUNDLE}" ||
  die "could not publish bundle directory; partial files retained under ${BACKUP_ROOT}"
run_backup_command mv -- "${partial_checksum}" "${CHECKSUM_FILE}" ||
  die "could not publish checksum file; bundle retained at ${BUNDLE}"

run_backup_command "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/verify-backup-bundle.sh" \
  --bundle "${BUNDLE}" \
  --checksum-file "${CHECKSUM_FILE}" \
  --expected-release "${RELEASE_REVISION}" \
  --expected-project "${compose_project}" \
  --compose-file "${RELEASE_ROOT}/compose.yaml" \
  --docker-bin "${DOCKER_BIN}" ||
  die "published bundle did not verify; retain it for investigation: ${BUNDLE}"

if [[ "${prepare_restore_inhibit}" == true ]]; then
  require_restore_operations_stopped
  [[ ! -e "${RESTORE_INHIBIT_MARKER}" && ! -L "${RESTORE_INHIBIT_MARKER}" ]] ||
    die 'restore inhibit marker appeared before the verified pre-restore backup completed'
  [[ ! -e "${RESTORE_CLEARANCE_GATE}" && ! -L "${RESTORE_CLEARANCE_GATE}" ]] ||
    die 'restore clearance transaction appeared before the verified pre-restore backup completed'
  restore_checksum_sha256="$(run_backup_command sha256sum -- "${CHECKSUM_FILE}" | awk '{print $1}')"
  [[ "${restore_checksum_sha256}" =~ ^[0-9a-f]{64}$ ]] ||
    die 'could not hash the pre-restore checksum file'
  restore_marker_stage="$(run_backup_command mktemp \
    "${deployment_lock_parent}/.geo-restore-inhibit.stage.XXXXXX")" ||
    die 'could not create restore inhibit marker stage'
  {
    printf 'schema=geo.production-restore-inhibit.v1\n'
    printf 'state=active\n'
    printf 'created_at_utc=%s\n' "${created_utc}"
    printf 'created_by_uid=%s\n' "$(id -u)"
    printf 'pre_restore_backup_id=%s\n' "${backup_id}"
    printf 'pre_restore_checksum_sha256=%s\n' "${restore_checksum_sha256}"
  } >"${restore_marker_stage}"
  run_backup_command chmod 0600 "${restore_marker_stage}"
  [[ -f "${restore_marker_stage}" && ! -L "${restore_marker_stage}" &&
    "$(run_backup_command stat -c '%u:%a:%h' -- "${restore_marker_stage}")" == \
      "$(id -u):600:1" ]] || {
    rm -f -- "${restore_marker_stage}"
    die 'restore inhibit marker stage is unsafe'
  }
  run_backup_command sync -d "${restore_marker_stage}" || {
    rm -f -- "${restore_marker_stage}"
    die 'could not persist restore inhibit marker stage'
  }
  run_backup_command mv -nT -- "${restore_marker_stage}" "${RESTORE_INHIBIT_MARKER}" || {
    rm -f -- "${restore_marker_stage}"
    die 'could not publish restore inhibit marker'
  }
  if [[ -e "${restore_marker_stage}" || -L "${restore_marker_stage}" ]]; then
    rm -f -- "${restore_marker_stage}"
    die 'restore inhibit marker was not published because the target already exists'
  fi
  [[ -f "${RESTORE_INHIBIT_MARKER}" && ! -L "${RESTORE_INHIBIT_MARKER}" &&
    "$(run_backup_command stat -c '%u:%a:%h' -- "${RESTORE_INHIBIT_MARKER}")" == \
      "$(id -u):600:1" ]] ||
    die 'published restore inhibit marker is unsafe'
  run_backup_command sync -f "${deployment_lock_parent}" ||
    die 'could not persist restore inhibit marker directory entry'
fi

remaining_stopped_writer_seconds >/dev/null

printf 'Production backup completed with writers stopped.\n'
printf 'Bundle: %s\n' "${BUNDLE}"
printf 'Out-of-band checksum: %s\n' "${CHECKSUM_FILE}"
printf 'Caddy ACME state was excluded; disaster recovery requires empty-state reissuance and external HTTPS verification.\n'
if [[ "${prepare_restore_inhibit}" == true ]]; then
  printf 'Persistent restore inhibit published: %s (backup=%s checksum_sha256=%s)\n' \
    "${RESTORE_INHIBIT_MARKER}" "${backup_id}" "${restore_checksum_sha256}"
fi
