#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly operations_root=/srv/geo-saas/secrets

die() {
  printf 'Operations environment validation failed: %s\n' "$1" >&2
  exit 1
}

usage() {
  printf 'Usage: validate-production-operations-env.sh health|alert|backup [--file-only]\n' >&2
  exit 64
}

((1 <= $# && $# <= 2)) || usage
readonly validation_domain=$1
file_only=false
if (($# == 2)); then
  [[ "$2" == --file-only ]] || usage
  file_only=true
fi
case "${validation_domain}" in
  health) readonly operations_env=${operations_root}/operations-health.env ;;
  alert) readonly operations_env=${operations_root}/operations-alert.env ;;
  backup) readonly operations_env=${operations_root}/operations-backup.env ;;
  *) usage ;;
esac

[[ "$(uname -s)" == Linux ]] || die 'operations environment validation runs only on Linux'
((EUID != 0)) || die 'run operations environment validation as the non-root deploy user'
[[ -d "${operations_root}" && ! -L "${operations_root}" ]] || die 'operations secret root is missing or unsafe'
[[ "$(stat -c '%u:%a' -- "${operations_root}")" == "$(id -u):700" ]] ||
  die 'operations secret root must be deploy-owned with mode 700'
[[ -f "${operations_env}" && ! -L "${operations_env}" ]] || die "${validation_domain} env is missing or unsafe"
readonly env_owner="$(stat -c '%u' -- "${operations_env}")"
[[ "${env_owner}" == "$(id -u)" ]] || die "${validation_domain} env must be owned by the deploy user"
[[ "$(stat -c '%a:%h' -- "${operations_env}")" == 600:1 ]] ||
  die "${validation_domain} env must have mode 600 and exactly one link"
[[ ! -s "${operations_env}" || "$(tail -c 1 -- "${operations_env}" | od -An -t x1 | tr -d '[:space:]')" == 0a ]] ||
  die "${validation_domain} env must end with a newline"

declare -A values=()
line_number=0
while IFS= read -r line || [[ -n "${line}" ]]; do
  ((line_number += 1))
  [[ "${line}" != *$'\r'* ]] || die "${validation_domain} env line ${line_number} contains CR"
  [[ -z "${line}" || "${line}" == \#* ]] && continue
  [[ "${line}" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] ||
    die "${validation_domain} env line ${line_number} must be KEY=value"
  key=${BASH_REMATCH[1]}
  value=${BASH_REMATCH[2]}
  case "${validation_domain}:${key}" in
    health:GEO_PUBLIC_IPV4|alert:GEO_ALERT_WEBHOOK_URL_FILE|\
    backup:RESTIC_REPOSITORY|backup:RESTIC_PASSWORD_FILE|\
    backup:GEO_BACKUP_KEEP_DAILY|backup:GEO_BACKUP_KEEP_WEEKLY|\
    backup:GEO_BACKUP_KEEP_MONTHLY|backup:GEO_LOCAL_BACKUP_RETENTION_DAYS|\
    backup:AWS_ACCESS_KEY_ID|backup:AWS_SECRET_ACCESS_KEY|backup:AWS_SESSION_TOKEN|\
    backup:AWS_DEFAULT_REGION|backup:AWS_REGION|backup:B2_ACCOUNT_ID|backup:B2_ACCOUNT_KEY|\
    backup:AZURE_ACCOUNT_NAME|backup:AZURE_ACCOUNT_KEY|backup:AZURE_ACCOUNT_SAS|\
    backup:GOOGLE_PROJECT_ID|backup:GOOGLE_APPLICATION_CREDENTIALS|\
    backup:RESTIC_REST_USERNAME|backup:RESTIC_REST_PASSWORD|\
    backup:RCLONE_CONFIG|backup:RCLONE_CONFIG_PASS) ;;
    *) die "${validation_domain} env contains a forbidden or unknown key: ${key}" ;;
  esac
  [[ -z "${values[${key}]+present}" ]] || die "${validation_domain} env duplicates ${key}"
  values["${key}"]=${value}
  if [[ "${file_only}" != true ]]; then
    loaded_value=${!key-}
    [[ -n "${!key+x}" && "${loaded_value}" == "${value}" ]] ||
      die "loaded service environment does not match ${validation_domain} env for ${key}"
  fi
done <"${operations_env}"

require_secret_file() {
  local path=$1
  local label=$2
  [[ "${path}" == /* && -f "${path}" && ! -L "${path}" ]] || die "${label} is missing or unsafe"
  [[ "$(stat -c '%u:%a:%h' -- "${path}")" == "${env_owner}:600:1" ]] ||
    die "${label} must match the environment owner, use mode 600, and have one link"
}

case "${validation_domain}" in
  health)
    [[ "${values[GEO_PUBLIC_IPV4]:-}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] ||
      die 'GEO_PUBLIC_IPV4 is missing or invalid'
    ;;
  alert)
    [[ -n "${values[GEO_ALERT_WEBHOOK_URL_FILE]:-}" ]] ||
      die 'GEO_ALERT_WEBHOOK_URL_FILE is missing'
    require_secret_file "${values[GEO_ALERT_WEBHOOK_URL_FILE]}" 'alert webhook URL file'
    ;;
  backup)
    [[ -n "${values[RESTIC_REPOSITORY]:-}" ]] || die 'RESTIC_REPOSITORY is missing'
    [[ -n "${values[RESTIC_PASSWORD_FILE]:-}" ]] || die 'RESTIC_PASSWORD_FILE is missing'
    require_secret_file "${values[RESTIC_PASSWORD_FILE]}" 'restic password file'
    case "${values[RESTIC_REPOSITORY]}" in
      s3:*)
        [[ -n "${values[AWS_ACCESS_KEY_ID]:-}" && -n "${values[AWS_SECRET_ACCESS_KEY]:-}" ]] ||
          die 'the s3 backend requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY'
        ;;
      b2:*)
        [[ -n "${values[B2_ACCOUNT_ID]:-}" && -n "${values[B2_ACCOUNT_KEY]:-}" ]] ||
          die 'the b2 backend requires B2_ACCOUNT_ID and B2_ACCOUNT_KEY'
        ;;
      azure:*)
        [[ -n "${values[AZURE_ACCOUNT_NAME]:-}" ]] || die 'the azure backend requires AZURE_ACCOUNT_NAME'
        [[ -n "${values[AZURE_ACCOUNT_KEY]:-}" || -n "${values[AZURE_ACCOUNT_SAS]:-}" ]] ||
          die 'the azure backend requires AZURE_ACCOUNT_KEY or AZURE_ACCOUNT_SAS'
        ;;
      gs:*)
        [[ -n "${values[GOOGLE_APPLICATION_CREDENTIALS]:-}" ]] ||
          die 'the gs backend requires GOOGLE_APPLICATION_CREDENTIALS'
        require_secret_file "${values[GOOGLE_APPLICATION_CREDENTIALS]}" 'Google credential file'
        ;;
      rclone:*)
        [[ -n "${values[RCLONE_CONFIG]:-}" ]] || die 'the rclone backend requires RCLONE_CONFIG'
        require_secret_file "${values[RCLONE_CONFIG]}" 'rclone config file'
        ;;
      sftp:*|rest:https://*) ;;
      *) die 'RESTIC_REPOSITORY must select a supported non-local offsite backend' ;;
    esac
    ;;
esac

printf 'Operations environment validated for %s.\n' "${validation_domain}"
