#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

die() {
  printf 'Operations alert failed: %s\n' "$1" >&2
  exit 1
}

usage() {
  printf 'Usage: send-operations-alert.sh EVENT_CODE\n' >&2
  exit 64
}

(($# == 1)) || usage
readonly event_code=$1
[[ "${event_code}" =~ ^[A-Za-z0-9_.@:-]{1,160}$ ]] || die 'event code is invalid'
/srv/geo-saas/app/current/scripts/validate-production-operations-env.sh alert >/dev/null

readonly webhook_file=${GEO_ALERT_WEBHOOK_URL_FILE:-/srv/geo-saas/secrets/operations-alert-webhook.url}
[[ "${webhook_file}" == /* ]] || die 'webhook URL file path must be absolute'
[[ -f "${webhook_file}" && ! -L "${webhook_file}" ]] || die 'webhook URL file is missing or unsafe'
[[ "$(stat -c '%u' -- "${webhook_file}")" == "$(id -u)" ]] ||
  die 'webhook URL file must be owned by the service user'
[[ "$(stat -c '%a' -- "${webhook_file}")" == 600 ]] ||
  die 'webhook URL file mode must be exactly 600'
[[ "$(stat -c '%h' -- "${webhook_file}")" == 1 ]] ||
  die 'webhook URL file must not have hard links'
[[ "$(wc -l <"${webhook_file}" | tr -d '[:space:]')" == 1 ]] ||
  die 'webhook URL file must contain exactly one line'
IFS= read -r webhook_url <"${webhook_file}" || die 'could not read webhook URL'
[[ "${webhook_url}" =~ ^https://[A-Za-z0-9][A-Za-z0-9._~:/?#\[\]@!$\&\(\)*+,\;=%-]{1,2040}$ ]] ||
  die 'webhook URL must be an HTTPS URL without whitespace'

for command_name in curl jq hostname; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command is unavailable: ${command_name}"
done

readonly payload="$(jq --null-input --compact-output \
  --arg schema 'geo.operations-alert.v1' \
  --arg event "${event_code}" \
  --arg host "$(hostname --fqdn 2>/dev/null || hostname)" \
  --arg occurredUtc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{schema: $schema, severity: "critical", event: $event, host: $host, occurredUtc: $occurredUtc}')"

printf 'url = "%s"\n' "${webhook_url}" |
  curl --disable --config - --fail --silent --show-error --proto '=https' --tlsv1.2 \
    --connect-timeout 10 --max-time 20 \
    --header 'Content-Type: application/json' \
    --data-binary "${payload}" \
    >/dev/null || die 'HTTPS webhook delivery failed'

printf 'Operations alert delivered for event %s.\n' "${event_code}"
