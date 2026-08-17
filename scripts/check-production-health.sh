#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly current_link=/srv/geo-saas/app/current
readonly env_file=/srv/geo-saas/secrets/geo.env
readonly operations_lock=/srv/geo-saas/secrets/.geo-deployment.lock
readonly backup_maintenance_lock=/srv/geo-saas/secrets/.geo-backup-maintenance.lock
readonly restore_inhibit_marker=/srv/geo-saas/secrets/.geo-restore-inhibit
readonly restore_clearance_gate=/srv/geo-saas/secrets/.geo-restore-inhibit-clearance
readonly convergence_manager_timeout_seconds=420
readonly https_verification_timeout_seconds=150

die() {
  printf 'Production health check failed: %s\n' "$1" >&2
  exit 1
}

usage() {
  printf 'Usage: check-production-health.sh [--local-only]\n' >&2
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

validate_strict_env_file() {
  local path=$1
  local line
  local line_number=0
  local key
  declare -A seen_keys=()

  [[ ! -s "${path}" || "$(tail -c 1 -- "${path}" | od -An -t x1 | tr -d '[:space:]')" == 0a ]] ||
    die 'production env file must end with a newline'
  while IFS= read -r line || [[ -n "${line}" ]]; do
    ((line_number += 1))
    [[ "${line}" != *$'\r'* ]] || die "production env line ${line_number} contains CR"
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    [[ "${line}" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] ||
      die "production env line ${line_number} must be KEY=value"
    key=${BASH_REMATCH[1]}
    [[ -z "${seen_keys[${key}]+present}" ]] || die "production env duplicates ${key}"
    seen_keys["${key}"]=1
  done <"${path}"
}

[[ "$(uname -s)" == Linux ]] || die 'production health checks run only on Linux'
((EUID != 0)) || die 'run production health checks as the non-root deploy user'
[[ ! -e "${restore_inhibit_marker}" && ! -L "${restore_inhibit_marker}" ]] ||
  die 'health recovery is inhibited until the persistent incident-restore marker is cleared'
[[ ! -e "${restore_clearance_gate}" && ! -L "${restore_clearance_gate}" ]] ||
  die 'health recovery is inhibited by an incomplete restore clearance transaction'
if [[ "${local_only}" != true ]]; then
  /srv/geo-saas/app/current/scripts/validate-production-operations-env.sh health >/dev/null
fi
for command_name in flock timeout; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command is unavailable: ${command_name}"
done
[[ -L "${current_link}" && -d "${current_link}" ]] || die 'current release link is missing or unsafe'
readonly release_root="$(cd -- "${current_link}" && pwd -P)"
[[ -d "${release_root}" && ! -L "${release_root}" ]] || die 'resolved release root is missing or unsafe'
[[ -f "${release_root}/.geo-release" && ! -L "${release_root}/.geo-release" ]] ||
  die 'immutable release marker is missing or unsafe'
[[ "$(stat -c '%u:%a:%h:%s' -- "${release_root}/.geo-release")" == "$(id -u):444:1:41" ]] ||
  die 'immutable release marker owner, mode, link count, or size is invalid'
IFS= read -r release_revision <"${release_root}/.geo-release"
[[ "${release_revision}" =~ ^[0-9a-f]{40}$ ]] || die 'immutable release marker is invalid'
[[ -f "${env_file}" && ! -L "${env_file}" ]] || die 'production env file is missing or unsafe'
[[ "$(stat -c '%u:%a:%h' -- "${env_file}")" == "$(id -u):600:1" ]] ||
  die 'production env file owner, mode, or link count is invalid'
validate_strict_env_file "${env_file}"
readonly lock_parent="$(dirname -- "${operations_lock}")"
[[ -d "${lock_parent}" && ! -L "${lock_parent}" ]] || die 'deployment lock parent is missing or unsafe'
[[ "$(stat -c '%u:%a' -- "${lock_parent}")" == "$(id -u):700" ]] ||
  die 'deployment lock parent owner or mode is invalid'

if [[ -e "${backup_maintenance_lock}" || -L "${backup_maintenance_lock}" ]]; then
  [[ -f "${backup_maintenance_lock}" && ! -L "${backup_maintenance_lock}" ]] ||
    die 'backup maintenance lock is unsafe'
  [[ "$(stat -c '%u:%a:%h' -- "${backup_maintenance_lock}")" == "$(id -u):600:1" ]] ||
    die 'backup maintenance lock owner, mode, or link count is invalid'
fi
exec 8>>"${backup_maintenance_lock}"
chmod 0600 "${backup_maintenance_lock}"
[[ "$(stat -Lc '%d:%i:%u:%h:%a' -- /proc/self/fd/8)" == \
  "$(stat -c '%d:%i:%u:%h:%a' -- "${backup_maintenance_lock}")" ]] ||
  die 'backup maintenance lock descriptor is not bound to the checked path'
if ! flock --nonblock 8; then
  printf 'Production health check skipped: stopped-writer backup maintenance is active.\n'
  exit 0
fi

if [[ -e "${operations_lock}" || -L "${operations_lock}" ]]; then
  [[ -f "${operations_lock}" && ! -L "${operations_lock}" ]] || die 'deployment lock is unsafe'
  [[ "$(stat -c '%u:%a:%h' -- "${operations_lock}")" == "$(id -u):600:1" ]] ||
    die 'deployment lock owner, mode, or link count is invalid'
fi
exec 9>>"${operations_lock}"
chmod 0600 "${operations_lock}"
[[ "$(stat -Lc '%d:%i:%u:%h:%a' -- /proc/self/fd/9)" == \
  "$(stat -c '%d:%i:%u:%h:%a' -- "${operations_lock}")" ]] ||
  die 'deployment lock descriptor is not bound to the checked path'
if ! flock --nonblock 9; then
  printf 'Production health check skipped: deployment maintenance lock is active.\n'
  exit 0
fi

readonly deploy_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
[[ -d "${deploy_home}" ]] || die 'deploy user home directory is unavailable'
readonly convergence_manager=${release_root}/scripts/manage-production-convergence.sh
[[ -f "${convergence_manager}" && ! -L "${convergence_manager}" && -x "${convergence_manager}" ]] ||
  die 'active release convergence manager is missing or unsafe'

resume_attested_stack() {
  timeout --signal=TERM --kill-after=5s "${convergence_manager_timeout_seconds}s" \
    env -i HOME="${deploy_home}" PATH="${PATH}" GEO_ENV_FILE="${env_file}" \
      GEO_DEPLOYMENT_LOCK_FD=9 "${convergence_manager}" resume-existing >/dev/null ||
    die 'attested local-only container recovery or verification failed'
}

if [[ "${local_only}" == true ]]; then
  resume_attested_stack
  printf 'Production local runtime health passed: release=%s (DNS, HTTPS, and external reachability not asserted)\n' \
    "${release_revision}"
  exit 0
fi

public_domain=''
public_domain_matches=0
while IFS= read -r env_line || [[ -n "${env_line}" ]]; do
  if [[ "${env_line}" == GEO_PUBLIC_DOMAIN=* ]]; then
    public_domain=${env_line#*=}
    ((public_domain_matches += 1))
  fi
done <"${env_file}"
readonly public_domain
[[ "${public_domain_matches}" == 1 &&
  "${public_domain}" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ &&
  "${public_domain}" != *..* ]] || die 'production env must contain exactly one lowercase public FQDN'
readonly public_ipv4=${GEO_PUBLIC_IPV4:-}
[[ "${public_ipv4}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die 'GEO_PUBLIC_IPV4 is required and invalid'

resume_attested_stack
timeout --signal=TERM --kill-after=5s "${https_verification_timeout_seconds}s" \
  "${release_root}/scripts/verify-production-https.sh" "${public_domain}" "${public_ipv4}" 127.0.0.1 \
  >/dev/null || die 'authoritative DNS or loopback HTTPS acceptance failed'
printf 'Production host health passed: release=%s domain=%s (external reachability not asserted)\n' \
  "${release_revision}" "${public_domain}"
