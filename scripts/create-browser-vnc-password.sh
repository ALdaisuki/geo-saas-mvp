#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'Browser Host password creation requires Linux.\n' >&2
  exit 1
fi
if ((EUID == 0)); then
  printf 'Run this helper as the non-root deploy user.\n' >&2
  exit 1
fi
[[ -t 0 && -t 1 ]] || {
  printf 'Run this helper from an interactive terminal; the password must not be piped.\n' >&2
  exit 1
}
command -v x11vnc >/dev/null 2>&1 || {
  printf 'x11vnc is unavailable; install the server bootstrap package set first.\n' >&2
  exit 1
}

readonly secret_root=/srv/geo-saas/secrets
readonly target_path="${secret_root}/ctrip-vnc.passwd"
[[ -d "${secret_root}" && ! -L "${secret_root}" ]] || {
  printf 'Missing or unsafe secret directory: %s\n' "${secret_root}" >&2
  exit 1
}
[[ "$(stat -c '%u:%a' -- "${secret_root}")" == "$(id -u):700" ]] || {
  printf 'Secret directory must be owned by the deploy user with mode 700.\n' >&2
  exit 1
}

temporary_path="$(mktemp "${secret_root}/.ctrip-vnc.passwd.XXXXXX")"
cleanup() {
  rm -f -- "${temporary_path}"
}
trap cleanup EXIT INT TERM

x11vnc -storepasswd "${temporary_path}"
[[ -f "${temporary_path}" && ! -L "${temporary_path}" ]] || {
  printf 'x11vnc did not create a regular password file.\n' >&2
  exit 1
}
[[ "$(stat -c '%s' -- "${temporary_path}")" == 8 ]] || {
  printf 'x11vnc password file has an unexpected size.\n' >&2
  exit 1
}
chmod 0604 -- "${temporary_path}"
mv -fT -- "${temporary_path}" "${target_path}"
temporary_path=""
trap - EXIT INT TERM
printf 'Created Browser Host noVNC password file: %s\n' "${target_path}"
printf 'The production launcher will require owner %s and mode 604.\n' "$(id -u)"
