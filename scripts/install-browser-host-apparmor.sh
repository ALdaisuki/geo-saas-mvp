#!/usr/bin/env bash
set -Eeuo pipefail
umask 022

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'Browser Host AppArmor installation requires Linux.\n' >&2
  exit 1
fi

if ((EUID != 0)); then
  printf 'Run this AppArmor installer through sudo.\n' >&2
  exit 1
fi

readonly root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly profile_name=geo-saas-browser-host
readonly source_path="${root_dir}/deploy/apparmor/${profile_name}"
readonly target_path="/etc/apparmor.d/${profile_name}"
temporary_path=""

cleanup() {
  [[ -z "${temporary_path}" ]] || rm -f -- "${temporary_path}"
}

trap cleanup EXIT INT TERM

command -v apparmor_parser >/dev/null 2>&1 || {
  printf 'apparmor_parser is unavailable; install the AppArmor packages first.\n' >&2
  exit 1
}
[[ -d /sys/module/apparmor ]] || {
  printf 'The AppArmor kernel module is not loaded.\n' >&2
  exit 1
}
[[ -f "${source_path}" && ! -L "${source_path}" ]] || {
  printf 'Missing or unsafe Browser Host AppArmor policy: %s\n' "${source_path}" >&2
  exit 1
}

temporary_path="$(mktemp "${target_path}.tmp.XXXXXX")"
install -o root -g root -m 0644 "${source_path}" "${temporary_path}"

validation_output="$(apparmor_parser -Q -K --warn=all "${temporary_path}" 2>&1)" || {
  printf '%s\n' "${validation_output}" >&2
  exit 1
}
if [[ -n "${validation_output}" ]]; then
  printf 'AppArmor policy validation returned an unexpected warning:\n%s\n' \
    "${validation_output}" >&2
  exit 1
fi

apparmor_parser -Kr "${temporary_path}"
grep -q "^${profile_name} (enforce)$" /sys/kernel/security/apparmor/profiles || {
  printf 'Browser Host AppArmor policy did not load in enforcing mode.\n' >&2
  exit 1
}

# Publish the disk copy only after the kernel accepted the same bytes. An interrupted update then
# leaves source/target mismatched, so the non-root production launcher fails closed.
mv -fT -- "${temporary_path}" "${target_path}"
temporary_path=""
trap - EXIT INT TERM

printf 'Installed AppArmor profile: %s (enforce)\n' "${profile_name}"
