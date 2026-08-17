#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly ACTION=${1:-preview}
readonly APP_ROOT=/srv/geo-saas/app
readonly RELEASES_ROOT=${APP_ROOT}/releases
readonly CURRENT_LINK=${APP_ROOT}/current
readonly SECRET_ROOT=/srv/geo-saas/secrets
readonly ENV_FILE=${GEO_ENV_FILE:-${SECRET_ROOT}/geo.env}
readonly DEPLOYMENT_LOCK_FILE=${SECRET_ROOT}/.geo-deployment.lock
readonly BACKUP_MAINTENANCE_LOCK=${SECRET_ROOT}/.geo-backup-maintenance.lock
readonly RESTORE_INHIBIT_MARKER=${SECRET_ROOT}/.geo-restore-inhibit
readonly RESTORE_CLEARANCE_GATE=${SECRET_ROOT}/.geo-restore-inhibit-clearance
readonly RELEASE_KEEP_RECENT=${GEO_RELEASE_KEEP_RECENT:-5}
readonly RELEASE_MIN_AGE_DAYS=${GEO_RELEASE_MIN_AGE_DAYS:-7}
readonly IMAGE_KEEP_RECENT=${GEO_IMAGE_KEEP_RECENT:-2}
readonly CACHE_MIN_AGE_HOURS=${GEO_CACHE_MIN_AGE_HOURS:-24}
readonly CACHE_RESERVED_SPACE=${GEO_CACHE_RESERVED_SPACE:-8GB}
readonly CACHE_MAX_USED_SPACE=${GEO_CACHE_MAX_USED_SPACE:-12GB}
readonly CACHE_MIN_FREE_SPACE=${GEO_CACHE_MIN_FREE_SPACE:-20GB}
readonly CONVERGENCE_TIMEOUT_SECONDS=420
readonly GEO_IMAGE_REPOSITORIES=(
  geo-saas-api
  geo-saas-worker
  geo-saas-agent-mcp
  geo-saas-ctrip-bridge
  geo-saas-web
  geo-saas-db-tools
  geo-saas-browser-host
)

die() {
  printf 'Production artifact pruning refused: %s\n' "$1" >&2
  exit 1
}

usage() {
  printf 'Usage: prune-production-artifacts.sh preview\n' >&2
  printf '       prune-production-artifacts.sh apply --confirm-current <full-release-sha>\n' >&2
  exit 64
}

[[ "${ACTION}" == preview || "${ACTION}" == apply ]] || usage
confirm_current=
if [[ "${ACTION}" == apply ]]; then
  [[ "${2:-}" == --confirm-current && -n "${3:-}" && -z "${4:-}" ]] || usage
  confirm_current=$3
fi

[[ "${RELEASE_KEEP_RECENT}" =~ ^[1-9][0-9]{0,2}$ ]] || die 'GEO_RELEASE_KEEP_RECENT must be 1..999'
[[ "${RELEASE_MIN_AGE_DAYS}" =~ ^[1-9][0-9]{0,2}$ ]] || die 'GEO_RELEASE_MIN_AGE_DAYS must be 1..999'
[[ "${IMAGE_KEEP_RECENT}" =~ ^[1-9][0-9]{0,2}$ ]] || die 'GEO_IMAGE_KEEP_RECENT must be 1..999'
[[ "${CACHE_MIN_AGE_HOURS}" =~ ^[1-9][0-9]{0,3}$ ]] || die 'GEO_CACHE_MIN_AGE_HOURS must be 1..9999'
for space_value in "${CACHE_RESERVED_SPACE}" "${CACHE_MAX_USED_SPACE}" "${CACHE_MIN_FREE_SPACE}"; do
  [[ "${space_value}" =~ ^[1-9][0-9]*(MB|GB)$ ]] ||
    die 'cache space limits must be positive MB or GB values'
done

[[ "$(uname -s)" == Linux ]] || die 'artifact pruning runs only on Linux'
((EUID != 0)) || die 'run artifact pruning as the non-root deploy user'
for command_name in basename chmod cut date docker find flock getent readlink realpath rm sort stat sync timeout; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command is unavailable: ${command_name}"
done
[[ -S /var/run/docker.sock ]] || die 'the local Docker socket is unavailable'
[[ -d "${SECRET_ROOT}" && ! -L "${SECRET_ROOT}" ]] || die 'production secret root is missing or unsafe'
[[ "$(stat -c '%u:%a' -- "${SECRET_ROOT}")" == "$(id -u):700" ]] ||
  die 'production secret root must be deploy-owned with mode 700'
[[ -d "${RELEASES_ROOT}" && ! -L "${RELEASES_ROOT}" ]] || die 'release root is missing or unsafe'
[[ -L "${CURRENT_LINK}" && -d "${CURRENT_LINK}" ]] || die 'current release link is missing or unsafe'
[[ ! -e "${RESTORE_INHIBIT_MARKER}" && ! -L "${RESTORE_INHIBIT_MARKER}" ]] ||
  die 'pruning is inhibited by the persistent incident-restore marker'
[[ ! -e "${RESTORE_CLEARANCE_GATE}" && ! -L "${RESTORE_CLEARANCE_GATE}" ]] ||
  die 'pruning is inhibited by an incomplete restore clearance transaction'
for transaction_file in \
  "${SECRET_ROOT}/.geo-deployment-journal" \
  "${SECRET_ROOT}/.geo-deployment-journal.stage" \
  "${SECRET_ROOT}/.geo.env.rollback-stage" \
  "${SECRET_ROOT}/.commissioning.env.rollback-stage" \
  "${APP_ROOT}/.current.rollback-stage"; do
  [[ ! -e "${transaction_file}" && ! -L "${transaction_file}" ]] ||
    die "a deployment transaction is active: ${transaction_file}"
done

readonly DEPLOY_HOME="$(getent passwd "$(id -u)" | cut -d: -f6)"
[[ -d "${DEPLOY_HOME}" ]] || die 'deploy user home directory is unavailable'
readonly CURRENT_RELEASE="$(readlink "${CURRENT_LINK}")"
[[ "${CURRENT_RELEASE}" =~ ^releases/([0-9a-f]{40})$ ]] ||
  die 'current must point to releases/<full-sha>'
readonly CURRENT_SHA=${BASH_REMATCH[1]}
readonly CURRENT_ROOT=${RELEASES_ROOT}/${CURRENT_SHA}
[[ -d "${CURRENT_ROOT}" && ! -L "${CURRENT_ROOT}" ]] || die 'current release directory is missing or unsafe'
[[ -f "${CURRENT_ROOT}/.geo-release" && ! -L "${CURRENT_ROOT}/.geo-release" ]] ||
  die 'current release marker is missing or unsafe'
[[ "$(stat -c '%u:%a:%h' -- "${CURRENT_ROOT}/.geo-release")" == "$(id -u):444:1" ]] ||
  die 'current release marker owner, mode, or link count is invalid'
IFS= read -r current_marker <"${CURRENT_ROOT}/.geo-release"
[[ "${current_marker}" == "${CURRENT_SHA}" ]] || die 'current release marker does not match current'
[[ "${confirm_current}" == "" || "${confirm_current}" == "${CURRENT_SHA}" ]] ||
  die 'current release changed after the confirmation was issued'

docker_local() {
  env -i HOME="${DEPLOY_HOME}" PATH="${PATH}" DOCKER_HOST=unix:///var/run/docker.sock \
    COMPOSE_DISABLE_ENV_FILE=1 docker "$@"
}

validate_lock_file() {
  local path=$1
  if [[ -e "${path}" || -L "${path}" ]]; then
    [[ -f "${path}" && ! -L "${path}" ]] || die "lock file is unsafe: ${path}"
    [[ "$(stat -c '%u:%a:%h' -- "${path}")" == "$(id -u):600:1" ]] ||
      die "lock file owner, mode, or link count is invalid: ${path}"
  fi
}

validate_lock_file "${DEPLOYMENT_LOCK_FILE}"
validate_lock_file "${BACKUP_MAINTENANCE_LOCK}"
exec 8>>"${BACKUP_MAINTENANCE_LOCK}"
chmod 0600 "${BACKUP_MAINTENANCE_LOCK}"
flock --nonblock 8 || die 'backup maintenance is active'
exec 9>>"${DEPLOYMENT_LOCK_FILE}"
chmod 0600 "${DEPLOYMENT_LOCK_FILE}"
flock --nonblock 9 || die 'deployment maintenance is active'

readonly CONVERGENCE_MANAGER=${CURRENT_ROOT}/scripts/manage-production-convergence.sh
[[ -f "${CONVERGENCE_MANAGER}" && ! -L "${CONVERGENCE_MANAGER}" && -x "${CONVERGENCE_MANAGER}" ]] ||
  die 'active release convergence manager is missing or unsafe'

verify_convergence() {
  timeout --signal=TERM --kill-after=5s "${CONVERGENCE_TIMEOUT_SECONDS}s" \
    env -i HOME="${DEPLOY_HOME}" PATH="${PATH}" GEO_ENV_FILE="${ENV_FILE}" \
      GEO_DEPLOYMENT_LOCK_FD=9 "${CONVERGENCE_MANAGER}" verify >/dev/null ||
    die 'production convergence verification failed'
}

declare -A protected_releases=()
declare -A validated_releases=()
declare -A protected_image_revisions=()
declare -A protected_image_ids=()
declare -a release_rows=()
declare -a release_candidates=()
declare -a release_review=()
declare -a image_candidates=()

protected_releases["${CURRENT_SHA}"]=current
protected_image_revisions["${CURRENT_SHA}"]=current

mapfile -t release_rows < <(
  find -P "${RELEASES_ROOT}" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' | sort -nr
)

recent_release_count=0
recent_image_count=0
for release_row in "${release_rows[@]}"; do
  release_name=${release_row#* }
  [[ "${release_name}" =~ ^[0-9a-f]{40}$ ]] || continue
  release_path=${RELEASES_ROOT}/${release_name}
  [[ -d "${release_path}" && ! -L "${release_path}" ]] || {
    release_review+=("${release_name}")
    continue
  }
  [[ "$(stat -c '%u' -- "${release_path}")" == "$(id -u)" ]] || {
    release_review+=("${release_name}")
    continue
  }
  [[ -f "${release_path}/.geo-release" && ! -L "${release_path}/.geo-release" ]] || {
    release_review+=("${release_name}")
    continue
  }
  [[ "$(stat -c '%u:%a:%h' -- "${release_path}/.geo-release")" == "$(id -u):444:1" ]] || {
    release_review+=("${release_name}")
    continue
  }
  IFS= read -r marker_value <"${release_path}/.geo-release"
  [[ "${marker_value}" == "${release_name}" ]] || {
    release_review+=("${release_name}")
    continue
  }
  validated_releases["${release_name}"]=true

  if [[ "${release_name}" != "${CURRENT_SHA}" && "${recent_release_count}" -lt "${RELEASE_KEEP_RECENT}" ]]; then
    protected_releases["${release_name}"]=recent
    ((recent_release_count += 1))
  fi
  if [[ "${release_name}" != "${CURRENT_SHA}" && "${recent_image_count}" -lt "${IMAGE_KEEP_RECENT}" ]]; then
    protected_image_revisions["${release_name}"]=recent
    ((recent_image_count += 1))
  fi
done

mapfile -t container_ids < <(docker_local ps -aq)
for container_id in "${container_ids[@]}"; do
  [[ -n "${container_id}" ]] || continue
  container_image=$(docker_local inspect --format '{{.Image}}' "${container_id}")
  [[ "${container_image}" =~ ^sha256:[0-9a-f]{64}$ ]] && protected_image_ids["${container_image}"]=container
  while IFS= read -r mount_source; do
    release_prefix=${RELEASES_ROOT}/
    case "${mount_source}" in
      "${release_prefix}"*)
        release_suffix=${mount_source#"${release_prefix}"}
        mounted_release=${release_suffix%%/*}
        [[ "${mounted_release}" =~ ^[0-9a-f]{40}$ ]] && protected_releases["${mounted_release}"]=mounted
        ;;
    esac
  done < <(docker_local inspect --format '{{range .Mounts}}{{println .Source}}{{end}}' "${container_id}")
done

release_cutoff=$(( $(date +%s) - RELEASE_MIN_AGE_DAYS * 86400 ))
for release_row in "${release_rows[@]}"; do
  release_name=${release_row#* }
  [[ "${release_name}" =~ ^[0-9a-f]{40}$ ]] || continue
  [[ -n "${validated_releases[${release_name}]+present}" ]] || continue
  [[ -z "${protected_releases[${release_name}]+present}" ]] || continue
  release_path=${RELEASES_ROOT}/${release_name}
  release_mtime=$(stat -c '%Y' -- "${release_path}")
  ((release_mtime <= release_cutoff)) || continue
  release_candidates+=("${release_name}")
done

mapfile -t image_rows < <(docker_local image ls --format '{{.Repository}} {{.Tag}}')
for image_row in "${image_rows[@]}"; do
  image_repository=${image_row%% *}
  image_tag=${image_row#* }
  [[ "${image_tag}" =~ ^[0-9a-f]{40}$ ]] || continue
  repository_is_geo=false
  for geo_repository in "${GEO_IMAGE_REPOSITORIES[@]}"; do
    [[ "${image_repository}" == "${geo_repository}" ]] && repository_is_geo=true
  done
  [[ "${repository_is_geo}" == true ]] || continue
  image_ref=${image_repository}:${image_tag}
  image_id=$(docker_local image inspect --format '{{.Id}}' "${image_ref}")
  image_revision=$(docker_local image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${image_ref}")
  [[ "${image_revision}" == "${image_tag}" ]] || die "image revision label does not match tag: ${image_ref}"
  [[ -z "${protected_image_revisions[${image_tag}]+present}" &&
    -z "${protected_image_ids[${image_id}]+present}" ]] || continue
  image_candidates+=("${image_ref}")
done

printf 'Production artifact pruning %s\n' "${ACTION}"
printf 'current_release=%s\n' "${CURRENT_SHA}"
printf 'release_policy=keep_current+recent_%s+mounted;min_age_days=%s\n' \
  "${RELEASE_KEEP_RECENT}" "${RELEASE_MIN_AGE_DAYS}"
printf 'image_policy=keep_current+recent_%s+container_images\n' "${IMAGE_KEEP_RECENT}"
printf 'cache_policy=until_%sh;reserved=%s;max_used=%s;min_free=%s\n' \
  "${CACHE_MIN_AGE_HOURS}" "${CACHE_RESERVED_SPACE}" "${CACHE_MAX_USED_SPACE}" "${CACHE_MIN_FREE_SPACE}"
printf 'release_candidates=%s\n' "${#release_candidates[@]}"
printf 'release_review=%s\n' "${#release_review[@]}"
printf 'image_candidates=%s\n' "${#image_candidates[@]}"
for release_name in "${release_candidates[@]}"; do printf 'release_delete=%s\n' "${release_name}"; done
for release_name in "${release_review[@]}"; do printf 'release_manual_review=%s\n' "${release_name}"; done
for image_ref in "${image_candidates[@]}"; do printf 'image_untag=%s\n' "${image_ref}"; done

if [[ "${ACTION}" == preview ]]; then
  verify_convergence
  printf 'Preview complete; no production artifacts were changed.\n'
  exit 0
fi

verify_convergence
for release_name in "${release_candidates[@]}"; do
  [[ "${release_name}" != "${CURRENT_SHA}" ]] || die 'current release entered the deletion set'
  release_path=${RELEASES_ROOT}/${release_name}
  [[ -d "${release_path}" && ! -L "${release_path}" ]] || die "release candidate changed: ${release_path}"
  [[ "${release_name}" != "$(basename -- "$(realpath -e -- "${CURRENT_LINK}")")" ]] ||
    die 'current release changed into the deletion set'
  rm -rf --one-file-system -- "${release_path}"
done
sync -f "${RELEASES_ROOT}"

for image_ref in "${image_candidates[@]}"; do
  docker_local image rm --no-prune "${image_ref}" >/dev/null ||
    die "could not remove image tag: ${image_ref}"
done

docker_local buildx prune \
  --filter "until=${CACHE_MIN_AGE_HOURS}h" \
  --reserved-space "${CACHE_RESERVED_SPACE}" \
  --max-used-space "${CACHE_MAX_USED_SPACE}" \
  --min-free-space "${CACHE_MIN_FREE_SPACE}" \
  --force
verify_convergence
printf 'Production artifact pruning applied and convergence reverified.\n'
