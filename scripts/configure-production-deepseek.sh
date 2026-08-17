#!/usr/bin/env bash
set -euo pipefail

readonly ENV_FILE="${GEO_ENV_FILE:-/srv/geo-saas/secrets/geo.env}"
readonly SECRET_ROOT="$(dirname "${ENV_FILE}")"
readonly DEEPSEEK_MODEL="${DEEPSEEK_MODEL:-deepseek-v4-pro}"
readonly DEEPSEEK_REASONING_EFFORT="${DEEPSEEK_REASONING_EFFORT:-low}"

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

[[ -f "${ENV_FILE}" && ! -L "${ENV_FILE}" ]] || die 'Production geo.env is missing or unsafe.'
[[ "$(stat -c '%a' "${ENV_FILE}")" == '600' ]] || die 'Production geo.env must have mode 600.'
[[ "$(stat -c '%h' "${ENV_FILE}")" == '1' ]] || die 'Production geo.env must have one link.'
readonly env_owner_uid="$(stat -c '%u' "${ENV_FILE}")"
[[ "${EUID}" -eq 0 || "${EUID}" -eq "${env_owner_uid}" ]] ||
  die 'Run this script as root or the production geo.env owner.'

deepseek_api_key=""
deepseek_api_key_verify=""
if [[ -n "${DEEPSEEK_API_KEY_FILE:-}" ]]; then
  [[ -f "${DEEPSEEK_API_KEY_FILE}" && ! -L "${DEEPSEEK_API_KEY_FILE}" ]] ||
    die 'DEEPSEEK_API_KEY_FILE must be a regular file.'
  deepseek_api_key="$(<"${DEEPSEEK_API_KEY_FILE}")"
  deepseek_api_key_verify="${deepseek_api_key}"
elif [[ -n "${DEEPSEEK_API_KEY:-}" ]]; then
  deepseek_api_key="${DEEPSEEK_API_KEY}"
  deepseek_api_key_verify="${deepseek_api_key}"
else
  [[ -t 0 && -t 1 ]] ||
    die 'Run this script from an interactive TTY or set DEEPSEEK_API_KEY/DEEPSEEK_API_KEY_FILE.'
  read -r -s -p 'Enter the official DeepSeek API key: ' deepseek_api_key
  printf '\n'
  read -r -s -p 'Verify the official DeepSeek API key: ' deepseek_api_key_verify
  printf '\n'
fi

[[ "${deepseek_api_key}" == "${deepseek_api_key_verify}" ]] || die 'DeepSeek API keys do not match.'
[[ "${#deepseek_api_key}" -ge 20 && "${#deepseek_api_key}" -le 512 ]] ||
  die 'DeepSeek API key length must be between 20 and 512 characters.'
[[ "${deepseek_api_key}" != *[[:space:]]* ]] || die 'DeepSeek API key must not contain whitespace.'

umask 077
readonly timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
readonly backup_file="${SECRET_ROOT}/geo.env.pre-deepseek-${timestamp}"
stage_file="$(mktemp "${SECRET_ROOT}/.geo.env.deepseek.XXXXXX")"
trap 'rm -f -- "${stage_file}"' EXIT

cp --preserve=mode,ownership,timestamps -- "${ENV_FILE}" "${backup_file}"

preserve_legacy_media_inspection_configuration() {
  local present=0
  local key
  for key in \
    MEDIA_INSPECTION_PROVIDER \
    MEDIA_INSPECTION_MODEL \
    MEDIA_INSPECTION_API \
    MEDIA_INSPECTION_COMPLETIONS_MODE \
    MEDIA_INSPECTION_BASE_URL \
    MEDIA_INSPECTION_API_KEY; do
    grep -q "^${key}=" "${ENV_FILE}" && present=$((present + 1))
  done
  if [[ "${present}" -eq 6 ]]; then
    return
  fi
  [[ "${present}" -eq 0 ]] ||
    die 'MEDIA_INSPECTION_* must be either fully configured or fully absent before migration.'

  local provider model api completions_mode base_url api_key
  provider="$(awk -F= '$1 == "AGENT_PROVIDER" { sub(/^[^=]*=/, ""); print; exit }' "${ENV_FILE}")"
  model="$(awk -F= '$1 == "AGENT_MODEL" { sub(/^[^=]*=/, ""); print; exit }' "${ENV_FILE}")"
  api="$(awk -F= '$1 == "AGENT_API" { sub(/^[^=]*=/, ""); print; exit }' "${ENV_FILE}")"
  completions_mode="$(awk -F= '$1 == "AGENT_COMPLETIONS_MODE" { sub(/^[^=]*=/, ""); print; exit }' "${ENV_FILE}")"
  base_url="$(awk -F= '$1 == "AGENT_BASE_URL" { sub(/^[^=]*=/, ""); print; exit }' "${ENV_FILE}")"
  api_key="$(awk -F= '$1 == "AGENT_API_KEY" { sub(/^[^=]*=/, ""); print; exit }' "${ENV_FILE}")"
  [[ -n "${provider}" && -n "${model}" && -n "${api_key}" ]] ||
    die 'The existing AGENT_* configuration cannot seed independent media inspection.'
  [[ -n "${completions_mode}" ]] || completions_mode=stream
  printf 'MEDIA_INSPECTION_PROVIDER=%s\n' "${provider}" >>"${stage_file}"
  printf 'MEDIA_INSPECTION_MODEL=%s\n' "${model}" >>"${stage_file}"
  printf 'MEDIA_INSPECTION_API=%s\n' "${api}" >>"${stage_file}"
  printf 'MEDIA_INSPECTION_COMPLETIONS_MODE=%s\n' "${completions_mode}" >>"${stage_file}"
  printf 'MEDIA_INSPECTION_BASE_URL=%s\n' "${base_url}" >>"${stage_file}"
  printf 'MEDIA_INSPECTION_API_KEY=%s\n' "${api_key}" >>"${stage_file}"
  unset api_key
}

preserve_legacy_media_inspection_configuration

declare -A written=()
while IFS= read -r line || [[ -n "${line}" ]]; do
  key="${line%%=*}"
  case "${key}" in
    AGENT_PROVIDER)
      printf 'AGENT_PROVIDER=openai-compatible\n' >>"${stage_file}"
      written[AGENT_PROVIDER]=1
      ;;
    AGENT_MODEL)
      printf 'AGENT_MODEL=%s\n' "${DEEPSEEK_MODEL}" >>"${stage_file}"
      written[AGENT_MODEL]=1
      ;;
    AGENT_API)
      printf 'AGENT_API=openai-completions\n' >>"${stage_file}"
      written[AGENT_API]=1
      ;;
    AGENT_BASE_URL)
      printf 'AGENT_BASE_URL=https://api.deepseek.com\n' >>"${stage_file}"
      written[AGENT_BASE_URL]=1
      ;;
    AGENT_COMPLETIONS_MODE)
      printf 'AGENT_COMPLETIONS_MODE=json\n' >>"${stage_file}"
      written[AGENT_COMPLETIONS_MODE]=1
      ;;
    AGENT_REASONING_EFFORT)
      printf 'AGENT_REASONING_EFFORT=%s\n' "${DEEPSEEK_REASONING_EFFORT}" >>"${stage_file}"
      written[AGENT_REASONING_EFFORT]=1
      ;;
    AGENT_API_KEY)
      printf 'AGENT_API_KEY=%s\n' "${deepseek_api_key}" >>"${stage_file}"
      written[AGENT_API_KEY]=1
      ;;
    *)
      printf '%s\n' "${line}" >>"${stage_file}"
      ;;
  esac
done <"${ENV_FILE}"

for key in \
  AGENT_PROVIDER \
  AGENT_MODEL \
  AGENT_API \
  AGENT_BASE_URL \
  AGENT_COMPLETIONS_MODE \
  AGENT_REASONING_EFFORT \
  AGENT_API_KEY; do
  [[ -n "${written[${key}]+present}" ]] && continue
  case "${key}" in
    AGENT_PROVIDER) printf 'AGENT_PROVIDER=openai-compatible\n' >>"${stage_file}" ;;
    AGENT_MODEL) printf 'AGENT_MODEL=%s\n' "${DEEPSEEK_MODEL}" >>"${stage_file}" ;;
    AGENT_API) printf 'AGENT_API=openai-completions\n' >>"${stage_file}" ;;
    AGENT_BASE_URL) printf 'AGENT_BASE_URL=https://api.deepseek.com\n' >>"${stage_file}" ;;
    AGENT_COMPLETIONS_MODE) printf 'AGENT_COMPLETIONS_MODE=json\n' >>"${stage_file}" ;;
    AGENT_REASONING_EFFORT) printf 'AGENT_REASONING_EFFORT=%s\n' "${DEEPSEEK_REASONING_EFFORT}" >>"${stage_file}" ;;
    AGENT_API_KEY) printf 'AGENT_API_KEY=%s\n' "${deepseek_api_key}" >>"${stage_file}" ;;
  esac
done

chown --reference="${ENV_FILE}" "${stage_file}"
chmod 600 "${stage_file}"
mv -- "${stage_file}" "${ENV_FILE}"
trap - EXIT
unset deepseek_api_key deepseek_api_key_verify

printf 'Configured production drafting upstream: %s, reasoning=%s.\n' \
  "${DEEPSEEK_MODEL}" "${DEEPSEEK_REASONING_EFFORT}"
printf 'Media inspection configuration was preserved.\n'
printf 'Rollback copy: %s\n' "${backup_file}"
printf 'Production services were not restarted.\n'
