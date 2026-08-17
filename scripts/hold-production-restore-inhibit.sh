#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

readonly PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly secret_root=/srv/geo-saas/secrets
readonly maintenance_lock=${secret_root}/.geo-backup-maintenance.lock
readonly deployment_lock=${secret_root}/.geo-deployment.lock
readonly inhibit_marker=${secret_root}/.geo-restore-inhibit
readonly clearance_gate=${secret_root}/.geo-restore-inhibit-clearance
readonly marker_schema=geo.production-restore-inhibit.v1
readonly health_timer=geo-saas-health.timer
readonly backup_timer=geo-saas-backup.timer
readonly health_service=geo-saas-health.service
readonly backup_service=geo-saas-backup.service
readonly deploy_uid="$(id -u)"
readonly deploy_gid="$(id -g)"

die() {
  printf 'Production restore inhibit failed: %s\n' "$1" >&2
  exit 1
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
    die "${timer} must be disabled and inactive before incident restore"
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
  [[ "${active_state}" == inactive ]] ||
    die "${service} must be inactive before incident restore"
}

validate_marker() {
  local created_at
  local marker_fd=''
  local marker_path_identity
  local marker_fd_identity
  local -a lines=()

  [[ -f "${inhibit_marker}" && ! -L "${inhibit_marker}" ]] ||
    die 'restore inhibit marker is missing or unsafe'
  [[ "$(stat -c '%u:%g:%h:%a' -- "${inhibit_marker}")" == \
    "${deploy_uid}:${deploy_gid}:1:600" ]] ||
    die 'restore inhibit marker must be deploy-owned, mode 600, and single-linked'
  [[ "$(stat -c '%s' -- "${inhibit_marker}")" -le 512 ]] ||
    die 'restore inhibit marker is unexpectedly large'
  [[ -s "${inhibit_marker}" &&
    "$(tail -c 1 -- "${inhibit_marker}" | od -An -t x1 | tr -d '[:space:]')" == 0a ]] ||
    die 'restore inhibit marker must be non-empty and newline-terminated'
  if grep -avEq '^[ -~]*$' -- "${inhibit_marker}"; then
    die 'restore inhibit marker contains a non-printable byte'
  fi

  exec {marker_fd}<"${inhibit_marker}"
  marker_path_identity="$(path_identity "${inhibit_marker}")" ||
    die 'could not inspect restore inhibit marker path'
  marker_fd_identity="$(fd_identity "${marker_fd}")" ||
    die 'could not inspect restore inhibit marker descriptor'
  [[ "${marker_path_identity}" == "${marker_fd_identity}" ]] ||
    die 'restore inhibit marker changed while it was opened'
  mapfile -t lines <"/proc/self/fd/${marker_fd}"
  exec {marker_fd}<&-

  [[ "${#lines[@]}" == 6 ]] || die 'restore inhibit marker has an invalid field count'
  [[ "${lines[0]}" == "schema=${marker_schema}" ]] ||
    die 'restore inhibit marker schema is invalid'
  [[ "${lines[1]}" == state=active ]] || die 'restore inhibit marker state is invalid'
  [[ "${lines[2]}" =~ ^created_at_utc=([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)$ ]] ||
    die 'restore inhibit marker timestamp is invalid'
  created_at=${BASH_REMATCH[1]}
  [[ "${lines[3]}" == "created_by_uid=${deploy_uid}" ]] ||
    die 'restore inhibit marker creator is invalid'
  [[ "${lines[4]}" =~ ^pre_restore_backup_id=[0-9]{8}T[0-9]{6}Z-pre-restore$ ]] ||
    die 'restore inhibit marker backup ID is invalid'
  [[ "${lines[5]}" =~ ^pre_restore_checksum_sha256=[0-9a-f]{64}$ ]] ||
    die 'restore inhibit marker checksum binding is invalid'
  date --utc --date="${created_at}" '+%Y-%m-%dT%H:%M:%SZ' >/dev/null 2>&1 ||
    die 'restore inhibit marker timestamp is not a real UTC time'
}

[[ "$(uname -s)" == Linux ]] || die 'restore inhibit runs only on Linux'
((EUID != 0)) || die 'restore inhibit must run as the non-root deploy user'
[[ -n "${NOTIFY_SOCKET:-}" ]] || die 'start restore inhibit through geo-saas-restore-inhibit.service'
for command_name in date flock grep od sleep stat systemctl systemd-notify tail tr; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command is unavailable: ${command_name}"
done
[[ -d "${secret_root}" && ! -L "${secret_root}" ]] || die 'secret root is missing or unsafe'
[[ "$(stat -c '%u:%g:%a' -- "${secret_root}")" == "${deploy_uid}:${deploy_gid}:700" ]] ||
  die 'secret root must be deploy-owned with mode 700'
[[ ! -e "${clearance_gate}" && ! -L "${clearance_gate}" ]] ||
  die 'restore inhibit clearance transaction must be recovered before the hold can start'

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

# Close the timer/service inspection race only after both locks are held.
require_disabled_timer "${health_timer}"
require_disabled_timer "${backup_timer}"
require_inactive_service "${health_service}"
require_inactive_service "${backup_service}"
validate_marker

stop_requested=false
trap 'stop_requested=true' INT TERM
trap ':' HUP
systemd-notify --ready --status='Incident restore inhibited; maintenance and deployment locks held' ||
  die 'could not notify systemd that restore inhibit is ready'
printf 'Production restore inhibit is active; marker=%s\n' "${inhibit_marker}"

while [[ "${stop_requested}" == false ]]; do
  sleep 2147483647 &
  wait "$!" || :
done
systemd-notify --stopping --status='Restore inhibit stopped; persistent marker retained' || :
printf 'Production restore inhibit stopped; marker retained at %s\n' "${inhibit_marker}"
