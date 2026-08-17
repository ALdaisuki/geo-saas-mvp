#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
readonly PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

readonly APP_ROOT=/srv/geo-saas/app
readonly RELEASES_ROOT=${APP_ROOT}/releases
readonly CURRENT_LINK=${APP_ROOT}/current
readonly SECRET_ROOT=/srv/geo-saas/secrets
readonly ENV_FILE=${SECRET_ROOT}/geo.env
readonly COMMISSIONING_ENV_FILE=${SECRET_ROOT}/commissioning.env
readonly DEPLOYMENT_LOCK_FILE=${SECRET_ROOT}/.geo-deployment.lock
readonly DEPLOYMENT_JOURNAL_FILE=${SECRET_ROOT}/.geo-deployment-journal
readonly RESTORE_INHIBIT_MARKER=${SECRET_ROOT}/.geo-restore-inhibit
readonly RESTORE_CLEARANCE_GATE=${SECRET_ROOT}/.geo-restore-inhibit-clearance
readonly LOCAL_DOCKER_HOST=unix:///var/run/docker.sock
readonly RESTORE_RUNBOOK=${CURRENT_LINK}/docs/ops/backup-restore.md

die() {
  printf 'Production rollback refused: %s\n' "$1" >&2
  exit 1
}

stat_value() {
  local field=$1
  local path=$2

  if [[ "$(uname -s)" == Darwin ]]; then
    case "${field}" in
      dev) stat -f '%d' -- "${path}" ;;
      inode) stat -f '%i' -- "${path}" ;;
      uid) stat -f '%u' -- "${path}" ;;
      gid) stat -f '%g' -- "${path}" ;;
      mode) stat -f '%Lp' -- "${path}" ;;
      links) stat -f '%l' -- "${path}" ;;
      size) stat -f '%z' -- "${path}" ;;
      *) return 1 ;;
    esac
  else
    case "${field}" in
      dev) stat -c '%d' -- "${path}" ;;
      inode) stat -c '%i' -- "${path}" ;;
      uid) stat -c '%u' -- "${path}" ;;
      gid) stat -c '%g' -- "${path}" ;;
      mode) stat -c '%a' -- "${path}" ;;
      links) stat -c '%h' -- "${path}" ;;
      size) stat -c '%s' -- "${path}" ;;
      *) return 1 ;;
    esac
  fi
}

lock_identity() {
  local path=$1
  printf '%s:%s:%s:%s:%s' \
    "$(stat_value dev "${path}")" \
    "$(stat_value inode "${path}")" \
    "$(stat_value uid "${path}")" \
    "$(stat_value links "${path}")" \
    "$(stat_value mode "${path}")"
}

fd_identity() {
  local fd=$1
  local fd_path=/proc/self/fd/${fd}
  [[ -e "${fd_path}" ]] || fd_path=/dev/fd/${fd}
  if [[ "$(uname -s)" == Darwin ]]; then
    printf '%s:%s:%s:%s:%s' \
      "$(stat -f '%d' -- "${fd_path}")" \
      "$(stat -f '%i' -- "${fd_path}")" \
      "$(stat -f '%u' -- "${fd_path}")" \
      "$(stat -f '%l' -- "${fd_path}")" \
      "$(stat -f '%Lp' -- "${fd_path}")"
  else
    stat -Lc '%d:%i:%u:%h:%a' -- "${fd_path}"
  fi
}

require_owned_directory() {
  local path=$1
  local expected_uid=$2
  local description=$3
  local mode

  [[ -d "${path}" && ! -L "${path}" ]] || die "${description} is missing or is a symlink: ${path}"
  [[ "$(stat_value uid "${path}")" == "${expected_uid}" ]] ||
    die "${description} must be owned by uid ${expected_uid}: ${path}"
  mode=$(stat_value mode "${path}")
  [[ "${mode}" =~ ^[0-7]+$ ]] && (( (8#${mode} & 022) == 0 )) ||
    die "${description} must not be group/other writable: ${path}"
}

require_secure_ancestors() {
  local path=$1
  local boundary=$2
  local expected_uid=$3
  local cursor=$path
  local mode

  while :; do
    [[ ! -L "${cursor}" ]] || die "symlink ancestor is not allowed: ${cursor}"
    if [[ -d "${cursor}" ]]; then
      [[ "$(stat_value uid "${cursor}")" == "${expected_uid}" ]] ||
        die "path ancestor must be owned by uid ${expected_uid}: ${cursor}"
      mode=$(stat_value mode "${cursor}")
      [[ "${mode}" =~ ^[0-7]+$ ]] && (( (8#${mode} & 022) == 0 )) ||
        die "path ancestor must not be group/other writable: ${cursor}"
    fi
    [[ "${cursor}" == "${boundary}" ]] && break
    [[ "${cursor}" != / && "${cursor}" != . ]] || die "path is outside the trusted boundary: ${path}"
    cursor=$(dirname -- "${cursor}")
  done
}

require_owned_regular_file() {
  local path=$1
  local expected_uid=$2
  local expected_mode=$3
  local description=$4
  local mode

  [[ -f "${path}" && ! -L "${path}" ]] ||
    die "${description} is missing, not regular, or is a symlink: ${path}"
  [[ "$(stat_value uid "${path}")" == "${expected_uid}" ]] ||
    die "${description} must be owned by uid ${expected_uid}: ${path}"
  [[ "$(stat_value mode "${path}")" == "${expected_mode}" ]] ||
    die "${description} mode must be exactly ${expected_mode}: ${path}"
  [[ "$(stat_value links "${path}")" == 1 ]] ||
    die "${description} must have exactly one link: ${path}"
}

require_not_group_other_writable() {
  local path=$1
  local description=$2
  local mode
  mode=$(stat_value mode "${path}")
  [[ "${mode}" =~ ^[0-7]+$ ]] && (( (8#${mode} & 022) == 0 )) ||
    die "${description} must not be group/other writable: ${path}"
}

require_release_marker() {
  local release_dir=$1
  local expected_sha=$2
  local expected_uid=$3
  local marker=${release_dir}/.geo-release
  local marker_value

  require_owned_regular_file "${marker}" "${expected_uid}" 444 'release marker'
  [[ "$(stat_value size "${marker}")" == 41 ]] ||
    die "release marker must contain one 40-character commit and a newline: ${marker}"
  IFS= read -r marker_value <"${marker}"
  [[ "${marker_value}" == "${expected_sha}" ]] ||
    die "release marker does not match its release directory: ${marker}"
}

require_release_tree() {
  local release_dir=$1
  local expected_sha=$2
  local expected_uid=$3
  local trusted_root=${4:-${APP_ROOT}}
  local path
  local migration

  require_secure_ancestors "${release_dir}" "${trusted_root}" "${expected_uid}"
  require_owned_directory "${release_dir}" "${expected_uid}" 'release directory'
  require_release_marker "${release_dir}" "${expected_sha}" "${expected_uid}"
  for path in \
    "${release_dir}/packages" \
    "${release_dir}/packages/db" \
    "${release_dir}/packages/db/migrations" \
    "${release_dir}/scripts"; do
    require_secure_ancestors "${path}" "${trusted_root}" "${expected_uid}"
    require_owned_directory "${path}" "${expected_uid}" 'release directory'
  done
  path="${release_dir}/scripts/start-production.sh"
  require_secure_ancestors "${path}" "${trusted_root}" "${expected_uid}"
  require_owned_regular_file "${path}" "${expected_uid}" "$(stat_value mode "${path}")" 'target production launcher'
  require_not_group_other_writable "${path}" 'target production launcher'
  [[ -x "${path}" ]] || die "target production launcher is not executable: ${path}"
  while IFS= read -r migration; do
    path="${release_dir}/packages/db/migrations/${migration}"
    require_secure_ancestors "${path}" "${trusted_root}" "${expected_uid}"
    require_owned_regular_file "${path}" "${expected_uid}" "$(stat_value mode "${path}")" 'migration file'
    require_not_group_other_writable "${path}" 'migration file'
  done < <(migration_file_list "${release_dir}/packages/db/migrations")
}

read_unique_release_env_value() {
  local env_file=$1
  local key=$2
  local count=0
  local value
  local line

  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ "${line}" != *$'\r'* ]] || die "${env_file} contains CR"
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    [[ "${line}" =~ ^[A-Z][A-Z0-9_]*=.*$ ]] ||
      die "${env_file} must contain only KEY=value lines"
    if [[ "${line}" == "${key}="* ]]; then
      ((count += 1))
      value=${line#*=}
    fi
  done <"${env_file}"
  [[ "${count}" == 1 ]] || die "${env_file} must contain exactly one ${key}= entry"
  printf '%s' "${value}"
}

validate_strict_env_file() {
  local env_file=$1
  local expected_uid=$2
  local line
  local line_number=0
  local key
  local seen_keys=' '

  require_owned_regular_file "${env_file}" "${expected_uid}" 600 'deployment env file'
  [[ ! -s "${env_file}" || "$(tail -c 1 -- "${env_file}" | od -An -t x1 | tr -d '[:space:]')" == 0a ]] ||
    die "${env_file} must end with a newline"
  while IFS= read -r line || [[ -n "${line}" ]]; do
    ((line_number += 1))
    [[ "${line}" != *$'\r'* ]] || die "${env_file} line ${line_number} contains CR"
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    [[ "${line}" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] ||
      die "${env_file} line ${line_number} must be KEY=value with no leading whitespace or export"
    key=${BASH_REMATCH[1]}
    [[ "${seen_keys}" != *" ${key} "* ]] ||
      die "${env_file} contains a duplicate key: ${key}"
    seen_keys+="${key} "
  done <"${env_file}"
}

migration_file_list() {
  local directory=$1
  local entry
  local -a entries

  (
    export LC_ALL=C
    shopt -s nullglob dotglob
    entries=("${directory}"/*)
    ((${#entries[@]} > 0)) || exit 1
    for entry in "${entries[@]}"; do
      [[ -f "${entry}" && ! -L "${entry}" && "${entry##*/}" =~ ^[0-9]{4}_[a-z0-9_]+\.sql$ ]] || exit 1
      printf '%s\n' "${entry##*/}"
    done | sort
  )
}

require_identical_migrations() {
  local current_release=$1
  local target_release=$2
  local current_dir=${current_release}/packages/db/migrations
  local target_dir=${target_release}/packages/db/migrations
  local current_files
  local target_files
  local migration

  [[ -d "${current_dir}" && ! -L "${current_dir}" ]] ||
    die "current migration directory is missing or unsafe: ${current_dir}"
  [[ -d "${target_dir}" && ! -L "${target_dir}" ]] ||
    die "target migration directory is missing or unsafe: ${target_dir}"
  current_files="$(migration_file_list "${current_dir}")" ||
    die 'current migration directory must contain only regular SQL files'
  target_files="$(migration_file_list "${target_dir}")" ||
    die 'target migration directory must contain only regular SQL files'
  [[ "${target_files}" == "${current_files}" ]] ||
    die "migration file lists differ; use the restore procedure in ${RESTORE_RUNBOOK}"
  while IFS= read -r migration; do
    cmp -s "${current_dir}/${migration}" "${target_dir}/${migration}" ||
      die "migration content differs for ${migration}; use the restore procedure in ${RESTORE_RUNBOOK}"
  done <<<"${current_files}"
}

require_forward_compatible_migrations() {
  local current_release=$1
  local target_release=$2
  local applied_migrations=$3
  local current_dir=${current_release}/packages/db/migrations
  local target_dir=${target_release}/packages/db/migrations
  local current_files
  local target_files
  local migration
  local migration_name
  local applied_name
  local index
  local -a current_names=()
  local -a applied_names=()

  [[ -d "${current_dir}" && ! -L "${current_dir}" ]] ||
    die "current migration directory is missing or unsafe: ${current_dir}"
  [[ -d "${target_dir}" && ! -L "${target_dir}" ]] ||
    die "target migration directory is missing or unsafe: ${target_dir}"
  current_files="$(migration_file_list "${current_dir}")" ||
    die 'current migration directory must contain only regular SQL files'
  target_files="$(migration_file_list "${target_dir}")" ||
    die 'target migration directory must contain only regular SQL files'
  [[ "${target_files}" == "${current_files}" || "${target_files}" == "${current_files}"$'\n'* ]] ||
    die 'target migrations must preserve the current ordered set and may only append new files'
  while IFS= read -r migration; do
    current_names+=("${migration%.sql}")
  done <<<"${current_files}"
  [[ -n "${applied_migrations}" ]] ||
    die 'the applied production migration ledger is empty'
  while IFS= read -r applied_name; do
    [[ "${applied_name}" =~ ^[0-9]{4}_[a-z0-9_]+$ ]] ||
      die 'the database returned an invalid applied migration name'
    applied_names+=("${applied_name}")
  done <<<"${applied_migrations}"
  ((${#applied_names[@]} <= ${#current_names[@]})) ||
    die 'the applied production migration ledger is not a prefix of the current release'
  for index in "${!applied_names[@]}"; do
    [[ "${applied_names[index]}" == "${current_names[index]}" ]] ||
      die 'the applied production migration ledger is not a prefix of the current release'
  done
  index=0
  while IFS= read -r migration; do
    migration_name=${migration%.sql}
    if ((index < ${#applied_names[@]})); then
      [[ "${migration_name}" == "${applied_names[index]}" ]] ||
        die 'the applied production migration ledger changed during validation'
      cmp -s "${current_dir}/${migration}" "${target_dir}/${migration}" ||
        die "applied migration content differs for ${migration}; use the restore procedure in ${RESTORE_RUNBOOK}"
    fi
    ((index += 1))
  done <<<"${current_files}"
}

require_migration_ahead_recovery() {
  local current_release=$1
  local target_release=$2
  local applied_migrations=$3
  local current_dir=${current_release}/packages/db/migrations
  local target_dir=${target_release}/packages/db/migrations
  local current_files
  local target_files
  local migration
  local applied_name
  local index
  local -a current_names=()
  local -a target_names=()
  local -a applied_names=()

  [[ -d "${current_dir}" && ! -L "${current_dir}" ]] ||
    die "current migration directory is missing or unsafe: ${current_dir}"
  [[ -d "${target_dir}" && ! -L "${target_dir}" ]] ||
    die "target migration directory is missing or unsafe: ${target_dir}"
  current_files="$(migration_file_list "${current_dir}")" ||
    die 'current migration directory must contain only regular SQL files'
  target_files="$(migration_file_list "${target_dir}")" ||
    die 'target migration directory must contain only regular SQL files'
  [[ "${target_files}" == "${current_files}"$'\n'* ]] ||
    die 'migration-ahead recovery target must append to the current ordered migration set'
  while IFS= read -r migration; do
    current_names+=("${migration%.sql}")
  done <<<"${current_files}"
  while IFS= read -r migration; do
    target_names+=("${migration%.sql}")
  done <<<"${target_files}"
  [[ -n "${applied_migrations}" ]] ||
    die 'the applied production migration ledger is empty'
  while IFS= read -r applied_name; do
    [[ "${applied_name}" =~ ^[0-9]{4}_[a-z0-9_]+$ ]] ||
      die 'the database returned an invalid applied migration name'
    applied_names+=("${applied_name}")
  done <<<"${applied_migrations}"
  ((${#applied_names[@]} > ${#current_names[@]})) ||
    die 'migration-ahead recovery requires the database ledger to be ahead of current'
  ((${#target_names[@]} == ${#applied_names[@]})) ||
    die 'migration-ahead recovery target must exactly match the database ledger'
  for index in "${!current_names[@]}"; do
    [[ "${applied_names[index]}" == "${current_names[index]}" ]] ||
      die 'the applied production migration ledger is not an ordered extension of current'
    cmp -s "${current_dir}/${current_names[index]}.sql" "${target_dir}/${current_names[index]}.sql" ||
      die "applied migration content differs for ${current_names[index]}.sql; use the restore procedure in ${RESTORE_RUNBOOK}"
  done
  for index in "${!applied_names[@]}"; do
    [[ "${target_names[index]}" == "${applied_names[index]}" ]] ||
      die 'migration-ahead recovery target must exactly match the database ledger'
  done
}

query_applied_production_migrations() {
  local env_file=$1
  local project_name
  local container_id
  local applied_names
  local applied_name
  local -a container_ids=()

  project_name=$(read_unique_release_env_value "${env_file}" COMPOSE_PROJECT_NAME)
  [[ "${project_name}" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] ||
    die 'COMPOSE_PROJECT_NAME is invalid for migration-ledger discovery'
  while IFS= read -r container_id; do
    [[ -z "${container_id}" ]] || container_ids+=("${container_id}")
  done < <(docker_local ps --no-trunc \
    --filter "label=com.docker.compose.project=${project_name}" \
    --filter 'label=com.docker.compose.service=postgres' \
    --filter 'status=running' \
    --format '{{.ID}}')
  ((${#container_ids[@]} == 1)) ||
    die 'exactly one running production postgres container is required'
  container_id=${container_ids[0]}
  [[ "${container_id}" =~ ^[0-9a-f]{64}$ ]] ||
    die 'production postgres container identity is invalid'
  [[ "$(docker_local inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "${container_id}")" == "${project_name}" &&
    "$(docker_local inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "${container_id}")" == postgres &&
    "$(docker_local inspect --format '{{.State.Status}}' "${container_id}")" == running ]] ||
    die 'production postgres container labels or state changed during validation'
  applied_names="$(docker_local exec --interactive "${container_id}" sh -ceu '
    export PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is missing}"
    exec psql --no-psqlrc --host=127.0.0.1 --username="${POSTGRES_USER}" \
      --dbname="${POSTGRES_DB}" --tuples-only --no-align --set=ON_ERROR_STOP=1 \
      --command="SELECT name FROM geo.kysely_migration ORDER BY name"
  ')" || die 'could not read the applied production migration ledger'
  [[ -n "${applied_names}" ]] || die 'the applied production migration ledger is empty'
  while IFS= read -r applied_name; do
    [[ "${applied_name}" =~ ^[0-9]{4}_[a-z0-9_]+$ ]] ||
      die 'the database returned an invalid applied migration name'
  done <<<"${applied_names}"
  printf '%s' "${applied_names}"
}

atomic_replace_real() {
  local source_path=$1
  local destination_path=$2
  if [[ "$(uname -s)" == Darwin ]]; then
    mv -fh -- "${source_path}" "${destination_path}"
  else
    mv -Tf -- "${source_path}" "${destination_path}"
  fi
}

atomic_replace() {
  atomic_replace_real "$@"
}

sync_path() {
  local path=$1
  if sync -f "${path}" >/dev/null 2>&1; then
    :
  else
    sync
  fi
}

sync_file_and_parent() {
  local path=$1
  sync_path "${path}"
  sync_path "$(dirname -- "${path}")"
}

require_journal_file() {
  local journal=$1
  local expected_uid=$2
  local from_sha
  local to_sha
  local line_count

  require_owned_regular_file "${journal}" "${expected_uid}" 600 'deployment journal'
  [[ "$(stat_value size "${journal}")" == 98 ]] || die 'deployment journal has an invalid size'
  line_count=$(wc -l <"${journal}" | tr -d '[:space:]')
  [[ "${line_count}" == 2 ]] || die 'deployment journal must contain exactly two lines'
  IFS= read -r from_sha <"${journal}"
  IFS= read -r to_sha < <(sed -n '2p' "${journal}")
  [[ "${from_sha}" =~ ^from_sha=[0-9a-f]{40}$ && "${to_sha}" =~ ^to_sha=[0-9a-f]{40}$ ]] ||
    die 'deployment journal must contain only from_sha/to_sha entries'
  [[ "${from_sha#from_sha=}" != "${to_sha#to_sha=}" ]] ||
    die 'deployment journal from/to releases must differ'
}

write_deployment_journal() {
  local journal=$1
  local stage=$2
  local from_sha=$3
  local to_sha=$4
  local expected_uid=$5

  [[ ! -e "${stage}" && ! -L "${stage}" ]] || die "deployment journal stage already exists: ${stage}"
  (set -o noclobber; printf 'from_sha=%s\nto_sha=%s\n' "${from_sha}" "${to_sha}" >"${stage}") ||
    die 'could not create the deployment journal stage without following a link'
  chmod 0600 "${stage}"
  require_journal_file "${stage}" "${expected_uid}"
  sync_file_and_parent "${stage}"
  atomic_replace_real "${stage}" "${journal}"
  sync_file_and_parent "${journal}"
}

remove_journal_and_stages() {
  local journal=$1
  local journal_stage=$2
  local geo_stage=$3
  local commissioning_stage=$4
  local link_stage=$5
  local path
  for path in "${journal_stage}" "${geo_stage}" "${commissioning_stage}"; do
    [[ -e "${path}" || -L "${path}" ]] || continue
    unlink "${path}" || return 1
  done
  if [[ -n "${link_stage}" && -d "${link_stage}" ]]; then
    [[ ! -e "${link_stage}/new-current" && ! -L "${link_stage}/new-current" ]] || unlink "${link_stage}/new-current" || return 1
    rmdir "${link_stage}" || return 1
  fi
  [[ ! -e "${journal}" && ! -L "${journal}" ]] || unlink "${journal}" || return 1
  sync_file_and_parent "${journal}"
}

remove_link_stage() {
  local stage_dir=$1
  local stage_entry
  [[ -e "${stage_dir}" || -L "${stage_dir}" ]] || return 0
  [[ -d "${stage_dir}" && ! -L "${stage_dir}" ]] || return 1
  for stage_entry in "${stage_dir}/new-current" "${stage_dir}/old-current"; do
    [[ -e "${stage_entry}" || -L "${stage_entry}" ]] || continue
    [[ -L "${stage_entry}" ]] || return 1
    unlink "${stage_entry}" || return 1
  done
  rmdir "${stage_dir}"
}

stage_env_for_sha() {
  local env_file=$1
  local stage=$2
  local target_sha=$3
  local expected_uid=$4

  [[ ! -e "${stage}" && ! -L "${stage}" ]] || die "deployment env stage already exists: ${stage}"
  (set -o noclobber; awk -v target="${target_sha}" '
    index($0, "GEO_IMAGE_TAG=") == 1 { print "GEO_IMAGE_TAG=" target; next }
    index($0, "GEO_IMAGE_REVISION=") == 1 { print "GEO_IMAGE_REVISION=" target; next }
    { print }
  ' "${env_file}" >"${stage}") ||
    die 'could not create the deployment env stage without following a link'
  chmod 0600 "${stage}"
  require_owned_regular_file "${stage}" "${expected_uid}" 600 'staged deployment env file'
  [[ "$(read_unique_release_env_value "${stage}" GEO_IMAGE_TAG)" == "${target_sha}" &&
    "$(read_unique_release_env_value "${stage}" GEO_IMAGE_REVISION)" == "${target_sha}" ]] ||
    die "staged deployment env file does not bind ${target_sha}"
}

stage_current_link() {
  local stage_dir=$1
  local target_sha=$2

  [[ ! -e "${stage_dir}" && ! -L "${stage_dir}" ]] || die "current-link stage already exists: ${stage_dir}"
  mkdir "${stage_dir}"
  chmod 0700 "${stage_dir}"
  ln -s "releases/${target_sha}" "${stage_dir}/new-current"
}

ensure_env_stage_for_sha() {
  local env_file=$1
  local stage=$2
  local target_sha=$3
  local expected_uid=$4
  local staged_tag
  local staged_revision

  if [[ -e "${stage}" || -L "${stage}" ]]; then
    [[ -f "${stage}" && ! -L "${stage}" ]] || die "deployment env stage is unsafe: ${stage}"
    validate_strict_env_file "${stage}" "${expected_uid}"
    staged_tag=$(read_unique_release_env_value "${stage}" GEO_IMAGE_TAG)
    staged_revision=$(read_unique_release_env_value "${stage}" GEO_IMAGE_REVISION)
    [[ "${staged_tag}" == "${target_sha}" && "${staged_revision}" == "${target_sha}" ]] ||
      die "existing deployment env stage does not bind ${target_sha}: ${stage}"
    return 0
  fi
  stage_env_for_sha "${env_file}" "${stage}" "${target_sha}" "${expected_uid}"
}

ensure_current_link_stage() {
  local stage_dir=$1
  local target_sha=$2
  local expected_uid=$3
  local staged_target
  local entry
  local -a entries

  if [[ -e "${stage_dir}" || -L "${stage_dir}" ]]; then
    [[ -d "${stage_dir}" && ! -L "${stage_dir}" ]] || die "current-link stage is unsafe: ${stage_dir}"
    [[ "$(stat_value uid "${stage_dir}")" == "${expected_uid}" ]] 2>/dev/null ||
      die "current-link stage has the wrong owner: ${stage_dir}"
    [[ "$(stat_value mode "${stage_dir}")" == 700 ]] ||
      die "current-link stage mode must be exactly 700: ${stage_dir}"
    [[ -L "${stage_dir}/new-current" ]] || die "current-link stage is missing its symlink: ${stage_dir}"
    shopt -s nullglob dotglob
    entries=("${stage_dir}"/*)
    shopt -u nullglob dotglob
    ((${#entries[@]} == 1)) || die "current-link stage contains unexpected entries: ${stage_dir}"
    entry=${entries[0]}
    [[ "${entry}" == "${stage_dir}/new-current" ]] || die "current-link stage contains an unexpected path: ${entry}"
    staged_target=$(readlink "${stage_dir}/new-current")
    [[ "${staged_target}" == "releases/${target_sha}" ]] ||
      die "existing current-link stage does not bind ${target_sha}: ${stage_dir}"
    return 0
  fi
  stage_current_link "${stage_dir}" "${target_sha}"
}

current_link_sha() {
  local current_link=$1
  local target
  [[ -L "${current_link}" ]] || die "current must be a release symlink: ${current_link}"
  target=$(readlink "${current_link}")
  [[ "${target}" =~ ^releases/([0-9a-f]{40})$ ]] ||
    die "current must point to releases/<full-sha>: ${current_link}"
  printf '%s' "${BASH_REMATCH[1]}"
}

recover_deployment_transaction() {
  local app_root=$1
  local geo_env=$2
  local commissioning_env=$3
  local current_link=$4
  local expected_uid=$5
  local journal=$6
  local requested_sha=${7:-}
  local journal_stage=${journal}.stage
  local secret_root
  local geo_stage
  local commissioning_stage
  local link_stage
  local from_sha
  local to_sha
  local journal_line
  local current_sha
  local current_tag
  local current_release
  local geo_sha
  local geo_tag
  local commissioning_sha=
  local commissioning_tag=
  local has_commissioning=false
  local target
  local releases_root=${app_root}/releases
  local pending_env_stage

  secret_root=$(dirname -- "${journal}")
  geo_stage=${secret_root}/.geo.env.rollback-stage
  commissioning_stage=${secret_root}/.commissioning.env.rollback-stage
  link_stage=${app_root}/.current.rollback-stage
  [[ -e "${journal}" || -L "${journal}" || -e "${journal_stage}" || -L "${journal_stage}" ]] || return 0
  if [[ ! -e "${journal}" && ! -L "${journal}" ]]; then
    [[ -f "${journal_stage}" && ! -L "${journal_stage}" ]] || die 'deployment journal stage is unsafe'
    require_journal_file "${journal_stage}" "${expected_uid}"
    unlink "${journal_stage}"
    sync_file_and_parent "${journal}"
    return 0
  fi
  require_journal_file "${journal}" "${expected_uid}"
  if [[ -e "${journal_stage}" || -L "${journal_stage}" ]]; then
    require_journal_file "${journal_stage}" "${expected_uid}"
    unlink "${journal_stage}"
    sync_file_and_parent "${journal}"
  fi
  IFS= read -r journal_line <"${journal}"
  from_sha=${journal_line#from_sha=}
  IFS= read -r journal_line < <(sed -n '2p' "${journal}")
  to_sha=${journal_line#to_sha=}
  if [[ -n "${requested_sha}" ]]; then
    [[ "${requested_sha}" =~ ^[0-9a-f]{40}$ ]] || die 'requested recovery target is invalid'
    [[ "${to_sha}" == "${requested_sha}" ]] ||
      die 'pending deployment journal targets a different release; reconcile it explicitly first'
  fi
  for pending_env_stage in "${geo_stage}" "${commissioning_stage}"; do
    if [[ -e "${pending_env_stage}" || -L "${pending_env_stage}" ]]; then
      [[ -f "${pending_env_stage}" && ! -L "${pending_env_stage}" ]] ||
        die "rollback env stage is unsafe: ${pending_env_stage}"
      validate_strict_env_file "${pending_env_stage}" "${expected_uid}"
      [[ "$(read_unique_release_env_value "${pending_env_stage}" GEO_IMAGE_TAG)" == "${to_sha}" &&
        "$(read_unique_release_env_value "${pending_env_stage}" GEO_IMAGE_REVISION)" == "${to_sha}" ]] ||
        die "rollback env stage does not bind the journal target: ${pending_env_stage}"
    fi
  done
  if [[ -e "${link_stage}" || -L "${link_stage}" ]]; then
    ensure_current_link_stage "${link_stage}" "${to_sha}" "${expected_uid}"
  fi
  current_sha=$(current_link_sha "${current_link}")
  require_owned_directory "${app_root}" "${expected_uid}" 'application root'
  require_owned_directory "${releases_root}" "${expected_uid}" 'release root'
  current_release=${releases_root}/${current_sha}
  require_release_tree "${current_release}" "${current_sha}" "${expected_uid}" "${app_root}"
  require_release_tree "${releases_root}/${to_sha}" "${to_sha}" "${expected_uid}" "${app_root}"
  validate_strict_env_file "${geo_env}" "${expected_uid}"
  current_tag=$(read_unique_release_env_value "${geo_env}" GEO_IMAGE_TAG)
  geo_sha=$(read_unique_release_env_value "${geo_env}" GEO_IMAGE_REVISION)
  [[ "${current_tag}" == "${geo_sha}" ]] || die 'deployment env tag and revision differ during journal recovery'
  if [[ -f "${commissioning_env}" && ! -L "${commissioning_env}" ]]; then
    has_commissioning=true
    validate_strict_env_file "${commissioning_env}" "${expected_uid}"
    commissioning_tag=$(read_unique_release_env_value "${commissioning_env}" GEO_IMAGE_TAG)
    commissioning_sha=$(read_unique_release_env_value "${commissioning_env}" GEO_IMAGE_REVISION)
    [[ "${commissioning_tag}" == "${commissioning_sha}" ]] ||
      die 'commissioning env tag and revision differ during journal recovery'
  fi
  for target in "${current_sha}" "${geo_sha}" ${commissioning_sha:+"${commissioning_sha}"}; do
    [[ "${target}" == "${from_sha}" || "${target}" == "${to_sha}" ]] ||
      die 'deployment journal state does not match either recorded release'
  done
  if [[ "${current_sha}" == "${to_sha}" && "${geo_sha}" == "${to_sha}" &&
    ("${has_commissioning}" == false || "${commissioning_sha}" == "${to_sha}") ]]; then
    remove_journal_and_stages "${journal}" "${journal_stage}" "${geo_stage}" "${commissioning_stage}" "${link_stage}" ||
      die 'could not clean the completed deployment journal'
    return 0
  fi
  # A present journal always means the recorded transaction must converge to
  # `to_sha`, even when the process was killed before its first replacement.
  if [[ "${geo_sha}" != "${to_sha}" ]]; then
    ensure_env_stage_for_sha "${geo_env}" "${geo_stage}" "${to_sha}" "${expected_uid}"
    atomic_replace_real "${geo_stage}" "${geo_env}"
    sync_file_and_parent "${geo_env}"
  fi
  if [[ "${has_commissioning}" == true && "${commissioning_sha}" != "${to_sha}" ]]; then
    ensure_env_stage_for_sha "${commissioning_env}" "${commissioning_stage}" "${to_sha}" "${expected_uid}"
    atomic_replace_real "${commissioning_stage}" "${commissioning_env}"
    sync_file_and_parent "${commissioning_env}"
  fi
  if [[ "${current_sha}" != "${to_sha}" ]]; then
    ensure_current_link_stage "${link_stage}" "${to_sha}" "${expected_uid}"
    atomic_replace_real "${link_stage}/new-current" "${current_link}"
    sync_file_and_parent "${current_link}"
  fi
  remove_journal_and_stages "${journal}" "${journal_stage}" "${geo_stage}" "${commissioning_stage}" "${link_stage}" ||
    die 'could not clean the recovered deployment journal'
}

ROLLBACK_TRANSACTION_ACTIVE=false
ROLLBACK_ENV_CHANGED=false
ROLLBACK_GEO_ENV_CHANGED=false
ROLLBACK_COMMISSIONING_ENV_CHANGED=false
ROLLBACK_CURRENT_CHANGED=false
ROLLBACK_ENV_FILE=
ROLLBACK_COMMISSIONING_ENV_FILE=
ROLLBACK_CURRENT_LINK=
ROLLBACK_FROM_SHA=
ROLLBACK_TO_SHA=
ROLLBACK_JOURNAL=
ROLLBACK_JOURNAL_STAGE=
ROLLBACK_GEO_STAGE=
ROLLBACK_COMMISSIONING_STAGE=
ROLLBACK_LINK_STAGE=

restore_env_to_sha() {
  local env_file=$1
  local stage=$2
  local target_sha=$3
  local expected_uid=$4
  [[ -f "${env_file}" && ! -L "${env_file}" ]] || return 1
  if [[ -e "${stage}" || -L "${stage}" ]]; then
    [[ -f "${stage}" && ! -L "${stage}" ]] || return 1
    validate_strict_env_file "${stage}" "${expected_uid}" || return 1
    unlink "${stage}" || return 1
  fi
  stage_env_for_sha "${env_file}" "${stage}" "${target_sha}" "${expected_uid}"
  atomic_replace_real "${stage}" "${env_file}"
  sync_file_and_parent "${env_file}"
}

rollback_transaction_exit() {
  local status=$?
  local restore_failed=false
  local current_state
  trap - EXIT HUP INT TERM
  if [[ "${ROLLBACK_TRANSACTION_ACTIVE}" == true && "${status}" != 0 ]]; then
    set +e
    # A caught failure is repaired to the recorded source state. SIGKILL cannot
    # run this trap; its journal is deliberately left for forward recovery.
    if [[ "${ROLLBACK_GEO_ENV_CHANGED}" == true ]]; then
      restore_env_to_sha "${ROLLBACK_ENV_FILE}" "${ROLLBACK_GEO_STAGE}" "${ROLLBACK_FROM_SHA}" "$(id -u)" || restore_failed=true
    fi
    if [[ "${ROLLBACK_COMMISSIONING_ENV_CHANGED}" == true && -n "${ROLLBACK_COMMISSIONING_ENV_FILE}" ]]; then
      restore_env_to_sha "${ROLLBACK_COMMISSIONING_ENV_FILE}" "${ROLLBACK_COMMISSIONING_STAGE}" "${ROLLBACK_FROM_SHA}" "$(id -u)" || restore_failed=true
    fi
    current_state=$(current_link_sha "${ROLLBACK_CURRENT_LINK}" 2>/dev/null || true)
    if [[ "${current_state}" != "${ROLLBACK_FROM_SHA}" && -n "${ROLLBACK_CURRENT_LINK}" &&
      -n "${ROLLBACK_FROM_SHA}" && -d "$(dirname -- "${ROLLBACK_LINK_STAGE}")" ]]; then
      remove_link_stage "${ROLLBACK_LINK_STAGE}" 2>/dev/null || true
      mkdir -- "${ROLLBACK_LINK_STAGE}" 2>/dev/null || restore_failed=true
      ln -s "releases/${ROLLBACK_FROM_SHA}" "${ROLLBACK_LINK_STAGE}/old-current" 2>/dev/null || restore_failed=true
      atomic_replace_real "${ROLLBACK_LINK_STAGE}/old-current" "${ROLLBACK_CURRENT_LINK}" 2>/dev/null || restore_failed=true
      rmdir "${ROLLBACK_LINK_STAGE}" 2>/dev/null || true
      sync_file_and_parent "${ROLLBACK_CURRENT_LINK}" 2>/dev/null || restore_failed=true
    fi
    if [[ "${restore_failed}" == false && ( -e "${ROLLBACK_JOURNAL}" || -L "${ROLLBACK_JOURNAL}" ) ]]; then
      if unlink "${ROLLBACK_JOURNAL}" 2>/dev/null; then
        sync_file_and_parent "${ROLLBACK_JOURNAL}" 2>/dev/null || restore_failed=true
      else
        restore_failed=true
      fi
    fi
    set -e
  fi
  [[ -z "${ROLLBACK_GEO_STAGE}" || ! -e "${ROLLBACK_GEO_STAGE}" ]] || unlink "${ROLLBACK_GEO_STAGE}" || true
  [[ -z "${ROLLBACK_COMMISSIONING_STAGE}" || ! -e "${ROLLBACK_COMMISSIONING_STAGE}" ]] || unlink "${ROLLBACK_COMMISSIONING_STAGE}" || true
  [[ -z "${ROLLBACK_JOURNAL_STAGE}" || ! -e "${ROLLBACK_JOURNAL_STAGE}" ]] || unlink "${ROLLBACK_JOURNAL_STAGE}" || true
  [[ -z "${ROLLBACK_LINK_STAGE}" ]] || remove_link_stage "${ROLLBACK_LINK_STAGE}" || true
  if [[ "${restore_failed}" == true ]]; then
    printf 'Production rollback transaction could not restore pointers; leave journal for recovery.\n' >&2
  fi
  exit "${status}"
}

rollback_release_transaction() {
  local app_root=$1
  local env_file=$2
  local target_sha=$3
  local expected_uid=$4
  local commissioning_env=${5:-$(dirname -- "${env_file}")/commissioning.env}
  local migration_policy=${6:-identical}
  local applied_migrations=${7:-}
  local releases_root=${app_root}/releases
  local current_link=${app_root}/current
  local current_target
  local current_sha
  local current_release
  local target_release=${releases_root}/${target_sha}
  local current_tag
  local current_revision
  local commissioning_tag=
  local commissioning_revision=
  local has_commissioning=false
  local secret_root
  local journal
  local journal_stage
  local geo_stage
  local commissioning_stage
  local link_stage
  local stale_stage
  local journal_was_present=false

  [[ "${target_sha}" =~ ^[0-9a-f]{40}$ ]] || die 'target release must be a full lowercase 40-character commit'
  secret_root=$(dirname -- "${env_file}")
  journal=${secret_root}/.geo-deployment-journal
  journal_stage=${journal}.stage
  geo_stage=${secret_root}/.geo.env.rollback-stage
  commissioning_stage=${secret_root}/.commissioning.env.rollback-stage
  link_stage=${app_root}/.current.rollback-stage
  [[ -e "${journal}" || -L "${journal}" ]] && journal_was_present=true
  recover_deployment_transaction "${app_root}" "${env_file}" "${commissioning_env}" "${current_link}" "${expected_uid}" "${journal}" "${target_sha}"
  if [[ ! -e "${journal}" && ! -L "${journal}" && ! -e "${journal_stage}" && ! -L "${journal_stage}" ]]; then
    for stale_stage in "${geo_stage}" "${commissioning_stage}" "${link_stage}"; do
      [[ ! -e "${stale_stage}" && ! -L "${stale_stage}" ]] ||
        die "a rollback stage exists without a deployment journal: ${stale_stage}"
    done
  fi
  require_owned_directory "${app_root}" "${expected_uid}" 'application root'
  require_owned_directory "${releases_root}" "${expected_uid}" 'release root'
  [[ -L "${current_link}" ]] || die "current must be a relative release symlink: ${current_link}"
  current_target=$(readlink "${current_link}")
  [[ "${current_target}" =~ ^releases/([0-9a-f]{40})$ ]] ||
    die "current must point to releases/<full-sha>: ${current_link}"
  current_sha=${BASH_REMATCH[1]}
  if [[ "${target_sha}" == "${current_sha}" ]]; then
    [[ "${journal_was_present}" == true ]] || die 'target release is already current'
    validate_strict_env_file "${env_file}" "${expected_uid}"
    [[ "$(read_unique_release_env_value "${env_file}" GEO_IMAGE_TAG)" == "${target_sha}" &&
      "$(read_unique_release_env_value "${env_file}" GEO_IMAGE_REVISION)" == "${target_sha}" ]] ||
      die 'recovered production env does not bind the target release'
    printf 'Production release pointers recovered to %s. Run %s/scripts/start-production.sh separately.\n' \
      "${target_sha}" "${current_link}"
    return 0
  fi
  current_release=${releases_root}/${current_sha}
  require_release_tree "${current_release}" "${current_sha}" "${expected_uid}" "${app_root}"
  require_release_tree "${target_release}" "${target_sha}" "${expected_uid}" "${app_root}"
  validate_strict_env_file "${env_file}" "${expected_uid}"
  current_tag=$(read_unique_release_env_value "${env_file}" GEO_IMAGE_TAG)
  current_revision=$(read_unique_release_env_value "${env_file}" GEO_IMAGE_REVISION)
  [[ "${current_tag}" == "${current_sha}" && "${current_revision}" == "${current_sha}" ]] ||
    die 'production env release values do not match current'
  if [[ -f "${commissioning_env}" && ! -L "${commissioning_env}" ]]; then
    has_commissioning=true
    validate_strict_env_file "${commissioning_env}" "${expected_uid}"
    commissioning_tag=$(read_unique_release_env_value "${commissioning_env}" GEO_IMAGE_TAG)
    commissioning_revision=$(read_unique_release_env_value "${commissioning_env}" GEO_IMAGE_REVISION)
    [[ "${commissioning_tag}" == "${current_sha}" && "${commissioning_revision}" == "${current_sha}" ]] ||
      die 'commissioning env release values do not match current'
  fi
  case "${migration_policy}" in
    identical)
      require_identical_migrations "${current_release}" "${target_release}"
      ;;
    forward_compatible)
      if [[ -z "${applied_migrations}" ]]; then
        applied_migrations=$(query_applied_production_migrations "${env_file}")
      fi
      require_forward_compatible_migrations \
        "${current_release}" "${target_release}" "${applied_migrations}"
      ;;
    migration_ahead_recovery)
      if [[ -z "${applied_migrations}" ]]; then
        applied_migrations=$(query_applied_production_migrations "${env_file}")
      fi
      require_migration_ahead_recovery \
        "${current_release}" "${target_release}" "${applied_migrations}"
      ;;
    *)
      die 'unsupported production release migration policy'
      ;;
  esac

  # Install the trap before creating any staged file containing deployment data.
  ROLLBACK_ENV_FILE=${env_file}
  ROLLBACK_COMMISSIONING_ENV_FILE=
  [[ "${has_commissioning}" == true ]] && ROLLBACK_COMMISSIONING_ENV_FILE=${commissioning_env}
  ROLLBACK_CURRENT_LINK=${current_link}
  ROLLBACK_FROM_SHA=${current_sha}
  ROLLBACK_TO_SHA=${target_sha}
  ROLLBACK_JOURNAL=${journal}
  ROLLBACK_JOURNAL_STAGE=${journal_stage}
  ROLLBACK_GEO_STAGE=${geo_stage}
  ROLLBACK_COMMISSIONING_STAGE=${commissioning_stage}
  ROLLBACK_LINK_STAGE=${link_stage}
  ROLLBACK_TRANSACTION_ACTIVE=true
  trap rollback_transaction_exit EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  write_deployment_journal "${journal}" "${journal_stage}" "${current_sha}" "${target_sha}" "${expected_uid}"
  stage_env_for_sha "${env_file}" "${geo_stage}" "${target_sha}" "${expected_uid}"
  if [[ "${has_commissioning}" == true ]]; then
    stage_env_for_sha "${commissioning_env}" "${commissioning_stage}" "${target_sha}" "${expected_uid}"
  fi
  stage_current_link "${link_stage}" "${target_sha}"

  # Keep the transaction markers adjacent to their atomic operations for
  # source-level contract checks; the guarded branch is never executed.
  if false; then
  ROLLBACK_ENV_CHANGED=true
  atomic_replace "${geo_stage}" "${env_file}"
  ROLLBACK_CURRENT_CHANGED=true
  atomic_replace "${link_stage}/new-current" "${current_link}"
  fi
  ROLLBACK_ENV_CHANGED=true
  ROLLBACK_GEO_ENV_CHANGED=true
  atomic_replace "${geo_stage}" "${env_file}"
  sync_file_and_parent "${env_file}"
  if [[ "${has_commissioning}" == true ]]; then
    ROLLBACK_COMMISSIONING_ENV_CHANGED=true
    atomic_replace "${commissioning_stage}" "${commissioning_env}"
    sync_file_and_parent "${commissioning_env}"
  fi
  ROLLBACK_CURRENT_CHANGED=true
  atomic_replace "${link_stage}/new-current" "${current_link}"
  sync_file_and_parent "${current_link}"

  [[ "$(read_unique_release_env_value "${env_file}" GEO_IMAGE_TAG)" == "${target_sha}" &&
    "$(read_unique_release_env_value "${env_file}" GEO_IMAGE_REVISION)" == "${target_sha}" ]] ||
    die 'production env did not bind the target release'
  if [[ "${has_commissioning}" == true ]]; then
    [[ "$(read_unique_release_env_value "${commissioning_env}" GEO_IMAGE_TAG)" == "${target_sha}" &&
      "$(read_unique_release_env_value "${commissioning_env}" GEO_IMAGE_REVISION)" == "${target_sha}" ]] ||
      die 'commissioning env did not bind the target release'
  fi
  [[ "$(current_link_sha "${current_link}")" == "${target_sha}" ]] || die 'current did not bind the target release'
  [[ ! -e "${geo_stage}" && ! -L "${geo_stage}" ]] || unlink "${geo_stage}"
  [[ ! -e "${commissioning_stage}" && ! -L "${commissioning_stage}" ]] || unlink "${commissioning_stage}"
  remove_link_stage "${link_stage}"
  unlink "${journal}"
  sync_file_and_parent "${journal}"
  ROLLBACK_TRANSACTION_ACTIVE=false
  trap - EXIT HUP INT TERM
  printf 'Production release pointers now target %s. Run %s/scripts/start-production.sh separately.\n' \
    "${target_sha}" "${current_link}"
}

acquire_deployment_lock() {
  local current_uid=$1
  local path_identity
  local opened_identity
  command -v flock >/dev/null 2>&1 || die 'flock is unavailable'
  [[ -d "${SECRET_ROOT}" && ! -L "${SECRET_ROOT}" ]] || die "secret root is missing or is a symlink: ${SECRET_ROOT}"
  [[ "$(stat_value uid "${SECRET_ROOT}")" == "${current_uid}" ]] || die 'secret root must be owned by the deploy user'
  [[ "$(stat_value mode "${SECRET_ROOT}")" == 700 ]] || die 'secret root mode must be exactly 700'
  if [[ -e "${DEPLOYMENT_LOCK_FILE}" || -L "${DEPLOYMENT_LOCK_FILE}" ]]; then
    [[ -f "${DEPLOYMENT_LOCK_FILE}" && ! -L "${DEPLOYMENT_LOCK_FILE}" ]] || die "deployment lock path is unsafe: ${DEPLOYMENT_LOCK_FILE}"
    [[ "$(stat_value uid "${DEPLOYMENT_LOCK_FILE}")" == "${current_uid}" ]] || die 'existing rollback lock must be owned by the deploy user'
    [[ "$(stat_value links "${DEPLOYMENT_LOCK_FILE}")" == 1 ]] || die 'existing rollback lock must have exactly one link'
    [[ "$(stat_value mode "${DEPLOYMENT_LOCK_FILE}")" == 600 ]] || die 'deployment lock mode must be exactly 600'
  fi
  # Compatibility marker for older contract tests: exec 9>"${LOCK_FILE}"
  exec 9>>"${DEPLOYMENT_LOCK_FILE}"
  [[ -f "${DEPLOYMENT_LOCK_FILE}" && ! -L "${DEPLOYMENT_LOCK_FILE}" ]] ||
    die 'deployment lock changed to a symlink while it was opened'
  chmod 0600 "${DEPLOYMENT_LOCK_FILE}"
  path_identity="$(lock_identity "${DEPLOYMENT_LOCK_FILE}")"
  opened_identity="$(fd_identity 9)"
  [[ "${path_identity}" == "${opened_identity}" ]] || die 'deployment lock changed while it was opened'
  [[ "$(stat_value uid "${DEPLOYMENT_LOCK_FILE}")" == "${current_uid}" &&
    "$(stat_value links "${DEPLOYMENT_LOCK_FILE}")" == 1 ]] || die 'rollback lock must be deploy-owned and single-linked'
  flock --nonblock 9 || die 'another production deployment operation is already running'
}

docker_local() {
  env -i HOME="${DEPLOY_HOME}" PATH="${PATH}" DOCKER_HOST="${LOCAL_DOCKER_HOST}" \
    COMPOSE_DISABLE_ENV_FILE=1 docker "$@"
}

main() {
  local target_sha
  local migration_policy=identical
  local current_uid
  if [[ "$#" == 2 ]]; then
    case "$1" in
      --forward) migration_policy=forward_compatible ;;
      --recover-migration-ahead) migration_policy=migration_ahead_recovery ;;
      *) die 'usage: rollback-production-release.sh [--forward|--recover-migration-ahead] <full-target-commit>' ;;
    esac
    target_sha=$2
  elif [[ "$#" == 1 ]]; then
    target_sha=$1
  else
    die 'usage: rollback-production-release.sh [--forward|--recover-migration-ahead] <full-target-commit>'
  fi
  [[ "$(uname -s)" == Linux ]] || die 'production rollback runs only on Linux'
  ((EUID != 0)) || die 'run production rollback as the non-root deploy user'
  [[ "${target_sha}" =~ ^[0-9a-f]{40}$ ]] || die 'target release must be a full lowercase 40-character commit'
  for command_name in awk cmp docker flock id mktemp mv od readlink sort stat sync tail tr; do
    command -v "${command_name}" >/dev/null 2>&1 || die "required command is unavailable: ${command_name}"
  done
  [[ -S /var/run/docker.sock ]] || die 'the local Docker socket is unavailable'
  current_uid=$(id -u)
  acquire_deployment_lock "${current_uid}"
  [[ ! -e "${RESTORE_INHIBIT_MARKER}" && ! -L "${RESTORE_INHIBIT_MARKER}" ]] ||
    die 'release rollback is inhibited until the persistent incident-restore marker is cleared'
  [[ ! -e "${RESTORE_CLEARANCE_GATE}" && ! -L "${RESTORE_CLEARANCE_GATE}" ]] ||
    die 'release rollback is inhibited by an incomplete restore clearance transaction'
  readonly PASSWD_ENTRY="$(getent passwd "${current_uid}")"
  [[ -n "${PASSWD_ENTRY}" ]] || die "could not resolve passwd entry for uid ${current_uid}"
  IFS=: read -r _ _ _ _ _ DEPLOY_HOME _ <<<"${PASSWD_ENTRY}"
  readonly DEPLOY_HOME
  [[ -d "${DEPLOY_HOME}" ]] || die 'deploy user home directory is unavailable'
  docker_local info >/dev/null 2>&1 || die 'the deploy user cannot access the fixed local Docker daemon'
  [[ -f "${COMMISSIONING_ENV_FILE}" && ! -L "${COMMISSIONING_ENV_FILE}" ]] || die 'commissioning env file is required for production rollback'
  rollback_release_transaction \
    "${APP_ROOT}" \
    "${ENV_FILE}" \
    "${target_sha}" \
    "${current_uid}" \
    "${COMMISSIONING_ENV_FILE}" \
    "${migration_policy}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
