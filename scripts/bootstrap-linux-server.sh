#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'Linux server bootstrap cannot run on macOS or another operating system.\n' >&2
  exit 1
fi

if [[ "${EUID}" -ne 0 ]]; then
  printf 'Run this script with sudo.\n' >&2
  exit 1
fi

readonly deploy_user="${SUDO_USER:-}"
if [[ -z "${deploy_user}" || "${deploy_user}" == root ]]; then
  printf 'Run this script as the non-root deploy user via sudo.\n' >&2
  exit 1
fi

if ! id "${deploy_user}" >/dev/null 2>&1; then
  printf 'Deploy user does not exist: %s\n' "${deploy_user}" >&2
  exit 1
fi

readonly script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly browser_apparmor_installer="${script_root}/scripts/install-browser-host-apparmor.sh"
[[ -f "${browser_apparmor_installer}" && ! -L "${browser_apparmor_installer}" ]] || {
  printf 'Missing Browser Host AppArmor installer: %s\n' "${browser_apparmor_installer}" >&2
  printf 'Run bootstrap from a complete GEO SaaS release, not a copied script.\n' >&2
  exit 1
}

export DEBIAN_FRONTEND=noninteractive
command -v apt-get >/dev/null 2>&1 || {
  printf 'This bootstrap currently supports Debian/Ubuntu servers with apt-get.\n' >&2
  exit 1
}
apt-get update
apt-get install --yes apparmor apparmor-utils docker.io docker-compose-v2 x11vnc

"${browser_apparmor_installer}"

systemctl enable --now docker.service
usermod --append --groups docker "${deploy_user}"

readonly deploy_group="$(id --group --name "${deploy_user}")"
install -d -o "${deploy_user}" -g "${deploy_group}" -m 0750 \
  /srv/geo-saas \
  /srv/geo-saas/app \
  /srv/geo-saas/app/releases \
  /srv/geo-saas/data \
  /srv/geo-saas/backups \
  /srv/geo-saas/logs \
  /srv/geo-saas/browser-downloads \
  /srv/geo-saas/browser-artifacts
install -d -o "${deploy_user}" -g "${deploy_group}" -m 0700 \
  /srv/geo-saas/secrets \
  /srv/geo-saas/browser-profiles

# These numeric owners match the non-root users in the pinned production images.
install -d -o 999 -g 999 -m 0700 /srv/geo-saas/data/postgres
install -d -o 1000 -g 1000 -m 0700 \
  /srv/geo-saas/data/evidence \
  /srv/geo-saas/data/media \
  /srv/geo-saas/data/ctrip-runtime \
  /srv/geo-saas/data/caddy-data \
  /srv/geo-saas/data/caddy-config

readonly browser_tenant_id="${GEO_BOOTSTRAP_CTRIP_TENANT_ID:-}"
if [[ -n "${browser_tenant_id}" ]]; then
  if [[ ! "${browser_tenant_id}" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$ ]]; then
    printf 'GEO_BOOTSTRAP_CTRIP_TENANT_ID must be a UUID.\n' >&2
    exit 1
  fi
  # Keep the intermediate profile directory traversable by the deploy user so
  # the non-root production launcher can verify the container-owned leaf.
  install -d -o "${deploy_user}" -g "${deploy_group}" -m 0700 \
    "/srv/geo-saas/browser-profiles/${browser_tenant_id}"
  install -d -o 10001 -g 10001 -m 0700 \
    "/srv/geo-saas/browser-profiles/${browser_tenant_id}/ctrip" \
    "/srv/geo-saas/browser-downloads/${browser_tenant_id}" \
    "/srv/geo-saas/browser-artifacts/${browser_tenant_id}"
else
  printf '\nBrowser tenant directories were not created. Re-run with an approved UUID:\n'
  printf '  sudo GEO_BOOTSTRAP_CTRIP_TENANT_ID=<tenant-uuid> %s\n' "$0"
fi

docker --version
docker compose version
printf 'Browser AppArmor profile: '
grep '^geo-saas-browser-host ' /sys/kernel/security/apparmor/profiles
systemctl --no-pager --full status docker.service | sed -n '1,12p'

printf '\nServer bootstrap completed. Reconnect over SSH before running Docker as %s.\n' "${deploy_user}"
printf 'Create /srv/geo-saas/secrets/commissioning.env as %s with mode 0600 and run DB-only commissioning first.\n' "${deploy_user}"
printf 'Create the separate geo.env only after commissioning emits the real tenant and worker IDs.\n'
printf 'Create the interactive noVNC password with scripts/create-browser-vnc-password.sh before production startup.\n'
