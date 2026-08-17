#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
readonly PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

die() {
  printf 'Production release transfer refused: %s\n' "$1" >&2
  exit 1
}

usage() {
  printf 'Usage: transfer-production-release.sh [--start] [ssh-host]\n' >&2
  exit 2
}

start_requested=false
ssh_host=geo-production-host
host_seen=false
while (($# > 0)); do
  case "$1" in
    --start)
      start_requested=true
      ;;
    --help|-h)
      usage
      ;;
    --*)
      usage
      ;;
    *)
      [[ "${host_seen}" == false ]] || usage
      ssh_host=$1
      host_seen=true
      ;;
  esac
  shift
done

[[ "${ssh_host}" =~ ^[A-Za-z0-9._-]+$ ]] || die 'SSH host must be one configured alias or hostname'
for command_name in base64 git mktemp scp ssh tr; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command is unavailable: ${command_name}"
done

repository_root=$(git rev-parse --show-toplevel 2>/dev/null) || die 'run from a Git worktree'
cd "${repository_root}"
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || die 'worktree must be clean'
release=$(git rev-parse --verify HEAD) || die 'could not resolve HEAD'
[[ "${release}" =~ ^[0-9a-f]{40}$ ]] || die 'HEAD must resolve to one full lowercase commit'

archive=$(mktemp -t "geo-saas-${release}.XXXXXX") || die 'could not allocate the local archive'
remote_payload_file=$(mktemp -t "geo-saas-transfer-${release}.XXXXXX") ||
  die 'could not allocate the local transfer payload'
cleanup() {
  rm -f -- "${archive}"
  [[ -z "${remote_payload_file}" ]] || rm -f -- "${remote_payload_file}"
}
trap cleanup EXIT

git archive --format=tar.gz --output="${archive}" "${release}"
scp -o ClearAllForwardings=yes -- "${archive}" \
  "${ssh_host}:/srv/geo-saas/app/geo-saas-${release}.tar.gz"

base64 <<'REMOTE_SCRIPT' | tr -d '\n' >"${remote_payload_file}"
set -Eeuo pipefail
umask 077
readonly PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

release=$1
[[ "${release}" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'Remote release commit is invalid.\n' >&2
  exit 1
}

readonly app_root=/srv/geo-saas/app
readonly releases_root=${app_root}/releases
readonly current_link=${app_root}/current
readonly archive_path=${app_root}/geo-saas-${release}.tar.gz
readonly release_dir=${releases_root}/${release}
readonly stage_dir=${releases_root}/.${release}.incoming.$$

cleanup_remote() {
  local status=$?
  trap - EXIT
  rm -f -- "${archive_path}" || true
  if [[ -d "${stage_dir}" && ! -L "${stage_dir}" ]]; then
    rm -rf -- "${stage_dir}" || true
  fi
  exit "${status}"
}
trap cleanup_remote EXIT

[[ -f "${archive_path}" && ! -L "${archive_path}" ]] || {
  printf 'Transferred release archive is missing or unsafe.\n' >&2
  exit 1
}
[[ ! -e "${stage_dir}" && ! -L "${stage_dir}" ]] || {
  printf 'Release staging path already exists.\n' >&2
  exit 1
}
[[ ! -e "${release_dir}" && ! -L "${release_dir}" ]] || {
  printf 'Immutable release already exists: %s\n' "${release_dir}" >&2
  exit 1
}

# Before introducing a new release pointer (and its Docker build), reclaim only
# artifacts approved by the currently converged release's guarded policy. This
# keeps build-cache exhaustion from turning a deployment into a partial switch.
if [[ -L "${current_link}" ]]; then
  current_target=$(readlink "${current_link}")
  [[ "${current_target}" =~ ^releases/([0-9a-f]{40})$ ]] || {
    printf 'Current production release pointer is invalid.\n' >&2
    exit 1
  }
  current_sha=${BASH_REMATCH[1]}
  if [[ -f /srv/geo-saas/secrets/.geo-production-convergence.attestation ]]; then
    "${current_link}/scripts/manage-production-convergence.sh" verify
    # Keep Docker maintenance from consuming interactive input during pruning.
    "${current_link}/scripts/prune-production-artifacts.sh" apply --confirm-current "${current_sha}" </dev/null
  else
    # An explicitly invalidated attestation means the current runtime is already
    # known to be unhealthy or drifted. Preserve the immutable path checks above
    # and defer artifact pruning until the new release has converged and attested.
    printf 'Skipping pre-deploy artifact pruning: current convergence attestation is invalidated.\n'
  fi
fi

install -d -m 0750 "${stage_dir}"
tar --extract --gzip --file="${archive_path}" --directory="${stage_dir}" --same-permissions
find "${stage_dir}" -xdev -type d -perm /022 -exec chmod go-w -- {} +
find "${stage_dir}" -xdev -type f -perm /022 -exec chmod go-w -- {} +
[[ -z "$(find "${stage_dir}" -xdev -perm /022 -print -quit)" ]] || {
  printf 'Staged release contains a group/other-writable path.\n' >&2
  exit 1
}
printf '%s\n' "${release}" >"${stage_dir}/.geo-release"
chmod 0444 "${stage_dir}/.geo-release"
mv -- "${stage_dir}" "${release_dir}"

if [[ -L "${current_link}" ]]; then
  "${release_dir}/scripts/rollback-production-release.sh" --forward "${release}"
else
  [[ ! -e "${current_link}" ]] || {
    printf 'Production current path exists but is not a symlink.\n' >&2
    exit 1
  }
  ln -s "releases/${release}" "${current_link}"
fi

printf 'Production release %s transferred and activated.\n' "${release}"
REMOTE_SCRIPT
remote_payload=$(<"${remote_payload_file}")
rm -f -- "${remote_payload_file}"
remote_payload_file=

# Do not stream the transaction itself over stdin. Docker maintenance tools may
# read stdin, which would otherwise truncate the remaining release operation.
ssh -o ClearAllForwardings=yes "${ssh_host}" \
  "set -Eeuo pipefail; remote_script=\$(mktemp -t geo-transfer.XXXXXX); trap 'rm -f -- \"\$remote_script\"' EXIT; printf '%s' '${remote_payload}' | base64 -d >\"\$remote_script\"; chmod 700 \"\$remote_script\"; bash \"\$remote_script\" '${release}'"

if [[ "${start_requested}" == true ]]; then
  ssh -o ClearAllForwardings=yes "${ssh_host}" \
    /srv/geo-saas/app/current/scripts/start-production.sh
else
  printf 'Start separately with: ssh -o ClearAllForwardings=yes %s /srv/geo-saas/app/current/scripts/start-production.sh\n' \
    "${ssh_host}"
fi
