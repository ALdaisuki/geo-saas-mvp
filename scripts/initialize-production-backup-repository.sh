#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

die() {
  printf 'Backup repository initialization failed: %s\n' "$1" >&2
  exit 1
}

[[ "$(uname -s)" == Linux ]] || die 'backup repository initialization runs only on Linux'
((EUID != 0)) || die 'run backup repository initialization as the non-root deploy user'
/srv/geo-saas/app/current/scripts/validate-production-operations-env.sh backup >/dev/null
command -v restic >/dev/null 2>&1 || die 'restic is not installed'

readonly repository=${RESTIC_REPOSITORY:-}
readonly password_file=${RESTIC_PASSWORD_FILE:-}
case "${repository}" in
  s3:*|b2:*|azure:*|gs:*|sftp:*|rclone:*|rest:https://*) ;;
  *) die 'RESTIC_REPOSITORY must select a supported non-local offsite backend' ;;
esac
[[ "${password_file}" == /* && -f "${password_file}" && ! -L "${password_file}" ]] ||
  die 'RESTIC_PASSWORD_FILE is missing or unsafe'
[[ "$(stat -c '%u:%a:%h' -- "${password_file}")" == "$(id -u):600:1" ]] ||
  die 'restic password file owner, mode, or link count is invalid'

if restic --no-cache cat config >/dev/null 2>&1; then
  printf 'Encrypted offsite restic repository already exists and is accessible.\n'
  exit 0
fi

restic --no-cache init >/dev/null || die 'restic could not initialize the configured offsite repository'
restic --no-cache cat config >/dev/null || die 'initialized restic repository did not pass authenticated readback'
printf 'Encrypted offsite restic repository initialized and read back successfully.\n'
