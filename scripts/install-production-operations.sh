#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

die() {
  printf 'Production operations installation failed: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
Usage: sudo install-production-operations.sh [--install-dependencies]

Without --install-dependencies, the installer fails if a required Ubuntu package
is absent. The flag explicitly authorizes apt installation of restic, curl, jq,
dnsutils, openssl, and ca-certificates.
USAGE
  exit 64
}

install_dependencies=false
while (($# > 0)); do
  case "$1" in
    --install-dependencies) install_dependencies=true; shift ;;
    --help|-h) usage ;;
    *) usage ;;
  esac
done

[[ "$(uname -s)" == Linux ]] || die 'operations installation runs only on Linux'
((EUID == 0)) || die 'run the operations installer with sudo'
readonly deploy_user=${SUDO_USER:-}
[[ -n "${deploy_user}" && "${deploy_user}" != root ]] ||
  die 'run with sudo from the non-root deploy account'
id "${deploy_user}" >/dev/null 2>&1 || die 'deploy user does not exist'
readonly deploy_group="$(id --group --name "${deploy_user}")"
readonly deploy_uid="$(id -u "${deploy_user}")"
readonly release_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly health_env=/srv/geo-saas/secrets/operations-health.env
readonly alert_env=/srv/geo-saas/secrets/operations-alert.env
readonly backup_env=/srv/geo-saas/secrets/operations-backup.env
readonly geo_env=/srv/geo-saas/secrets/geo.env
readonly restore_inhibit_marker=/srv/geo-saas/secrets/.geo-restore-inhibit
readonly restore_clearance_gate=/srv/geo-saas/secrets/.geo-restore-inhibit-clearance

if [[ "${install_dependencies}" == true ]]; then
  command -v apt-get >/dev/null 2>&1 || die '--install-dependencies currently requires Ubuntu/Debian apt-get'
  apt-get update
  apt-get install --yes restic curl jq dnsutils openssl ca-certificates
fi
for command_name in curl dig docker getent jq openssl restic runuser systemctl systemd-analyze; do
  command -v "${command_name}" >/dev/null 2>&1 ||
    die "required command is unavailable: ${command_name}; rerun with --install-dependencies on Ubuntu"
done

readonly deploy_home="$(getent passwd "${deploy_uid}" | cut -d: -f6)"
[[ -d "${deploy_home}" ]] || die 'deploy user home directory is unavailable'

[[ -f "${release_root}/.geo-release" && ! -L "${release_root}/.geo-release" ]] ||
  die 'run the installer from a complete immutable release'
[[ "$(realpath -e -- /srv/geo-saas/app/current)" == "${release_root}" ]] ||
  die 'run the installer only from the active immutable release'
[[ ! -e "${restore_inhibit_marker}" && ! -L "${restore_inhibit_marker}" ]] ||
  die 'operations installation is inhibited until the persistent incident-restore marker is cleared'
[[ ! -e "${restore_clearance_gate}" && ! -L "${restore_clearance_gate}" ]] ||
  die 'operations installation is inhibited by an incomplete restore clearance transaction'
for local_timer in geo-saas-local-health.timer geo-saas-local-backup.timer; do
  if systemctl is-enabled --quiet "${local_timer}" 2>/dev/null ||
    systemctl is-active --quiet "${local_timer}"; then
    die "disable the local-scope operations timer before installing full operations: ${local_timer}"
  fi
done
if command -v crontab >/dev/null 2>&1 &&
  runuser --user "${deploy_user}" -- crontab -l 2>/dev/null |
    grep -Eq '^# BEGIN GEO_SAAS_LOCAL_OPERATIONS$|check-production-health\.sh --local-only|run-production-backup-cycle\.sh --local-only'; then
  die 'remove the managed local cron block before installing full systemd operations'
fi
for script_name in check-production-health.sh clear-production-restore-inhibit.sh \
  hold-production-restore-inhibit.sh initialize-production-backup-repository.sh \
  manage-production-convergence.sh run-production-backup-cycle.sh send-operations-alert.sh \
  validate-production-operations-env.sh; do
  [[ -f "${release_root}/scripts/${script_name}" && ! -L "${release_root}/scripts/${script_name}" &&
    -x "${release_root}/scripts/${script_name}" ]] || die "release script is missing or not executable: ${script_name}"
done
[[ -f "${geo_env}" && ! -L "${geo_env}" ]] || die 'geo.env is missing or unsafe'
[[ "$(stat -c '%u:%a:%h' -- "${geo_env}")" == "${deploy_uid}:600:1" ]] ||
  die 'geo.env must be deploy-owned, mode 600, with one link'
[[ ! -s "${geo_env}" || "$(tail -c 1 -- "${geo_env}" | od -An -t x1 | tr -d '[:space:]')" == 0a ]] ||
  die 'geo.env must end with a newline'
declare -A geo_keys=()
geo_line_number=0
while IFS= read -r geo_line || [[ -n "${geo_line}" ]]; do
  ((geo_line_number += 1))
  [[ "${geo_line}" != *$'\r'* ]] || die "geo.env line ${geo_line_number} contains CR"
  [[ -z "${geo_line}" || "${geo_line}" == \#* ]] && continue
  [[ "${geo_line}" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] ||
    die "geo.env line ${geo_line_number} must be KEY=value"
  geo_key=${BASH_REMATCH[1]}
  [[ -z "${geo_keys[${geo_key}]+present}" ]] || die "geo.env duplicates ${geo_key}"
  geo_keys["${geo_key}"]=1
done <"${geo_env}"

for scoped_env in "${health_env}" "${alert_env}" "${backup_env}"; do
  [[ -f "${scoped_env}" && ! -L "${scoped_env}" ]] || die 'a scoped operations env file is missing or unsafe'
  [[ "$(stat -c '%u:%a:%h' -- "${scoped_env}")" == "${deploy_uid}:600:1" ]] ||
    die 'scoped operations env files must be deploy-owned, mode 600, with one link'
done
for operations_domain in health alert backup; do
  runuser --user "${deploy_user}" -- env -i HOME="${deploy_home}" PATH="${PATH}" \
    /srv/geo-saas/app/current/scripts/validate-production-operations-env.sh \
      "${operations_domain}" --file-only >/dev/null
done

restic_repository=''
while IFS= read -r backup_line || [[ -n "${backup_line}" ]]; do
  if [[ "${backup_line}" == RESTIC_REPOSITORY=* ]]; then
    restic_repository=${backup_line#*=}
  fi
done <"${backup_env}"
readonly restic_repository
case "${restic_repository}" in
  rclone:*) command -v rclone >/dev/null 2>&1 || die 'the selected rclone backend requires rclone' ;;
  sftp:*) command -v ssh >/dev/null 2>&1 || die 'the selected sftp backend requires OpenSSH' ;;
esac

runuser --user "${deploy_user}" -- env -i HOME="${deploy_home}" PATH="${PATH}" \
  DOCKER_HOST=unix:///var/run/docker.sock COMPOSE_DISABLE_ENV_FILE=1 \
  docker compose --project-directory "${release_root}" --env-file "${geo_env}" \
  -f "${release_root}/compose.yaml" -f "${release_root}/compose.production.yaml" \
  --profile production config --quiet || die 'production geo.env/Compose configuration is invalid'

readonly staging_root="$(mktemp -d /run/geo-saas-operations.XXXXXX)"
trap 'rm -rf -- "${staging_root}"' EXIT
for template in geo-saas-health.service geo-saas-backup.service geo-saas-backup-init.service \
  geo-saas-restore-inhibit.service 'geo-saas-alert@.service'; do
  sed -e "s/@@DEPLOY_USER@@/${deploy_user}/g" -e "s/@@DEPLOY_GROUP@@/${deploy_group}/g" \
    "${release_root}/deploy/systemd/${template}.in" >"${staging_root}/${template}"
done
for timer in geo-saas-health.timer geo-saas-backup.timer; do
  install -m 0644 "${release_root}/deploy/systemd/${timer}" "${staging_root}/${timer}"
done
systemd-analyze verify "${staging_root}"/*.service "${staging_root}"/*.timer >/dev/null ||
  die 'rendered systemd units did not pass systemd-analyze verify'
for unit in "${staging_root}"/*.service "${staging_root}"/*.timer; do
  install -o root -g root -m 0644 "${unit}" "/etc/systemd/system/$(basename -- "${unit}")"
done

systemctl daemon-reload
systemctl enable --now geo-saas-health.timer
printf 'Production health recovery and operations units installed.\n'
printf 'Explicitly initialize/verify the offsite repository with:\n'
printf '  sudo systemctl start geo-saas-backup-init.service\n'
printf 'Then run and inspect the first complete cycle before relying on the timer:\n'
printf '  sudo systemctl start geo-saas-backup.service\n'
printf '  sudo systemctl status geo-saas-backup.service\n'
printf 'After that cycle passes, enable the daily schedule with:\n'
printf '  sudo systemctl enable --now geo-saas-backup.timer\n'
