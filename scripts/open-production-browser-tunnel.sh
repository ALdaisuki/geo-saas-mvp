#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
readonly ssh_target=${1:-geo-production-host}
readonly local_port=${2:-10007}
readonly remote_port=10007

die() {
  printf 'Production browser tunnel failed: %s\n' "$1" >&2
  exit 1
}

usage() {
  printf 'Usage: open-production-browser-tunnel.sh [SSH_HOST_ALIAS] [LOCAL_PORT]\n' >&2
  exit 64
}

(($# <= 2)) || usage
[[ "${ssh_target}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$ ]] ||
  die 'SSH host alias contains an unsupported character'
[[ "${local_port}" =~ ^[0-9]{1,5}$ ]] && ((local_port >= 1024 && local_port <= 65535)) ||
  die 'local port must be an integer from 1024 through 65535'
for command_name in mktemp rm rmdir sleep ssh; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command is unavailable: ${command_name}"
done

# Keep the control socket short enough for macOS's Unix-domain socket limit.
runtime_dir="$(mktemp -d /tmp/geo-browser-tunnel.XXXXXX)" ||
  die 'could not create the private tunnel runtime directory'
readonly runtime_dir
readonly control_socket=${runtime_dir}/control
readonly forward_spec=127.0.0.1:${local_port}:127.0.0.1:${remote_port}

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  set +e
  ssh -F /dev/null -S "${control_socket}" -O cancel -L "${forward_spec}" ignored \
    >/dev/null 2>&1
  ssh -F /dev/null -S "${control_socket}" -O exit ignored >/dev/null 2>&1
  if [[ "${runtime_dir}" == /tmp/geo-browser-tunnel.* && -d "${runtime_dir}" &&
    ! -L "${runtime_dir}" ]]; then
    rm -f -- "${control_socket}"
    rmdir -- "${runtime_dir}" 2>/dev/null
  fi
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# Clear config-defined forwards on the master. The mux request deliberately uses
# /dev/null so its one explicit loopback forward is not cleared with them.
ssh -M -S "${control_socket}" -fN \
  -o ClearAllForwardings=yes \
  -o ControlPersist=no \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -- "${ssh_target}" || die 'could not establish the isolated SSH control connection'
ssh -F /dev/null -S "${control_socket}" -O forward -L "${forward_spec}" ignored ||
  die 'could not establish the loopback-only noVNC forward'

printf 'Production Browser Host tunnel is ready:\n'
printf 'http://127.0.0.1:%s/vnc.html?autoconnect=1&resize=scale\n' "${local_port}"
printf 'Press Ctrl-C to close the tunnel.\n'

while ssh -F /dev/null -S "${control_socket}" -O check ignored >/dev/null 2>&1; do
  sleep 5
done
die 'the SSH control connection closed unexpectedly'
