#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

readonly PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly secret_root=/srv/geo-saas/secrets
readonly env_file=${secret_root}/geo.env
readonly maintenance_lock=${secret_root}/.geo-backup-maintenance.lock
readonly deployment_lock=${secret_root}/.geo-deployment.lock
readonly inhibit_marker=${secret_root}/.geo-restore-inhibit
readonly clearance_gate=${secret_root}/.geo-restore-inhibit-clearance
readonly marker_schema=geo.production-restore-inhibit.v1
readonly convergence_manager=/srv/geo-saas/app/current/scripts/manage-production-convergence.sh
readonly restore_unit=geo-saas-restore-inhibit.service
readonly health_timer=geo-saas-health.timer
readonly backup_timer=geo-saas-backup.timer
readonly health_service=geo-saas-health.service
readonly backup_service=geo-saas-backup.service
readonly deploy_uid="$(id -u)"
readonly deploy_gid="$(id -g)"

die() {
  printf 'Production restore inhibit clear refused: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
Usage: clear-production-restore-inhibit.sh \
  --external-https-verified-at YYYY-MM-DDTHH:MM:SSZ \
  --external-https-evidence-sha256 LOWERCASE_SHA256

The timestamp and hash are an explicit operator assertion about evidence produced
by the external HTTPS verifier. This server does not prove its own Internet reachability.
USAGE
  exit 64
}

path_identity() {
  stat -c '%d:%i:%u:%g:%h:%a' -- "$1"
}

fd_identity() {
  stat -Lc '%d:%i:%u:%g:%h:%a' -- "/proc/self/fd/$1"
}

require_safe_lock_path() {
  local path=$1
  local label=$2

  if [[ -e "${path}" || -L "${path}" ]]; then
    [[ -f "${path}" && ! -L "${path}" ]] || die "${label} is not a regular non-symlink file"
    [[ "$(stat -c '%u:%g:%h:%a' -- "${path}")" == "${deploy_uid}:${deploy_gid}:1:600" ]] ||
      die "${label} must be deploy-owned, mode 600, and single-linked"
  fi
}

require_disabled_timer() {
  local timer=$1
  local load_state
  local active_state
  local enabled_state

  load_state="$(systemctl show --property=LoadState --value "${timer}")" ||
    die "could not inspect ${timer}"
  active_state="$(systemctl show --property=ActiveState --value "${timer}")" ||
    die "could not inspect ${timer}"
  enabled_state="$(systemctl is-enabled "${timer}" 2>/dev/null || :)"
  [[ "${load_state}" == loaded ]] || die "${timer} is not installed"
  [[ "${enabled_state}" == disabled && "${active_state}" == inactive ]] ||
    die "${timer} must remain disabled and inactive until restore clearance finishes"
}

require_inactive_service() {
  local service=$1
  local load_state
  local active_state

  load_state="$(systemctl show --property=LoadState --value "${service}")" ||
    die "could not inspect ${service}"
  active_state="$(systemctl show --property=ActiveState --value "${service}")" ||
    die "could not inspect ${service}"
  [[ "${load_state}" == loaded ]] || die "${service} is not installed"
  [[ "${active_state}" == inactive ]] || die "${service} must be inactive before restore clearance"
}

read_marker_created_at() {
  local marker_path=$1
  local marker_label=$2
  local marker_fd=''
  local marker_path_identity
  local marker_fd_identity
  local created_at
  local -a lines=()

  [[ -f "${marker_path}" && ! -L "${marker_path}" ]] ||
    die "${marker_label} is missing or unsafe"
  [[ "$(stat -c '%u:%g:%h:%a' -- "${marker_path}")" == \
    "${deploy_uid}:${deploy_gid}:1:600" ]] ||
    die "${marker_label} must be deploy-owned, mode 600, and single-linked"
  [[ "$(stat -c '%s' -- "${marker_path}")" -le 512 ]] ||
    die "${marker_label} is unexpectedly large"
  [[ -s "${marker_path}" &&
    "$(tail -c 1 -- "${marker_path}" | od -An -t x1 | tr -d '[:space:]')" == 0a ]] ||
    die "${marker_label} must be non-empty and newline-terminated"
  if grep -avEq '^[ -~]*$' -- "${marker_path}"; then
    die "${marker_label} contains a non-printable byte"
  fi

  exec {marker_fd}<"${marker_path}"
  marker_path_identity="$(path_identity "${marker_path}")" ||
    die "could not inspect ${marker_label} path"
  marker_fd_identity="$(fd_identity "${marker_fd}")" ||
    die "could not inspect ${marker_label} descriptor"
  [[ "${marker_path_identity}" == "${marker_fd_identity}" ]] ||
    die "${marker_label} changed while it was opened"
  mapfile -t lines <"/proc/self/fd/${marker_fd}"
  exec {marker_fd}<&-

  [[ "${#lines[@]}" == 6 ]] || die "${marker_label} has an invalid field count"
  [[ "${lines[0]}" == "schema=${marker_schema}" ]] ||
    die "${marker_label} schema is invalid"
  [[ "${lines[1]}" == state=active ]] || die "${marker_label} state is invalid"
  [[ "${lines[2]}" =~ ^created_at_utc=([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)$ ]] ||
    die "${marker_label} timestamp is invalid"
  created_at=${BASH_REMATCH[1]}
  [[ "${lines[3]}" == "created_by_uid=${deploy_uid}" ]] ||
    die "${marker_label} creator is invalid"
  [[ "${lines[4]}" =~ ^pre_restore_backup_id=[0-9]{8}T[0-9]{6}Z-pre-restore$ ]] ||
    die "${marker_label} backup ID is invalid"
  [[ "${lines[5]}" =~ ^pre_restore_checksum_sha256=[0-9a-f]{64}$ ]] ||
    die "${marker_label} checksum binding is invalid"
  [[ "$(date --utc --date="${created_at}" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" == "${created_at}" ]] ||
    die "${marker_label} timestamp is not a real UTC time"
  printf '%s' "${created_at}"
}

select_valid_marker_source() {
  local selected=''

  if [[ -e "${inhibit_marker}" || -L "${inhibit_marker}" ]]; then
    read_marker_created_at "${inhibit_marker}" 'restore inhibit marker' >/dev/null
    selected=${inhibit_marker}
  fi
  if [[ -e "${clearance_gate}" || -L "${clearance_gate}" ]]; then
    read_marker_created_at "${clearance_gate}" 'restore inhibit clearance gate' >/dev/null
    if [[ -n "${selected}" ]]; then
      cmp --silent -- "${selected}" "${clearance_gate}" ||
        die 'restore inhibit marker and clearance gate do not match'
    else
      selected=${clearance_gate}
    fi
  fi
  [[ -n "${selected}" ]] || die 'restore inhibit marker and clearance gate are both missing'
  printf '%s' "${selected}"
}

require_fresh_external_evidence() {
  local now_epoch

  now_epoch="$(date --utc '+%s')"
  ((external_verified_epoch >= marker_created_epoch)) ||
    die 'external HTTPS evidence predates the restore inhibit'
  ((external_verified_epoch <= now_epoch + 300)) ||
    die 'external HTTPS verification time is too far in the future'
  ((now_epoch - external_verified_epoch <= 3600)) ||
    die 'external HTTPS evidence is older than one hour; rerun the verifier from an external host'
}

publish_marker_payload() {
  local target=$1
  local stage=''

  if [[ -e "${target}" || -L "${target}" ]]; then
    [[ -f "${target}" && ! -L "${target}" &&
      "$(stat -c '%u:%g:%h:%a' -- "${target}")" == "${deploy_uid}:${deploy_gid}:1:600" &&
      "$(<"${target}")" == "${marker_payload}" ]] || return 1
    sync -d "${target}" && sync -f "${secret_root}"
    return
  fi

  stage="$(mktemp "${target}.stage.XXXXXX")" || return 1
  printf '%s\n' "${marker_payload}" >"${stage}" || {
    rm -f -- "${stage}"
    return 1
  }
  chmod 0600 "${stage}" || {
    rm -f -- "${stage}"
    return 1
  }
  [[ -f "${stage}" && ! -L "${stage}" &&
    "$(stat -c '%u:%g:%h:%a' -- "${stage}")" == "${deploy_uid}:${deploy_gid}:1:600" ]] || {
    rm -f -- "${stage}"
    return 1
  }
  sync -d "${stage}" || {
    rm -f -- "${stage}"
    return 1
  }
  mv -nT -- "${stage}" "${target}" || {
    rm -f -- "${stage}"
    return 1
  }
  if [[ -e "${stage}" || -L "${stage}" ]]; then
    rm -f -- "${stage}"
    return 1
  fi
  [[ -f "${target}" && ! -L "${target}" &&
    "$(stat -c '%u:%g:%h:%a' -- "${target}")" == "${deploy_uid}:${deploy_gid}:1:600" &&
    "$(<"${target}")" == "${marker_payload}" ]] || return 1
  sync -f "${secret_root}"
}

clearance_transaction_active=false
restore_clearance_after_failure() {
  local status=$?

  trap - EXIT HUP INT TERM
  if [[ "${clearance_transaction_active}" == true ]]; then
    publish_marker_payload "${clearance_gate}" ||
      printf 'WARNING: could not durably restore the clearance gate; inspect %s immediately.\n' \
        "${secret_root}" >&2
    publish_marker_payload "${inhibit_marker}" ||
      printf 'WARNING: could not durably restore the inhibit marker; the clearance gate must remain in place.\n' >&2
    sync -f "${secret_root}" ||
      printf 'WARNING: could not confirm restored inhibit state durability.\n' >&2
  fi
  exit "${status}"
}
trap restore_clearance_after_failure EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

require_restore_unit_inactive() {
  local load_state
  local active_state

  load_state="$(systemctl show --property=LoadState --value "${restore_unit}")" ||
    die "could not inspect ${restore_unit}"
  active_state="$(systemctl show --property=ActiveState --value "${restore_unit}")" ||
    die "could not inspect ${restore_unit}"
  [[ "${load_state}" == loaded ]] || die "${restore_unit} is not installed"
  [[ "${active_state}" == inactive ]] ||
    die "${restore_unit} must be stopped and inactive before its marker can be cleared"
}

external_verified_at=''
external_evidence_sha256=''
while (($# > 0)); do
  case "$1" in
    --external-https-verified-at)
      (($# >= 2)) || usage
      [[ -z "${external_verified_at}" ]] || usage
      external_verified_at=$2
      shift 2
      ;;
    --external-https-evidence-sha256)
      (($# >= 2)) || usage
      [[ -z "${external_evidence_sha256}" ]] || usage
      external_evidence_sha256=$2
      shift 2
      ;;
    --help|-h) usage ;;
    *) usage ;;
  esac
done
[[ -n "${external_verified_at}" && -n "${external_evidence_sha256}" ]] || usage

[[ "$(uname -s)" == Linux ]] || die 'restore inhibit clearance runs only on Linux'
((EUID != 0)) || die 'run restore inhibit clearance as the non-root deploy user'
for command_name in cmp cut date flock getent grep mktemp mv od rm stat sync systemctl tail tr unlink; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command is unavailable: ${command_name}"
done
[[ "${external_verified_at}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
  die 'external HTTPS verification time must be an exact UTC RFC3339 timestamp'
[[ "$(date --utc --date="${external_verified_at}" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" == \
  "${external_verified_at}" ]] || die 'external HTTPS verification time is invalid'
[[ "${external_evidence_sha256}" =~ ^[0-9a-f]{64}$ ]] ||
  die 'external HTTPS evidence SHA-256 must be 64 lowercase hexadecimal characters'
[[ -d "${secret_root}" && ! -L "${secret_root}" ]] || die 'secret root is missing or unsafe'
[[ "$(stat -c '%u:%g:%a' -- "${secret_root}")" == "${deploy_uid}:${deploy_gid}:700" ]] ||
  die 'secret root must be deploy-owned with mode 700'

marker_source="$(select_valid_marker_source)"
readonly marker_source
marker_payload="$(<"${marker_source}")"
readonly marker_payload
marker_created_at="$(read_marker_created_at "${marker_source}" 'restore inhibit state')"
readonly marker_created_at
readonly marker_created_epoch="$(date --utc --date="${marker_created_at}" '+%s')"
readonly external_verified_epoch="$(date --utc --date="${external_verified_at}" '+%s')"
require_fresh_external_evidence

require_restore_unit_inactive
require_disabled_timer "${health_timer}"
require_disabled_timer "${backup_timer}"
require_inactive_service "${health_service}"
require_inactive_service "${backup_service}"

require_safe_lock_path "${maintenance_lock}" 'backup maintenance lock'
exec 8>>"${maintenance_lock}"
chmod 0600 "${maintenance_lock}"
[[ -f "${maintenance_lock}" && ! -L "${maintenance_lock}" &&
  "$(path_identity "${maintenance_lock}")" == "$(fd_identity 8)" ]] ||
  die 'backup maintenance lock changed while it was opened'
[[ "$(stat -c '%u:%g:%h:%a' -- "${maintenance_lock}")" == \
  "${deploy_uid}:${deploy_gid}:1:600" ]] ||
  die 'backup maintenance lock must be deploy-owned, mode 600, and single-linked'
flock --nonblock 8 || die 'backup maintenance lock is already held'

require_safe_lock_path "${deployment_lock}" 'deployment lock'
exec 9>>"${deployment_lock}"
chmod 0600 "${deployment_lock}"
[[ -f "${deployment_lock}" && ! -L "${deployment_lock}" &&
  "$(path_identity "${deployment_lock}")" == "$(fd_identity 9)" ]] ||
  die 'deployment lock changed while it was opened'
[[ "$(stat -c '%u:%g:%h:%a' -- "${deployment_lock}")" == \
  "${deploy_uid}:${deploy_gid}:1:600" ]] ||
  die 'deployment lock must be deploy-owned, mode 600, and single-linked'
flock --nonblock 9 || die 'deployment lock is already held'

current_marker_source="$(select_valid_marker_source)"
[[ "$(<"${current_marker_source}")" == "${marker_payload}" ]] ||
  die 'restore inhibit state changed while clearance locks were acquired'
if [[ -e "${clearance_gate}" || -L "${clearance_gate}" ]]; then
  clearance_transaction_active=true
  publish_marker_payload "${inhibit_marker}" ||
    die 'could not restore the inhibit marker from the prior clearance transaction'
fi

require_restore_unit_inactive
require_disabled_timer "${health_timer}"
require_disabled_timer "${backup_timer}"
require_inactive_service "${health_service}"
require_inactive_service "${backup_service}"
[[ -f "${env_file}" && ! -L "${env_file}" ]] || die 'production env file is missing or unsafe'
[[ -f "${convergence_manager}" && ! -L "${convergence_manager}" && -x "${convergence_manager}" ]] ||
  die 'production convergence manager is missing or unsafe'
deploy_home="$(getent passwd "${deploy_uid}" | cut -d: -f6)"
readonly deploy_home
[[ -d "${deploy_home}" ]] || die 'deploy user home directory is unavailable'

env -i HOME="${deploy_home}" PATH="${PATH}" GEO_ENV_FILE="${env_file}" \
  GEO_DEPLOYMENT_LOCK_FD=9 "${convergence_manager}" verify

current_marker_source="$(select_valid_marker_source)"
[[ "$(read_marker_created_at "${current_marker_source}" 'restore inhibit state')" == \
  "${marker_created_at}" && "$(<"${current_marker_source}")" == "${marker_payload}" ]] ||
  die 'restore inhibit marker changed during convergence verification'
require_restore_unit_inactive
require_disabled_timer "${health_timer}"
require_disabled_timer "${backup_timer}"
require_inactive_service "${health_service}"
require_inactive_service "${backup_service}"
require_fresh_external_evidence

publish_marker_payload "${clearance_gate}" ||
  die 'could not durably publish the restore inhibit clearance gate'
clearance_transaction_active=true
unlink -- "${inhibit_marker}" || die 'could not clear restore inhibit marker'
[[ ! -e "${inhibit_marker}" && ! -L "${inhibit_marker}" ]] ||
  die 'restore inhibit marker still exists after clearance'
sync -f "${secret_root}" || die 'could not persist restore inhibit marker clearance'
unlink -- "${clearance_gate}" || die 'could not commit restore inhibit clearance'
[[ ! -e "${clearance_gate}" && ! -L "${clearance_gate}" ]] ||
  die 'restore inhibit clearance gate still exists after commit'
sync -f "${secret_root}" || die 'could not persist restore inhibit clearance commit'
clearance_transaction_active=false
trap - EXIT HUP INT TERM

printf 'Production restore inhibit cleared after convergence verification.\n'
printf 'Operator-asserted external HTTPS evidence: verified_at=%s sha256=%s\n' \
  "${external_verified_at}" "${external_evidence_sha256}"
