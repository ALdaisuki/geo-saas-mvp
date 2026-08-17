#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly LOCAL_DOCKER_HOST=unix:///var/run/docker.sock
readonly operations_validator=/srv/geo-saas/app/current/scripts/validate-production-operations-env.sh
readonly current_link=/srv/geo-saas/app/current
readonly backup_run_lock=/srv/geo-saas/secrets/.geo-backup-run.lock
readonly backup_maintenance_lock=/srv/geo-saas/secrets/.geo-backup-maintenance.lock
readonly restore_inhibit_marker=/srv/geo-saas/secrets/.geo-restore-inhibit
readonly restore_clearance_gate=/srv/geo-saas/secrets/.geo-restore-inhibit-clearance
readonly convergence_manager_timeout_seconds=420
readonly local_backup_process_timeout_seconds=1800

die() {
  printf 'Production backup cycle failed: %s\n' "$1" >&2
  exit 1
}

usage() {
  printf 'Usage: run-production-backup-cycle.sh [--local-only]\n' >&2
  exit 64
}

local_only=false
while (($# > 0)); do
  case "$1" in
    --local-only) local_only=true; shift ;;
    --help|-h) usage ;;
    *) usage ;;
  esac
done

require_owned_file() {
  local path=$1
  local expected_mode=$2
  local label=$3

  [[ -f "${path}" && ! -L "${path}" ]] || die "${label} is missing or unsafe"
  [[ "$(stat -c '%u' -- "${path}")" == "$(id -u)" ]] ||
    die "${label} must be owned by the deploy user"
  [[ "$(stat -c '%a' -- "${path}")" == "${expected_mode}" ]] ||
    die "${label} mode must be exactly ${expected_mode}"
  [[ "$(stat -c '%h' -- "${path}")" == 1 ]] || die "${label} must not have hard links"
}

[[ "$(uname -s)" == Linux ]] || die 'the production backup cycle runs only on Linux'
((EUID != 0)) || die 'run the production backup cycle as the non-root deploy user'
[[ ! -e "${restore_inhibit_marker}" && ! -L "${restore_inhibit_marker}" ]] ||
  die 'scheduled backup is inhibited until the persistent incident-restore marker is cleared'
[[ ! -e "${restore_clearance_gate}" && ! -L "${restore_clearance_gate}" ]] ||
  die 'scheduled backup is inhibited by an incomplete restore clearance transaction'
if [[ "${local_only}" != true ]]; then
  "${operations_validator}" backup >/dev/null
fi

[[ -L "${current_link}" && -d "${current_link}" ]] || die 'current release link is missing or unsafe'
readonly release_root="$(cd -- "${current_link}" && pwd -P)"
readonly env_file=/srv/geo-saas/secrets/geo.env
readonly backup_root=/srv/geo-saas/backups
readonly log_root=/srv/geo-saas/logs
readonly backup_script=${release_root}/scripts/backup-production.sh
readonly convergence_manager=${release_root}/scripts/manage-production-convergence.sh
readonly verify_script=${release_root}/scripts/verify-backup-bundle.sh
readonly release_marker=${release_root}/.geo-release
readonly backup_id="$(date -u +%Y%m%dT%H%M%SZ)"
readonly bundle=${backup_root}/${backup_id}
readonly checksum_file=${backup_root}/${backup_id}.sha256
readonly restic_password_file=${RESTIC_PASSWORD_FILE:-}
readonly restic_repository=${RESTIC_REPOSITORY:-}
readonly keep_daily=${GEO_BACKUP_KEEP_DAILY:-7}
readonly keep_weekly=${GEO_BACKUP_KEEP_WEEKLY:-5}
readonly keep_monthly=${GEO_BACKUP_KEEP_MONTHLY:-12}
readonly local_retention_days=${GEO_LOCAL_BACKUP_RETENTION_DAYS:-7}

[[ -d "${release_root}" && ! -L "${release_root}" ]] || die 'resolved release root is missing or unsafe'
for executable in "${backup_script}" "${convergence_manager}" "${verify_script}"; do
  [[ -f "${executable}" && ! -L "${executable}" && -x "${executable}" ]] ||
    die "required release executable is missing or unsafe: ${executable}"
done
require_owned_file "${release_marker}" 444 'immutable release marker'
IFS= read -r release_revision <"${release_marker}"
[[ "${release_revision}" =~ ^[0-9a-f]{40}$ ]] || die 'immutable release marker is invalid'
[[ -d "${backup_root}" && ! -L "${backup_root}" ]] || die 'backup root is missing or unsafe'
[[ -d "${log_root}" && ! -L "${log_root}" ]] || die 'log root is missing or unsafe'
if [[ "${local_only}" != true ]]; then
  [[ -n "${restic_repository}" ]] || die 'RESTIC_REPOSITORY is required'
  case "${restic_repository}" in
    s3:*|b2:*|azure:*|gs:*|sftp:*|rclone:*|rest:https://*) ;;
    *) die 'RESTIC_REPOSITORY must select a supported non-local offsite backend' ;;
  esac
  [[ -n "${restic_password_file}" && "${restic_password_file}" == /* ]] ||
    die 'RESTIC_PASSWORD_FILE must be an absolute path'
  require_owned_file "${restic_password_file}" 600 'restic password file'
  for retention_value in "${keep_daily}" "${keep_weekly}" "${keep_monthly}"; do
    [[ "${retention_value}" =~ ^[1-9][0-9]{0,2}$ ]] || die 'restic retention values must be integers from 1 to 999'
  done
  [[ "${local_retention_days}" =~ ^[2-9][0-9]?$|^[1-9][0-9]{2}$ ]] ||
    die 'GEO_LOCAL_BACKUP_RETENTION_DAYS must be an integer from 2 to 999'
fi
required_commands=(docker flock jq timeout)
if [[ "${local_only}" != true ]]; then
  required_commands+=(restic)
fi
for command_name in "${required_commands[@]}"; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command is unavailable: ${command_name}"
done
[[ -S /var/run/docker.sock ]] || die 'the local Docker socket is unavailable'

readonly lock_parent="$(dirname -- "${backup_run_lock}")"
[[ -d "${lock_parent}" && ! -L "${lock_parent}" ]] || die 'backup lock parent is missing or unsafe'
[[ "$(stat -c '%u:%a' -- "${lock_parent}")" == "$(id -u):700" ]] ||
  die 'backup lock parent owner or mode is invalid'
for checked_lock in "${backup_run_lock}" "${backup_maintenance_lock}"; do
  if [[ -e "${checked_lock}" || -L "${checked_lock}" ]]; then
    [[ -f "${checked_lock}" && ! -L "${checked_lock}" ]] || die 'an existing backup lock is unsafe'
    [[ "$(stat -c '%u:%a:%h' -- "${checked_lock}")" == "$(id -u):600:1" ]] ||
      die 'an existing backup lock owner, mode, or link count is invalid'
  fi
done
exec 7>>"${backup_run_lock}"
chmod 0600 "${backup_run_lock}"
[[ "$(stat -Lc '%d:%i:%u:%h:%a' -- /proc/self/fd/7)" == \
  "$(stat -c '%d:%i:%u:%h:%a' -- "${backup_run_lock}")" ]] ||
  die 'backup run lock descriptor is not bound to the checked path'
flock --wait 600 7 || die 'another production backup cycle did not finish within ten minutes'
exec 8>>"${backup_maintenance_lock}"
chmod 0600 "${backup_maintenance_lock}"
[[ "$(stat -Lc '%d:%i:%u:%h:%a' -- /proc/self/fd/8)" == \
  "$(stat -c '%d:%i:%u:%h:%a' -- "${backup_maintenance_lock}")" ]] ||
  die 'backup maintenance lock descriptor is not bound to the checked path'
flock --wait 600 8 || die 'production health maintenance did not finish within ten minutes'

readonly deploy_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
[[ -d "${deploy_home}" ]] || die 'deploy user home directory is unavailable'
docker_local() {
  env -i HOME="${deploy_home}" PATH="${PATH}" DOCKER_HOST="${LOCAL_DOCKER_HOST}" \
    COMPOSE_DISABLE_ENV_FILE=1 docker "$@"
}
resume_attested_stack() {
  timeout --signal=TERM --kill-after=5s "${convergence_manager_timeout_seconds}s" \
    env -i HOME="${deploy_home}" PATH="${PATH}" GEO_ENV_FILE="${env_file}" \
      "${convergence_manager}" resume-existing
}
compose=(docker_local compose --project-directory "${release_root}" --env-file "${env_file}" \
  -f "${release_root}/compose.yaml" -f "${release_root}/compose.production.yaml" \
  --profile production)
"${compose[@]}" config --quiet || die 'production Compose configuration is invalid'
compose_environment="$("${compose[@]}" config --environment)" || die 'could not resolve Compose environment'
compose_project=''
compose_project_matches=0
while IFS= read -r compose_line; do
  if [[ "${compose_line}" == COMPOSE_PROJECT_NAME=* ]]; then
    compose_project=${compose_line#*=}
    ((compose_project_matches += 1))
  fi
done <<<"${compose_environment}"
unset compose_environment compose_line
[[ "${compose_project_matches}" == 1 && "${compose_project}" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] ||
  die 'Compose must resolve exactly one valid project name'
readonly compose_project

readonly cycle_log=${log_root}/backup-cycle-${backup_id}.log
readonly restic_json="$(mktemp "${log_root}/.restic-backup-${backup_id}.XXXXXX.json")"
readonly restic_error="$(mktemp "${log_root}/.restic-backup-${backup_id}.XXXXXX.err")"
restore_root=''
stack_recovered=false

cleanup_and_recover() {
  local status=$?
  trap - EXIT
  if [[ "${stack_recovered}" != true ]]; then
    printf 'Attempting production recovery after an interrupted backup cycle.\n' >>"${cycle_log}"
    if resume_attested_stack >>"${cycle_log}" 2>&1; then
      stack_recovered=true
    else
      if [[ "${local_only}" == true ]]; then
        printf 'Production recovery failed; inspect the local backup service journal.\n' >&2
      else
        printf 'Production recovery failed; systemd will raise the backup-cycle alert.\n' >&2
      fi
      status=1
    fi
  fi
  [[ -z "${restore_root}" ]] || rm -rf --one-file-system -- "${restore_root}"
  rm -f -- "${restic_json}"
  if ((status == 0)) || [[ "${local_only}" == true ]]; then
    rm -f -- "${restic_error}"
  else
    printf 'Private restic diagnostics retained at %s\n' "${restic_error}" >&2
  fi
  exit "${status}"
}
trap cleanup_and_recover EXIT

: >"${cycle_log}"
chmod 0600 "${cycle_log}" "${restic_json}" "${restic_error}"

timeout --signal=TERM --kill-after=5s "${local_backup_process_timeout_seconds}s" \
  env -i HOME="${deploy_home}" PATH="${PATH}" GEO_BACKUP_MAINTENANCE_LOCK_FD=8 \
    "${backup_script}" \
    --release-root "${release_root}" --env-file "${env_file}" \
    --backup-root "${backup_root}" --backup-id "${backup_id}" >>"${cycle_log}" 2>&1
[[ -d "${bundle}" && ! -L "${bundle}" && -f "${checksum_file}" && ! -L "${checksum_file}" ]] ||
  die 'verified local recovery set was not published at the expected paths'

# The local recovery set is immutable after publication, so restore availability before transport.
resume_attested_stack >>"${cycle_log}" 2>&1
stack_recovered=true
flock --unlock 8

if [[ "${local_only}" == true ]]; then
  printf 'Production local backup cycle passed: id=%s release=%s\n' \
    "${backup_id}" "${release_revision}"
  printf 'Local recovery set: %s\n' "${bundle}"
  printf 'Out-of-band checksum: %s\n' "${checksum_file}"
  printf 'Private cycle log: %s\n' "${cycle_log}"
  printf 'Offsite transport, readback, and retention were not run in local-only mode.\n'
  exit 0
fi

if ! restic --no-cache backup --json --host geo-production --tag geo-production --tag "backup-id:${backup_id}" \
  "${bundle}" "${checksum_file}" >"${restic_json}" 2>"${restic_error}"; then
  die "encrypted offsite upload failed; private diagnostics: ${restic_error}"
fi
snapshot_id="$(jq --raw-output 'select(.message_type == "summary") | .snapshot_id // empty' \
  <"${restic_json}" | tail -n 1)"
[[ "${snapshot_id}" =~ ^[0-9a-f]{64}$ ]] || die 'restic did not return one valid snapshot ID'

restore_root="$(mktemp -d "${backup_root}/.offsite-verify-${backup_id}.XXXXXX")"
chmod 0700 "${restore_root}"
if ! restic --no-cache restore "${snapshot_id}" --target "${restore_root}" --verify \
  --include "${bundle}" --include "${checksum_file}" >>"${cycle_log}" 2>"${restic_error}"; then
  die "offsite readback failed; private diagnostics: ${restic_error}"
fi
readonly restored_bundle=${restore_root}/${bundle#/}
readonly restored_checksum=${restore_root}/${checksum_file#/}
env -i HOME="${deploy_home}" PATH="${PATH}" "${verify_script}" \
  --bundle "${restored_bundle}" --checksum-file "${restored_checksum}" \
  --expected-release "${release_revision}" --expected-project "${compose_project}" \
  --compose-file "${release_root}/compose.yaml" \
  >>"${cycle_log}" 2>&1

restic --no-cache forget --host geo-production --tag geo-production --group-by host \
  --keep-daily "${keep_daily}" --keep-weekly "${keep_weekly}" --keep-monthly "${keep_monthly}" \
  --prune >>"${cycle_log}" 2>"${restic_error}" ||
  die "offsite retention failed; private diagnostics: ${restic_error}"

while IFS= read -r -d '' old_bundle; do
  old_id=${old_bundle##*/}
  [[ "${old_id}" =~ ^[0-9]{8}T[0-9]{6}Z(-[a-z0-9][a-z0-9-]{0,31})?$ ]] ||
    die 'local retention encountered an unexpected backup directory'
  [[ "$(dirname -- "$(realpath -e -- "${old_bundle}")")" == "${backup_root}" ]] ||
    die 'local retention candidate escaped the backup root'
  old_checksum=${backup_root}/${old_id}.sha256
  [[ -f "${old_checksum}" && ! -L "${old_checksum}" ]] ||
    die "local retention checksum is missing for ${old_id}"
  rm -rf --one-file-system -- "${old_bundle}"
  rm -f -- "${old_checksum}"
done < <(find "${backup_root}" -mindepth 1 -maxdepth 1 -type d \
  -name '20??????T??????Z*' -mtime "+${local_retention_days}" -print0)

printf 'Production backup cycle passed: id=%s release=%s snapshot=%s\n' \
  "${backup_id}" "${release_revision}" "${snapshot_id}"
printf 'Private cycle log: %s\n' "${cycle_log}"
