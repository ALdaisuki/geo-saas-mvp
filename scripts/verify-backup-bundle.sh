#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly DEFAULT_DOCKER_BIN=docker
readonly LOCAL_DOCKER_HOST=unix:///var/run/docker.sock

die() {
  printf 'Backup verification refused: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
Usage: verify-backup-bundle.sh \
  --bundle ABSOLUTE_PATH \
  --checksum-file ABSOLUTE_PATH \
  --expected-release 40_HEX_COMMIT \
  --expected-project COMPOSE_PROJECT \
  [--snapshot-root ABSOLUTE_PATH] \
  [--compose-file ABSOLUTE_PATH] [--docker-bin ABSOLUTE_PATH]
USAGE
  exit 64
}

bundle=""
checksum_file=""
expected_release=""
expected_project=""
snapshot_root=""
retain_snapshot_on_success=false
compose_file=""
docker_bin="${DEFAULT_DOCKER_BIN}"

while (($# > 0)); do
  case "$1" in
    --bundle)
      (($# >= 2)) || usage
      bundle=$2
      shift 2
      ;;
    --checksum-file)
      (($# >= 2)) || usage
      checksum_file=$2
      shift 2
      ;;
    --expected-release)
      (($# >= 2)) || usage
      expected_release=$2
      shift 2
      ;;
    --expected-project)
      (($# >= 2)) || usage
      expected_project=$2
      shift 2
      ;;
    --snapshot-root)
      (($# >= 2)) || usage
      snapshot_root=$2
      shift 2
      ;;
    --compose-file)
      (($# >= 2)) || usage
      compose_file=$2
      shift 2
      ;;
    --docker-bin)
      (($# >= 2)) || usage
      docker_bin=$2
      shift 2
      ;;
    --help|-h)
      usage
      ;;
    *)
      usage
      ;;
  esac
done

[[ -n "${bundle}" && -n "${checksum_file}" && -n "${expected_release}" && -n "${expected_project}" ]] ||
  usage
[[ "${bundle}" == /* && "${checksum_file}" == /* ]] ||
  die 'bundle and checksum paths must be absolute'
[[ -z "${snapshot_root}" || "${snapshot_root}" == /* ]] ||
  die 'snapshot root must be an absolute path'
[[ "${expected_release}" =~ ^[0-9a-f]{40}$ ]] ||
  die 'expected release must be a lowercase 40-character commit'
[[ "${expected_project}" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] ||
  die 'expected Compose project is invalid'
[[ -d "${bundle}" && ! -L "${bundle}" ]] ||
  die 'bundle must be an existing non-symlink directory'
[[ -f "${checksum_file}" && ! -L "${checksum_file}" ]] ||
  die 'checksum file must be an existing non-symlink regular file'

readonly SOURCE_BUNDLE_ABS="$(cd -- "${bundle}" && pwd -P)"
readonly SOURCE_CHECKSUM_PARENT="$(cd -- "$(dirname -- "${checksum_file}")" && pwd -P)"
readonly SOURCE_CHECKSUM_ABS="${SOURCE_CHECKSUM_PARENT}/$(basename -- "${checksum_file}")"
case "${SOURCE_CHECKSUM_ABS}" in
  "${SOURCE_BUNDLE_ABS}"|"${SOURCE_BUNDLE_ABS}"/*)
    die 'checksum file must be stored outside the backup bundle'
    ;;
esac
[[ "${SOURCE_BUNDLE_ABS}" != *','* && "${SOURCE_BUNDLE_ABS}" != *$'\n'* ]] ||
  die 'bundle path contains a character that cannot be mounted safely'

source_backup_id=$(basename -- "${SOURCE_BUNDLE_ABS}")
source_checksum_name=$(basename -- "${SOURCE_CHECKSUM_ABS}")
[[ "${source_backup_id}" != . && "${source_backup_id}" != .. &&
  "${source_checksum_name}" != "${source_backup_id}" ]] ||
  die 'source bundle and checksum names are ambiguous'

require_exact_source_bundle_entries() {
  local entry
  local entry_count=0
  local entry_name

  for entry in "${SOURCE_BUNDLE_ABS}"/* "${SOURCE_BUNDLE_ABS}"/.[!.]* \
    "${SOURCE_BUNDLE_ABS}"/..?*; do
    [[ -e "${entry}" || -L "${entry}" ]] || continue
    ((entry_count += 1))
    entry_name=$(basename -- "${entry}")
    case "${entry_name}" in
      application-files.tar.gz|images.json|manifest.txt|postgres.dump) ;;
      *) die 'bundle contains a missing or unexpected top-level artifact' ;;
    esac
  done
  [[ "${entry_count}" == 4 ]] || die 'bundle must contain exactly four top-level artifacts'
}

require_exact_source_bundle_entries

if [[ -n "${snapshot_root}" ]]; then
  retain_snapshot_on_success=true
  snapshot_parent=$(dirname -- "${snapshot_root}")
  [[ -d "${snapshot_parent}" && ! -L "${snapshot_parent}" ]] ||
    die 'snapshot root parent is missing or unsafe'
  if [[ -e "${snapshot_root}" || -L "${snapshot_root}" ]]; then
    [[ -d "${snapshot_root}" && ! -L "${snapshot_root}" ]] ||
      die 'snapshot root must be a regular directory'
    snapshot_owner=$(stat -c '%u' -- "${snapshot_root}" 2>/dev/null || stat -f '%u' -- "${snapshot_root}")
    snapshot_mode=$(stat -c '%a' -- "${snapshot_root}" 2>/dev/null || stat -f '%Lp' -- "${snapshot_root}")
    [[ "${snapshot_owner}" == "$(id -u)" && "${snapshot_mode}" == 700 ]] ||
      die 'snapshot root must be deploy-owned with mode 700'
    [[ -z "$(find "${snapshot_root}" -mindepth 1 -maxdepth 1 -print -quit)" ]] ||
      die 'snapshot root must be empty'
  else
    mkdir -- "${snapshot_root}"
    chmod 0700 "${snapshot_root}"
  fi
else
  # Docker resolves bind sources in the host daemon namespace, where a systemd
  # PrivateTmp path is intentionally unavailable.
  snapshot_root=$(mktemp -d "${SOURCE_CHECKSUM_PARENT%/}/.geo-backup-snapshot.XXXXXX") ||
    die 'could not create a Docker-visible private bundle snapshot root'
  chmod 0700 "${snapshot_root}"
fi

snapshot_cleanup=true
cleanup_snapshot() {
  if [[ "${snapshot_cleanup}" == true && -n "${snapshot_root}" &&
    -d "${snapshot_root}" && ! -L "${snapshot_root}" ]]; then
    rm -rf -- "${snapshot_root}"
  fi
}
trap cleanup_snapshot EXIT

path_identity() {
  local path=$1
  stat -c '%i' -- "${path}" 2>/dev/null || stat -f '%i' -- "${path}"
}

require_snapshot_metadata() {
  local path=$1
  local expected_mode=$2
  local expected_type=$3
  local metadata
  local owner
  local mode
  local links

  if metadata=$(stat -c '%u %a %h' -- "${path}" 2>/dev/null); then
    :
  else
    metadata=$(stat -f '%u %Lp %l' -- "${path}" 2>/dev/null) ||
      die "could not inspect private snapshot metadata: ${path}"
  fi
  read -r owner mode links <<<"${metadata}"
  [[ "${owner}" == "$(id -u)" && "${mode}" == "${expected_mode}" ]] ||
    die "private snapshot metadata is unsafe: ${path}"
  if [[ "${expected_type}" == directory ]]; then
    [[ -d "${path}" && ! -L "${path}" && "${links}" =~ ^[0-9]+$ ]] &&
      ((links >= 2)) ||
      die "private snapshot directory metadata is unsafe: ${path}"
  else
    [[ -f "${path}" && ! -L "${path}" && "${links}" == 1 ]] ||
      die "private snapshot file metadata is unsafe: ${path}"
  fi
}

fd_identity() {
  local fd=$1
  local fd_path=/proc/self/fd/${fd}
  [[ -e "${fd_path}" ]] || fd_path=/dev/fd/${fd}
  stat -Lc '%i' -- "${fd_path}" 2>/dev/null || stat -Lf '%i' -- "${fd_path}"
}

snapshot_regular_file() {
  local source=$1
  local destination=$2
  local label=$3
  local source_fd=8
  local source_identity
  local opened_identity

  [[ -f "${source}" && ! -L "${source}" ]] || die "${label} is missing or unsafe"
  source_identity=$(path_identity "${source}") || die "could not inspect ${label} identity"
  exec 8<"${source}" || die "could not open ${label}"
  opened_identity=$(fd_identity "${source_fd}") || {
    exec 8<&-
    die "could not inspect opened ${label} identity"
  }
  [[ "${source_identity}" == "$(path_identity "${source}")" &&
    "${source_identity}" == "${opened_identity}" ]] || {
    exec 8<&-
    die "${label} changed while it was opened"
  }
  : >"${destination}"
  chmod 0600 "${destination}"
  cat <&8 >"${destination}" || {
    exec 8<&-
    die "could not snapshot ${label}"
  }
  exec 8<&-
  [[ -f "${destination}" && ! -L "${destination}" ]] || die "snapshotted ${label} is unsafe"
  require_snapshot_metadata "${destination}" 600 regular
}

snapshot_bundle="${snapshot_root}/${source_backup_id}"
snapshot_checksum="${snapshot_root}/${source_checksum_name}"
mkdir -- "${snapshot_bundle}"
chmod 0700 "${snapshot_bundle}"
require_snapshot_metadata "${snapshot_root}" 700 directory
require_snapshot_metadata "${snapshot_bundle}" 700 directory
snapshot_regular_file "${SOURCE_CHECKSUM_ABS}" "${snapshot_checksum}" 'out-of-band checksum file'
for artifact_name in application-files.tar.gz images.json manifest.txt postgres.dump; do
  snapshot_regular_file "${SOURCE_BUNDLE_ABS}/${artifact_name}" \
    "${snapshot_bundle}/${artifact_name}" "bundle artifact ${artifact_name}"
done

readonly BUNDLE_ABS="${snapshot_bundle}"
readonly CHECKSUM_PARENT="${snapshot_root}"
readonly CHECKSUM_ABS="${snapshot_checksum}"

if [[ -z "${compose_file}" ]]; then
  compose_file="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)/compose.yaml"
fi
[[ "${compose_file}" == /* && -f "${compose_file}" && ! -L "${compose_file}" ]] ||
  die 'Compose file must be an absolute, existing, non-symlink regular file'

if [[ "${docker_bin}" == */* ]]; then
  [[ "${docker_bin}" == /* && -x "${docker_bin}" && -f "${docker_bin}" && ! -L "${docker_bin}" ]] ||
    die 'Docker binary override must be an absolute executable non-symlink regular file'
else
  [[ "$(uname -s)" == Linux ]] ||
    die 'backup verification with the production Docker binary runs only on the Linux server, never on macOS'
  command -v "${docker_bin}" >/dev/null 2>&1 || die 'docker is not installed'
fi
command -v sha256sum >/dev/null 2>&1 || die 'sha256sum is unavailable'
command -v tar >/dev/null 2>&1 || die 'tar is unavailable'
for command_name in cat chmod find id mkdir rm stat; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command is unavailable: ${command_name}"
done

expected_entries='application-files.tar.gz
images.json
manifest.txt
postgres.dump'
actual_entries=""
entry_count=0
for entry in "${BUNDLE_ABS}"/* "${BUNDLE_ABS}"/.[!.]* "${BUNDLE_ABS}"/..?*; do
  [[ -e "${entry}" || -L "${entry}" ]] || continue
  ((entry_count += 1))
  entry_name=$(basename -- "${entry}")
  actual_entries="${actual_entries}${entry_name}"$'\n'
done
[[ "${entry_count}" == 4 ]] || die 'bundle must contain exactly four top-level artifacts'
[[ "$(printf '%s' "${actual_entries}" | LC_ALL=C sort)" == "${expected_entries}" ]] ||
  die 'bundle contains a missing or unexpected top-level artifact'

for artifact in postgres.dump application-files.tar.gz manifest.txt images.json; do
  [[ -f "${BUNDLE_ABS}/${artifact}" && ! -L "${BUNDLE_ABS}/${artifact}" ]] ||
    die "bundle artifact is missing, not regular, or is a symlink: ${artifact}"
  [[ -s "${BUNDLE_ABS}/${artifact}" ]] || die "bundle artifact is empty: ${artifact}"
done

manifest_lines=()
while IFS= read -r line || [[ -n "${line}" ]]; do
  manifest_lines[${#manifest_lines[@]}]="${line}"
done <"${BUNDLE_ABS}/manifest.txt"
[[ "$(tail -c 1 -- "${BUNDLE_ABS}/manifest.txt" | wc -l | tr -d '[:space:]')" == 1 ]] ||
  die 'manifest must end with exactly one complete line'

manifest_keys=(
  manifest_version
  backup_id
  created_utc
  release
  compose_project
  scope
  caddy_state_policy
  postgres_dump
  application_archive
  images_file
)
[[ "${#manifest_lines[@]}" == "${#manifest_keys[@]}" ]] ||
  die 'manifest has a missing, duplicate, or unknown field'

manifest_values=()
for ((index = 0; index < ${#manifest_keys[@]}; index += 1)); do
  line=${manifest_lines[${index}]}
  key=${manifest_keys[${index}]}
  [[ "${line}" == "${key}="* ]] ||
    die "manifest field order or name is invalid at ${key}"
  value=${line#*=}
  [[ -n "${value}" && "${value}" != *$'\r'* && "${value}" != *$'\n'* ]] ||
    die "manifest value is empty or malformed: ${key}"
  manifest_values[${index}]="${value}"
done

manifest_version=${manifest_values[0]}
backup_id=${manifest_values[1]}
created_utc=${manifest_values[2]}
release=${manifest_values[3]}
compose_project=${manifest_values[4]}
scope=${manifest_values[5]}
caddy_state_policy=${manifest_values[6]}
postgres_dump=${manifest_values[7]}
application_archive=${manifest_values[8]}
images_file=${manifest_values[9]}

[[ "${manifest_version}" == 2 ]] || die 'manifest version is unsupported'
[[ "${backup_id}" =~ ^[0-9]{8}T[0-9]{6}Z(-[a-z0-9][a-z0-9-]{0,31})?$ ]] ||
  die 'manifest backup_id is invalid'
[[ "$(basename -- "${BUNDLE_ABS}")" == "${backup_id}" ]] ||
  die 'manifest backup_id does not match the bundle directory'
[[ "${created_utc}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
  die 'manifest created_utc is invalid'
[[ "${release}" == "${expected_release}" ]] ||
  die 'manifest release does not match the expected release'
[[ "${compose_project}" == "${expected_project}" ]] ||
  die 'manifest Compose project does not match the expected project'
[[ "${scope}" == postgres,evidence,media,ctrip-runtime ]] ||
  die 'manifest recovery scope is not the complete supported scope'
[[ "${caddy_state_policy}" == excluded-reissue ]] ||
  die 'manifest Caddy state policy must require exclusion and reissuance'
[[ "${postgres_dump}" == postgres.dump ]] || die 'manifest PostgreSQL dump name is invalid'
[[ "${application_archive}" == application-files.tar.gz ]] ||
  die 'manifest application archive name is invalid'
[[ "${images_file}" == images.json ]] || die 'manifest images file name is invalid'

checksum_lines=()
while IFS= read -r line || [[ -n "${line}" ]]; do
  checksum_lines[${#checksum_lines[@]}]="${line}"
done <"${CHECKSUM_ABS}"
[[ "$(tail -c 1 -- "${CHECKSUM_ABS}" | wc -l | tr -d '[:space:]')" == 1 ]] ||
  die 'checksum file must end with exactly one complete line'
[[ "${#checksum_lines[@]}" == 4 ]] ||
  die 'checksum file must contain exactly four artifact digests'

checksum_names=(application-files.tar.gz images.json manifest.txt postgres.dump)
for ((index = 0; index < ${#checksum_names[@]}; index += 1)); do
  checksum_line=${checksum_lines[${index}]}
  checksum_name=${checksum_names[${index}]}
  [[ "${checksum_line}" =~ ^([0-9a-f]{64})\ \ ([A-Za-z0-9._-]+)$ ]] ||
    die 'checksum file contains a malformed line'
  [[ "${BASH_REMATCH[2]}" == "${checksum_name}" ]] ||
    die 'checksum file has a missing, duplicate, reordered, or unknown artifact'
  actual_sha=$(sha256sum -- "${BUNDLE_ABS}/${checksum_name}") ||
    die "could not hash bundle artifact: ${checksum_name}"
  actual_sha=${actual_sha%% *}
  [[ "${actual_sha}" == "${BASH_REMATCH[1]}" ]] ||
    die "checksum mismatch for ${checksum_name}"
done

temporary_root=${TMPDIR:-/tmp}
[[ -d "${temporary_root}" ]] || die 'temporary directory is unavailable'
archive_names=$(mktemp "${temporary_root%/}/geo-backup-names.XXXXXX") ||
  die 'could not allocate archive validation state'
archive_types=$(mktemp "${temporary_root%/}/geo-backup-types.XXXXXX") || {
  rm -f -- "${archive_names}"
  die 'could not allocate archive validation state'
}
archive_normalized=$(mktemp "${temporary_root%/}/geo-backup-normalized.XXXXXX") || {
  rm -f -- "${archive_names}" "${archive_types}"
  die 'could not allocate archive validation state'
}
archive_errors=$(mktemp "${temporary_root%/}/geo-backup-errors.XXXXXX") || {
  rm -f -- "${archive_names}" "${archive_types}" "${archive_normalized}"
  die 'could not allocate archive validation state'
}
cleanup() {
  rm -f -- "${archive_names}" "${archive_types}" "${archive_normalized}" "${archive_errors}"
  cleanup_snapshot
}
trap cleanup EXIT

archive_path="${BUNDLE_ABS}/application-files.tar.gz"
LC_ALL=C tar -tzf "${archive_path}" >"${archive_names}" 2>"${archive_errors}" ||
  die 'application archive cannot be listed'
[[ ! -s "${archive_errors}" ]] || die 'application archive produced warnings while listing'
: >"${archive_errors}"
LC_ALL=C tar -tvzf "${archive_path}" >"${archive_types}" 2>"${archive_errors}" ||
  die 'application archive metadata cannot be listed'
[[ ! -s "${archive_errors}" ]] || die 'application archive produced metadata warnings'

archive_entry_count=0
has_evidence_root=false
has_media_root=false
has_ctrip_runtime_root=false
while IFS= read -r archive_entry || [[ -n "${archive_entry}" ]]; do
  ((archive_entry_count += 1))
  [[ "${archive_entry}" =~ ^(evidence|media|ctrip-runtime)(/[A-Za-z0-9._-]+)*/?$ ]] ||
    die 'application archive contains an unsafe or unexpected path'
  trimmed_entry=${archive_entry%/}
  case "/${trimmed_entry}/" in
    */../*|*/./*) die 'application archive contains a traversal path component' ;;
  esac
  case "${archive_entry}" in
    evidence/) has_evidence_root=true ;;
    media/) has_media_root=true ;;
    ctrip-runtime/) has_ctrip_runtime_root=true ;;
  esac
done <"${archive_names}"
[[ "${archive_entry_count}" -ge 3 ]] || die 'application archive is incomplete'
[[ "${has_evidence_root}" == true && "${has_media_root}" == true &&
  "${has_ctrip_runtime_root}" == true ]] || die 'application archive is missing a required root'
sed 's:/*$::' "${archive_names}" >"${archive_normalized}"
[[ -z "$(LC_ALL=C sort "${archive_normalized}" | uniq -d)" ]] ||
  die 'application archive contains duplicate paths'

while IFS= read -r archive_metadata || [[ -n "${archive_metadata}" ]]; do
  case "${archive_metadata:0:1}" in
    -|d) ;;
    *) die 'application archive contains a link or special filesystem object' ;;
  esac
done <"${archive_types}"
for required_root in evidence media ctrip-runtime; do
  grep -Eq "^d.*[[:space:]]${required_root}/$" "${archive_types}" ||
    die "application archive root is not a directory: ${required_root}"
done
: >"${archive_errors}"
LC_ALL=C tar -xOzf "${archive_path}" >/dev/null 2>"${archive_errors}" ||
  die 'application archive payload cannot be fully decompressed'
[[ ! -s "${archive_errors}" ]] || die 'application archive produced payload warnings'

postgres_image=$(sed -n 's/^x-postgres-image: &postgres-image \([^[:space:]]*\)$/\1/p' "${compose_file}")
[[ "${postgres_image}" =~ ^postgres:[0-9]+([.][0-9]+)*-[a-z0-9-]+@sha256:[0-9a-f]{64}$ ]] ||
  die 'could not resolve one digest-pinned PostgreSQL image from the Compose file'

docker_local() {
  env -i \
    HOME="${HOME:-/tmp}" \
    PATH="${PATH}" \
    DOCKER_HOST="${LOCAL_DOCKER_HOST}" \
    COMPOSE_DISABLE_ENV_FILE=1 \
    "${docker_bin}" "$@"
}

docker_local image inspect "${postgres_image}" >/dev/null 2>&1 ||
  die 'the digest-pinned PostgreSQL verifier image is not present locally'
verifier_uid=$(id -u)
verifier_gid=$(id -g)
[[ "${verifier_uid}" =~ ^[0-9]+$ && "${verifier_gid}" =~ ^[0-9]+$ ]] ||
  die 'could not resolve the private snapshot owner identity'
docker_local run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 64 \
  --user "${verifier_uid}:${verifier_gid}" \
  --mount "type=bind,src=${BUNDLE_ABS}/postgres.dump,dst=/backup/postgres.dump,readonly" \
  "${postgres_image}" pg_restore --list /backup/postgres.dump >/dev/null ||
  die 'pg_restore rejected the PostgreSQL custom-format dump'

if [[ "${retain_snapshot_on_success}" == true ]]; then
  snapshot_cleanup=false
fi
printf 'Backup bundle verified: id=%s release=%s project=%s\n' \
  "${backup_id}" "${release}" "${compose_project}"
if [[ "${retain_snapshot_on_success}" == true ]]; then
  printf 'Verified private snapshot: %s\n' "${BUNDLE_ABS}"
fi
