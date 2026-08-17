#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# This is a loopback-only test stack. It never uses the production Compose
# overlay, production Ctrip profile, or Plastic Promise transport.

readonly PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly SECRET_ROOT=/srv/geo-saas/secrets
readonly PRODUCTION_ENV_FILE="${SECRET_ROOT}/geo.env"
readonly SANDBOX_ENV_FILE="${SECRET_ROOT}/pi-automation-sandbox.env"
readonly PROJECT_NAME=geo-saas-pi-sandbox
readonly WEB_PORT=10103
readonly API_PORT=10104
readonly MCP_PORT=10101
readonly BRIDGE_PORT=10106

die() {
  printf 'Pi automation sandbox refused: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

random_secret() {
  openssl rand -hex 32
}

read_env_value() {
  local name=$1
  local line
  local value=''
  local matches=0

  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ "${line}" == "${name}="* ]] || continue
    value=${line#*=}
    ((matches += 1))
  done <"${PRODUCTION_ENV_FILE}"

  [[ "${matches}" == 1 && -n "${value}" ]] ||
    die "production environment must contain exactly one non-empty ${name}"
  printf '%s' "${value}"
}

optional_env_value() {
  local name=$1
  local line
  local value=''
  local matches=0

  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ "${line}" == "${name}="* ]] || continue
    value=${line#*=}
    ((matches += 1))
  done <"${PRODUCTION_ENV_FILE}"

  ((matches <= 1)) || die "production environment contains duplicate ${name}"
  printf '%s' "${value}"
}

assert_loopback_port_free() {
  local port=$1
  if ss -ltn "sport = :${port}" | tail -n +2 | grep -q .; then
    die "loopback sandbox port is already in use: ${port}"
  fi
}

write_env_line() {
  local key=$1
  local value=$2
  [[ "${value}" != *$'\n'* && "${value}" != *$'\r'* ]] || die "${key} contains an unsafe line break"
  printf '%s=%s\n' "${key}" "${value}"
}

[[ "$(uname -s)" == Linux ]] || die 'the sandbox runs only on the Linux Docker host'
((EUID != 0)) || die 'run as the non-root deploy user, not with sudo'
(($# == 0)) || die 'usage: start-pi-automation-sandbox.sh'
for command_name in date docker openssl ss stat; do
  require_command "${command_name}"
done

[[ -d "${SECRET_ROOT}" && ! -L "${SECRET_ROOT}" ]] || die 'secret root is missing or unsafe'
[[ "$(stat -c '%u:%a' -- "${SECRET_ROOT}")" == "$(id -u):700" ]] ||
  die 'secret root must be deploy-owned with mode 700'
[[ -f "${PRODUCTION_ENV_FILE}" && ! -L "${PRODUCTION_ENV_FILE}" ]] ||
  die 'production environment is missing or unsafe'
[[ "$(stat -c '%u:%a:%h' -- "${PRODUCTION_ENV_FILE}")" == "$(id -u):600:1" ]] ||
  die 'production environment must be deploy-owned, mode 600, and single-linked'
[[ -f "${ROOT_DIR}/compose.yaml" && ! -L "${ROOT_DIR}/compose.yaml" ]] ||
  die 'compose.yaml is missing or unsafe'

for port in "${WEB_PORT}" "${API_PORT}" "${MCP_PORT}" "${BRIDGE_PORT}"; do
  assert_loopback_port_free "${port}"
done

readonly agent_provider="$(read_env_value AGENT_PROVIDER)"
readonly agent_model="$(read_env_value AGENT_MODEL)"
readonly agent_api_key="$(read_env_value AGENT_API_KEY)"
readonly agent_api="$(optional_env_value AGENT_API)"
readonly agent_base_url="$(optional_env_value AGENT_BASE_URL)"
readonly agent_reasoning_effort="$(optional_env_value AGENT_REASONING_EFFORT)"
readonly agent_strict_tool_arguments="$(optional_env_value AGENT_STRICT_TOOL_ARGUMENTS)"
readonly npm_registry="$(optional_env_value NPM_REGISTRY)"
readonly media_search_provider="$(optional_env_value GEO_MEDIA_SEARCH_PROVIDER)"
readonly media_https_proxy_url="$(optional_env_value GEO_MEDIA_HTTPS_PROXY_URL)"
readonly pexels_api_key="$(optional_env_value PEXELS_API_KEY)"
[[ "${agent_provider}" != fixture ]] || die 'a real Pi provider is required for this sandbox'
if [[ "${agent_provider}" == openai-compatible ]]; then
  [[ -n "${agent_api}" && -n "${agent_base_url}" ]] ||
    die 'openai-compatible Pi requires AGENT_API and AGENT_BASE_URL in production environment'
else
  [[ -z "${agent_api}" && -z "${agent_base_url}" ]] ||
    die 'registered Pi providers must not define AGENT_API or AGENT_BASE_URL'
fi
[[ "${npm_registry}" =~ ^https://[^/@?#[:space:]]+/?$ ]] ||
  die 'NPM_REGISTRY must be a credential-free HTTPS registry URL'
case "${media_search_provider}" in
  wikimedia_commons) ;;
  pexels)
    [[ -n "${pexels_api_key}" ]] ||
      die 'production environment must contain PEXELS_API_KEY for Pexels search'
    ;;
  *) die 'production environment must select wikimedia_commons or pexels licensed search' ;;
esac

readonly admin_password="$(random_secret)"
readonly api_password="$(random_secret)"
readonly worker_password="$(random_secret)"
readonly identity_password="$(random_secret)"
readonly session_secret="$(random_secret)"
readonly operator_password="$(random_secret)"
readonly agent_token="$(random_secret)"
readonly bridge_token="$(random_secret)"
readonly tenant_id=10000000-0000-4000-8000-000000000001
readonly worker_principal_id=10000000-0000-4000-8000-000000000102
readonly ctrip_account_id=10000000-0000-4000-8000-000000000703
readonly ctrip_bridge_principal_id=10000000-0000-4000-8000-000000000103
readonly evidence_expires_at="$(date --utc --date='+24 hours' +%Y-%m-%dT%H:%M:%S.000Z)"
readonly mcp_principals="[{\"accessToken\":\"${agent_token}\",\"clientId\":\"geo-pi-sandbox\",\"email\":\"sandbox@geo.localhost\",\"password\":\"${operator_password}\",\"tenantSlug\":\"sample-travel\"}]"
readonly agent_credentials="[{\"tenantId\":\"${tenant_id}\",\"accessToken\":\"${agent_token}\"}]"
readonly worker_actors="{\"${tenant_id}\":\"${worker_principal_id}\",\"20000000-0000-4000-8000-000000000001\":\"20000000-0000-4000-8000-000000000102\"}"
readonly assisted_accounts="[{\"tenantId\":\"${tenant_id}\",\"channelAccountId\":\"${ctrip_account_id}\",\"bridgePrincipalId\":\"${ctrip_bridge_principal_id}\",\"adapterVersion\":\"ctrip-community-simulator-v1\",\"evidenceExpiresAt\":\"${evidence_expires_at}\",\"handoffTtlSeconds\":900}]"
readonly bridge_credentials="[{\"tenantId\":\"${tenant_id}\",\"accessToken\":\"${bridge_token}\"}]"
readonly bridge_tenants="[{\"tenantId\":\"${tenant_id}\",\"bridgePrincipalId\":\"${ctrip_bridge_principal_id}\",\"accessToken\":\"${bridge_token}\"}]"
readonly sandbox_env_stage="$(mktemp "${SECRET_ROOT}/.pi-automation-sandbox.env.XXXXXX")"
trap 'rm -f -- "${sandbox_env_stage}"' EXIT

{
  write_env_line COMPOSE_PROJECT_NAME "${PROJECT_NAME}"
  write_env_line GEO_IMAGE_PREFIX "${PROJECT_NAME}"
  write_env_line GEO_IMAGE_TAG local
  write_env_line NPM_REGISTRY "${npm_registry}"
  write_env_line POSTGRES_DB geo_saas
  write_env_line POSTGRES_ADMIN_USER geo_admin
  write_env_line POSTGRES_ADMIN_PASSWORD "${admin_password}"
  write_env_line GEO_API_DB_USER geo_api
  write_env_line GEO_API_DB_PASSWORD "${api_password}"
  write_env_line GEO_WORKER_DB_USER geo_worker
  write_env_line GEO_WORKER_DB_PASSWORD "${worker_password}"
  write_env_line GEO_IDENTITY_DB_USER geo_identity_login
  write_env_line GEO_IDENTITY_DB_PASSWORD "${identity_password}"
  write_env_line API_HOST_PORT "${API_PORT}"
  write_env_line WEB_PORT "${WEB_PORT}"
  write_env_line MCP_PORT "${MCP_PORT}"
  write_env_line CTRIP_BRIDGE_HOST_PORT "${BRIDGE_PORT}"
  write_env_line SESSION_SECRET "${session_secret}"
  write_env_line APP_ORIGIN "http://127.0.0.1:${WEB_PORT}"
  write_env_line GEO_OPERATOR_ORIGIN "http://127.0.0.1:${WEB_PORT}"
  write_env_line GEO_DEPLOYMENT_PROFILE customer_demo
  write_env_line GEO_GOVERNANCE_MODE demo_fixture
  write_env_line GEO_ALLOW_REAL_PI_IN_DEMO true
  write_env_line GEO_CONTEXT_RETRIEVAL_ENABLED false
  write_env_line WORKER_TENANT_ACTORS_JSON "${worker_actors}"
  write_env_line CTRIP_ASSISTED_ACCOUNTS_JSON "${assisted_accounts}"
  write_env_line CTRIP_CUSTOMER_ADAPTER_VERSION ctrip-community-simulator-v1
  write_env_line CTRIP_BRIDGE_GATEWAY_URL http://ctrip-bridge:9030
  write_env_line CTRIP_BRIDGE_GATEWAY_CREDENTIALS_JSON "${bridge_credentials}"
  write_env_line CTRIP_BRIDGE_TENANTS_JSON "${bridge_tenants}"
  write_env_line CTRIP_BRIDGE_MODE simulator
  write_env_line CTRIP_REVIEW_CDP_ENDPOINT http://127.0.0.1:10005
  write_env_line GEO_RUNTIME_TMP_ROOT /var/lib/geo/runtime/tmp
  write_env_line GEO_CTRIP_RUNTIME_ROOT /var/lib/geo/runtime
  write_env_line AGENT_PROVIDER "${agent_provider}"
  write_env_line AGENT_MODEL "${agent_model}"
  write_env_line AGENT_API "${agent_api}"
  write_env_line AGENT_BASE_URL "${agent_base_url}"
  write_env_line AGENT_API_KEY "${agent_api_key}"
  write_env_line AGENT_REASONING_EFFORT "${agent_reasoning_effort:-high}"
  write_env_line AGENT_STRICT_TOOL_ARGUMENTS "${agent_strict_tool_arguments:-false}"
  write_env_line AGENT_RUN_TIMEOUT_MS 900000
  write_env_line AGENT_GATEWAY_RUN_TIMEOUT_MS 910000
  write_env_line AGENT_GATEWAY_CREDENTIALS_JSON "${agent_credentials}"
  write_env_line AUTOMATION_PRODUCER_ENABLED true
  write_env_line AUTOMATION_PRODUCER_ID geo-pi-sandbox
  write_env_line AUTOMATION_PRODUCER_CONCURRENCY 1
  write_env_line AUTOMATION_DRAFT_TIMEOUT_MS 600000
  write_env_line GEO_MEDIA_PROVIDER disabled
  write_env_line GEO_MEDIA_SEARCH_PROVIDER "${media_search_provider}"
  write_env_line GEO_MEDIA_HTTPS_PROXY_URL "${media_https_proxy_url}"
  write_env_line PEXELS_API_KEY "${pexels_api_key}"
  write_env_line DOUBAO_ADAPTER fixture
  write_env_line QWEN_ADAPTER fixture
  write_env_line MCP_ALLOWED_HOSTS "127.0.0.1:9021,localhost:9021,127.0.0.1:${MCP_PORT},localhost:${MCP_PORT}"
  write_env_line MCP_ALLOWED_ORIGINS "http://127.0.0.1:${WEB_PORT}"
  write_env_line MCP_PRINCIPALS_JSON "${mcp_principals}"
  write_env_line GEO_BOOTSTRAP_TENANT_SLUG sample-travel
  write_env_line GEO_BOOTSTRAP_EMAIL sandbox@geo.localhost
  write_env_line GEO_BOOTSTRAP_DISPLAY_NAME 'Pi Automation Sandbox Owner'
  write_env_line GEO_BOOTSTRAP_PASSWORD "${operator_password}"
} >"${sandbox_env_stage}"
chmod 0600 "${sandbox_env_stage}"
mv -f -- "${sandbox_env_stage}" "${SANDBOX_ENV_FILE}"
trap - EXIT

readonly -a compose=(
  docker compose
  --project-directory "${ROOT_DIR}" \
  --env-file "${SANDBOX_ENV_FILE}" \
  -f "${ROOT_DIR}/compose.yaml" \
  -f "${ROOT_DIR}/compose.customer-demo.yaml" \
  -f "${ROOT_DIR}/compose.pi-automation-sandbox.yaml" \
  --profile fixture-seed \
  --profile operator-bootstrap \
  --profile customer-demo \
  --profile ctrip-simulator
)

# All database utility services share one image tag. Build one representative
# target so Compose does not export that tag concurrently for every alias.
"${compose[@]}" --parallel 1 build config-preflight api worker agent-mcp ctrip-bridge web

# nocopy prevents image-layer files from entering durable storage. Initialize only
# the empty volume roots so the unprivileged API can write evidence and media.
"${compose[@]}" create --no-build --no-deps api
for storage_volume in \
  "${PROJECT_NAME}_evidence-data" \
  "${PROJECT_NAME}_media-data"; do
  docker run --rm \
    --network none \
    --read-only \
    --cap-drop ALL \
    --cap-add CHOWN \
    --security-opt no-new-privileges=true \
    --user 0:0 \
    --mount "type=volume,src=${storage_volume},dst=/storage" \
    --entrypoint /bin/sh \
    "${PROJECT_NAME}-api:local" \
    -c 'chmod 0700 /storage && chown -R 1000:1000 /storage'
done

"${compose[@]}" up --detach --no-build

printf 'Pi automation sandbox started at http://127.0.0.1:%s\n' "${WEB_PORT}"
printf 'It is loopback-only, uses demo governance, and can only create dry-run simulator results.\n'
