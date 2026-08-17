#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

die() {
  printf 'Production local operations installation failed: %s\n' "$1" >&2
  exit 1
}

usage() {
  printf 'Usage: sudo install-production-local-operations.sh\n' >&2
  exit 64
}

(($# == 0)) || usage
[[ "$(uname -s)" == Linux ]] || die 'local operations installation runs only on Linux'
((EUID == 0)) || die 'run the local operations installer with sudo'
readonly deploy_user=${SUDO_USER:-}
[[ -n "${deploy_user}" && "${deploy_user}" != root ]] ||
  die 'run with sudo from the non-root deploy account'
id "${deploy_user}" >/dev/null 2>&1 || die 'deploy user does not exist'
readonly deploy_group="$(id --group --name "${deploy_user}")"
readonly deploy_uid="$(id -u "${deploy_user}")"
readonly release_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly geo_env=/srv/geo-saas/secrets/geo.env

for command_name in docker flock getent jq runuser systemctl systemd-analyze timeout; do
  command -v "${command_name}" >/dev/null 2>&1 ||
    die "required command is unavailable: ${command_name}"
done
readonly deploy_home="$(getent passwd "${deploy_uid}" | cut -d: -f6)"
[[ -d "${deploy_home}" ]] || die 'deploy user home directory is unavailable'
[[ -f "${release_root}/.geo-release" && ! -L "${release_root}/.geo-release" ]] ||
  die 'run the installer from a complete immutable release'
[[ "$(realpath -e -- /srv/geo-saas/app/current)" == "${release_root}" ]] ||
  die 'run the installer only from the active immutable release'
[[ -f "${geo_env}" && ! -L "${geo_env}" ]] || die 'geo.env is missing or unsafe'
[[ "$(stat -c '%u:%a:%h' -- "${geo_env}")" == "${deploy_uid}:600:1" ]] ||
  die 'geo.env must be deploy-owned, mode 600, with one link'

for script_name in backup-production.sh check-production-health.sh manage-production-convergence.sh \
  manage-production-local-cron.sh run-production-backup-cycle.sh verify-backup-bundle.sh; do
  [[ -f "${release_root}/scripts/${script_name}" && ! -L "${release_root}/scripts/${script_name}" &&
    -x "${release_root}/scripts/${script_name}" ]] ||
    die "release script is missing or not executable: ${script_name}"
done

if command -v crontab >/dev/null 2>&1 &&
  runuser --user "${deploy_user}" -- crontab -l 2>/dev/null |
    grep -Eq '^# BEGIN GEO_SAAS_LOCAL_OPERATIONS$|check-production-health\.sh --local-only|run-production-backup-cycle\.sh --local-only'; then
  die 'remove the managed local cron block before installing local systemd operations'
fi

for conflicting_timer in geo-saas-health.timer geo-saas-backup.timer; do
  if systemctl is-enabled --quiet "${conflicting_timer}" 2>/dev/null ||
    systemctl is-active --quiet "${conflicting_timer}"; then
    die "disable the full operations timer before installing local scope: ${conflicting_timer}"
  fi
done

runuser --user "${deploy_user}" -- env -i HOME="${deploy_home}" PATH="${PATH}" \
  DOCKER_HOST=unix:///var/run/docker.sock COMPOSE_DISABLE_ENV_FILE=1 \
  docker compose --project-directory "${release_root}" --env-file "${geo_env}" \
  -f "${release_root}/compose.yaml" -f "${release_root}/compose.production.yaml" \
  --profile production config --quiet || die 'production geo.env/Compose configuration is invalid'

readonly staging_root="$(mktemp -d /run/geo-saas-local-operations.XXXXXX)"
trap 'rm -rf -- "${staging_root}"' EXIT
for template in geo-saas-local-health.service geo-saas-local-backup.service; do
  sed -e "s/@@DEPLOY_USER@@/${deploy_user}/g" -e "s/@@DEPLOY_GROUP@@/${deploy_group}/g" \
    "${release_root}/deploy/systemd/${template}.in" >"${staging_root}/${template}"
done
for timer in geo-saas-local-health.timer geo-saas-local-backup.timer; do
  install -m 0644 "${release_root}/deploy/systemd/${timer}" "${staging_root}/${timer}"
done
systemd-analyze verify "${staging_root}"/*.service "${staging_root}"/*.timer >/dev/null ||
  die 'rendered local systemd units did not pass systemd-analyze verify'
for unit in "${staging_root}"/*.service "${staging_root}"/*.timer; do
  install -o root -g root -m 0644 "${unit}" "/etc/systemd/system/$(basename -- "${unit}")"
done

systemctl daemon-reload
systemctl enable --now geo-saas-local-health.timer
printf 'Production local health recovery units installed.\n'
printf 'Run and inspect the first local backup before enabling its timer:\n'
printf '  sudo systemctl start geo-saas-local-backup.service\n'
printf '  sudo systemctl status --no-pager --full geo-saas-local-backup.service\n'
printf '  sudo systemctl enable --now geo-saas-local-backup.timer\n'
printf 'Local scope does not assert DNS, HTTPS, public reachability, offsite backup, or alert delivery.\n'
