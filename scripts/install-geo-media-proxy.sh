#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

readonly PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly EXPECTED_CORE_SHA256=40e90c059a32cea321b2dbe4524051d65e377e665d9b88af5c99087a23a6d509
readonly EXPECTED_CORE_VERSION='Mihomo Meta v1.19.29 linux amd64 with go1.26.5 Sat Jul 18 12:20:02 UTC 2026'
readonly STATE_ROOT=/srv/geo-saas/media-proxy
readonly SECRET_FRAGMENT=/srv/geo-saas/secrets/geo-media-proxy.env
readonly BACKUP_ROOT=/srv/geo-saas/secrets/media-proxy-backups
readonly GEO_NETWORK=geo-saas_frontend
readonly GEO_RELEASE_ROOT=/srv/geo-saas/app/current
readonly GEO_ENV_FILE=/srv/geo-saas/secrets/geo.env
readonly NODE_IMAGE='node:24.4.0-bookworm-slim@sha256:1b044a60874f1b57ac8c4e708ddb3a00e55b34586ebbacce09a48796dafcc799'

die() {
  printf 'GEO media proxy installation failed: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage:
  install-geo-media-proxy.sh --binary /absolute/path/to/verge-mihomo
  install-geo-media-proxy.sh --repair-existing
EOF
  exit 64
}

mode=''
binary_path=''
case "$#:$1" in
  2:--binary)
    mode=fresh
    binary_path=$2
    ;;
  1:--repair-existing) mode=repair ;;
  *) usage ;;
esac

((EUID != 0)) || die 'run as the non-root GEO deploy user'
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] ||
  die 'the pinned Clash Verge core requires Linux x86_64'
[[ "$(id -u)" == 1000 && "$(id -g)" == 1000 ]] ||
  die 'the isolated images expect the GEO deploy identity 1000:1000'

for command_name in cp docker openssl python3 realpath sha256sum stat timeout; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command is unavailable: ${command_name}"
done
docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is unavailable'

[[ -d /srv/geo-saas && ! -L /srv/geo-saas ]] || die '/srv/geo-saas is missing or unsafe'
[[ "$(stat -c '%u:%g' -- /srv/geo-saas)" == "$(id -u):$(id -g)" ]] ||
  die '/srv/geo-saas must be owned by the GEO deploy user'
[[ -d /srv/geo-saas/secrets && ! -L /srv/geo-saas/secrets ]] ||
  die 'the GEO secret directory is missing or unsafe'
[[ "$(stat -c '%u:%g:%a' -- /srv/geo-saas/secrets)" == "$(id -u):$(id -g):700" ]] ||
  die 'the GEO secret directory must be deploy-owned with mode 700'
docker network inspect "${GEO_NETWORK}" >/dev/null 2>&1 ||
  die "the production application network is unavailable: ${GEO_NETWORK}"

validate_core() {
  local candidate=$1
  [[ "${candidate}" == /* ]] || die 'the Mihomo binary path must be absolute'
  candidate="$(realpath -e -- "${candidate}")" || die 'could not resolve the Mihomo binary'
  [[ -f "${candidate}" && ! -L "${candidate}" && -x "${candidate}" ]] ||
    die 'the Mihomo binary is missing, unsafe, or not executable'
  [[ "$(sha256sum -- "${candidate}" | awk '{print $1}')" == "${EXPECTED_CORE_SHA256}" ]] ||
    die 'the Mihomo binary does not match Clash Verge Rev v2.5.2'
  [[ "$("${candidate}" -v | head -n 1)" == "${EXPECTED_CORE_VERSION}" ]] ||
    die 'the Mihomo binary version is not the reviewed v2.5.2 core'
  printf '%s\n' "${candidate}"
}

subscription_url=''
proxy_password=''
backup_dir=''

if [[ "${mode}" == fresh ]]; then
  [[ ! -e "${STATE_ROOT}" && ! -L "${STATE_ROOT}" ]] ||
    die "refusing to replace an existing media proxy directory: ${STATE_ROOT}"
  [[ ! -e "${SECRET_FRAGMENT}" && ! -L "${SECRET_FRAGMENT}" ]] ||
    die "refusing to replace an existing media proxy Secret: ${SECRET_FRAGMENT}"
  binary_path="$(validate_core "${binary_path}")"

  subscription_verify=''
  printf 'Enter the Clash subscription URL (hidden; HTTPS only): ' >&2
  IFS= read -r -s subscription_url
  printf '\nVerify the Clash subscription URL: ' >&2
  IFS= read -r -s subscription_verify
  printf '\n' >&2
  [[ -n "${subscription_url}" && "${subscription_url}" == "${subscription_verify}" ]] ||
    die 'subscription URLs do not match'
  proxy_password="$(openssl rand -hex 32)" || die 'could not generate the proxy credential'
else
  [[ -d "${STATE_ROOT}" && ! -L "${STATE_ROOT}" ]] ||
    die "the existing media proxy directory is missing or unsafe: ${STATE_ROOT}"
  [[ "$(stat -c '%u:%g:%a' -- "${STATE_ROOT}")" == "$(id -u):$(id -g):700" ]] ||
    die 'the existing media proxy directory must be deploy-owned with mode 700'
  [[ -f "${SECRET_FRAGMENT}" && ! -L "${SECRET_FRAGMENT}" ]] ||
    die 'the existing media proxy Secret is missing or unsafe'
  [[ "$(stat -c '%u:%g:%a' -- "${SECRET_FRAGMENT}")" == "$(id -u):$(id -g):600" ]] ||
    die 'the existing media proxy Secret must be deploy-owned with mode 600'
  binary_path="$(validate_core "${STATE_ROOT}/bin/mihomo")"

  mapfile -t recovered_values < <(python3 - "${STATE_ROOT}/config.yaml" "${SECRET_FRAGMENT}" <<'PY'
import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

config_path, secret_path = map(Path, sys.argv[1:])
config_lines = config_path.read_text().splitlines()
url_lines = [line for line in config_lines if line.strip().startswith('url: "https://')]
if len(url_lines) != 1:
    raise SystemExit("expected exactly one legacy subscription URL")
subscription_url = json.loads(url_lines[0].split("url:", 1)[1].strip())
secret_lines = secret_path.read_text().splitlines()
prefix = "GEO_MEDIA_HTTPS_PROXY_URL="
proxy_lines = [line[len(prefix):] for line in secret_lines if line.startswith(prefix)]
if len(proxy_lines) != 1:
    raise SystemExit("expected exactly one media proxy URL")
parts = urlsplit(proxy_lines[0])
password = unquote(parts.password or "")
if (
    parts.scheme != "http"
    or parts.hostname != "geo-media-proxy"
    or parts.port != 7890
    or unquote(parts.username or "") != "geo-media"
    or not re.fullmatch(r"[0-9a-f]{64}", password)
):
    raise SystemExit("the existing media proxy URL is invalid")
print(subscription_url)
print(password)
PY
  ) || die 'could not recover the existing media proxy credentials'
  [[ "${#recovered_values[@]}" == 2 ]] || die 'existing media proxy credential recovery was incomplete'
  subscription_url=${recovered_values[0]}
  proxy_password=${recovered_values[1]}

  install -d -o "$(id -u)" -g "$(id -g)" -m 0700 "${BACKUP_ROOT}"
  backup_dir="${BACKUP_ROOT}/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  install -d -o "$(id -u)" -g "$(id -g)" -m 0700 "${backup_dir}"
  : >"${backup_dir}/manifest"
  chmod 0600 "${backup_dir}/manifest"
  for filename in config.yaml compose.yaml Dockerfile .dockerignore subscription-fetcher.mjs subscription-url; do
    if [[ -f "${STATE_ROOT}/${filename}" && ! -L "${STATE_ROOT}/${filename}" ]]; then
      cp -p -- "${STATE_ROOT}/${filename}" "${backup_dir}/${filename}"
      printf '%s\n' "${filename}" >>"${backup_dir}/manifest"
    fi
  done
fi

[[ ${#subscription_url} -le 4096 && "${subscription_url}" =~ ^https://[^[:space:]]+$ ]] ||
  die 'subscription URL must be a bounded HTTPS URL without spaces'
[[ "${proxy_password}" =~ ^[0-9a-f]{64}$ ]] || die 'media proxy credential is invalid'
readonly proxy_url="http://geo-media:${proxy_password}@geo-media-proxy:7890"

rollback_installation() {
  local status=$?
  trap - EXIT INT TERM
  ((status != 0)) || exit 0
  set +e
  if [[ "${mode}" == fresh ]]; then
    if [[ -f "${STATE_ROOT}/compose.yaml" ]]; then
      docker compose --project-directory "${STATE_ROOT}" -f "${STATE_ROOT}/compose.yaml" down --remove-orphans >/dev/null 2>&1
    fi
    rm -rf -- "${STATE_ROOT}"
    rm -f -- "${SECRET_FRAGMENT}"
  else
    if [[ -f "${STATE_ROOT}/compose.yaml" ]]; then
      docker compose --project-directory "${STATE_ROOT}" -f "${STATE_ROOT}/compose.yaml" down --remove-orphans >/dev/null 2>&1
    fi
    for filename in config.yaml compose.yaml Dockerfile .dockerignore subscription-fetcher.mjs subscription-url; do
      rm -f -- "${STATE_ROOT}/${filename}"
    done
    while IFS= read -r filename; do
      [[ -n "${filename}" ]] || continue
      cp -p -- "${backup_dir}/${filename}" "${STATE_ROOT}/${filename}"
    done <"${backup_dir}/manifest"
    if [[ -f "${STATE_ROOT}/compose.yaml" ]]; then
      docker compose --project-directory "${STATE_ROOT}" -f "${STATE_ROOT}/compose.yaml" up --detach --wait --wait-timeout 180 >/dev/null 2>&1
    fi
  fi
  printf 'GEO media proxy changes were rolled back after a failed installation.\n' >&2
  exit "${status}"
}
trap rollback_installation EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

install -d -o "$(id -u)" -g "$(id -g)" -m 0700 \
  "${STATE_ROOT}" "${STATE_ROOT}/bin" "${STATE_ROOT}/data"
if [[ "${mode}" == fresh ]]; then
  install -o "$(id -u)" -g "$(id -g)" -m 0500 "${binary_path}" "${STATE_ROOT}/bin/mihomo"
fi

config_stage="$(mktemp "${STATE_ROOT}/.config.yaml.XXXXXX")"
subscription_stage="$(mktemp "${STATE_ROOT}/.subscription-url.XXXXXX")"
fetcher_stage="$(mktemp "${STATE_ROOT}/.subscription-fetcher.mjs.XXXXXX")"
dockerfile_stage="$(mktemp "${STATE_ROOT}/.Dockerfile.XXXXXX")"
dockerignore_stage="$(mktemp "${STATE_ROOT}/.dockerignore.XXXXXX")"
compose_stage="$(mktemp "${STATE_ROOT}/.compose.yaml.XXXXXX")"

cat >"${config_stage}" <<EOF
mixed-port: 7890
allow-lan: true
bind-address: "0.0.0.0"
mode: rule
log-level: warning
ipv6: false
unified-delay: true
tcp-concurrent: true
authentication:
  - "geo-media:${proxy_password}"
profile:
  store-selected: false
  store-fake-ip: false
proxy-providers:
  media-subscription:
    type: http
    url: http://subscription-fetcher:7800/subscription
    proxy: DIRECT
    path: ./providers/media-subscription.yaml
    interval: 3600
    health-check:
      enable: true
      url: https://www.gstatic.com/generate_204
      interval: 300
proxy-groups:
  - name: MEDIA
    type: url-test
    use:
      - media-subscription
    url: https://www.gstatic.com/generate_204
    interval: 300
    tolerance: 100
rules:
  - DOMAIN-SUFFIX,wikimedia.org,MEDIA
  - DOMAIN-SUFFIX,wikipedia.org,MEDIA
  - MATCH,REJECT
EOF
chmod 0600 "${config_stage}"
printf '%s\n' "${subscription_url}" >"${subscription_stage}"
chmod 0600 "${subscription_stage}"

cat >"${fetcher_stage}" <<'EOF'
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const maxBytes = 8 * 1024 * 1024;
const subscriptionUrl = (await readFile("/run/secrets/subscription-url", "utf8")).trim();
const parsedUrl = new URL(subscriptionUrl);
if (parsedUrl.protocol !== "https:" || subscriptionUrl.length > 4096) {
  throw new Error("invalid subscription URL");
}

let cachedBody;
let refreshPromise;

async function fetchSubscription() {
  const response = await fetch(subscriptionUrl, {
    headers: { accept: "*/*", "user-agent": "clash.meta" },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || new URL(response.url).protocol !== "https:" || response.body === null) {
    throw new Error("subscription request failed");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("subscription response is too large");
  }
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) throw new Error("subscription response is too large");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks, totalBytes);
  const text = body.toString("utf8");
  if (!/^proxies:/mu.test(text) || body.length === 0) {
    throw new Error("subscription response is not a Clash YAML document");
  }
  cachedBody = body;
  return body;
}

async function currentSubscription() {
  if (refreshPromise === undefined) {
    refreshPromise = fetchSubscription().finally(() => {
      refreshPromise = undefined;
    });
  }
  try {
    return await refreshPromise;
  } catch (error) {
    if (cachedBody !== undefined) return cachedBody;
    throw error;
  }
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }
  if (request.method !== "GET" || request.url !== "/subscription") {
    response.writeHead(404, { "cache-control": "no-store" });
    response.end();
    return;
  }
  try {
    const body = await currentSubscription();
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-length": String(body.length),
      "content-type": "text/yaml; charset=utf-8",
    });
    response.end(body);
  } catch (error) {
    console.error("Subscription refresh failed", error instanceof Error ? error.name : "Error");
    response.writeHead(502, { "cache-control": "no-store" });
    response.end();
  }
});
server.maxConnections = 16;
server.headersTimeout = 10_000;
server.requestTimeout = 40_000;
server.listen(7800, "0.0.0.0");
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
EOF
chmod 0400 "${fetcher_stage}"

cat >"${dockerfile_stage}" <<EOF
FROM ${NODE_IMAGE}
ARG GEO_IMAGE_REVISION=clash-verge-rev-v2.5.2
LABEL org.opencontainers.image.revision="\${GEO_IMAGE_REVISION}"
COPY --chown=node:node bin/mihomo /usr/local/bin/mihomo
RUN chmod 0555 /usr/local/bin/mihomo
USER node
WORKDIR /var/lib/mihomo
ENTRYPOINT ["/usr/local/bin/mihomo"]
CMD ["-d", "/var/lib/mihomo", "-f", "/run/secrets/config.yaml"]
EOF
chmod 0400 "${dockerfile_stage}"

cat >"${dockerignore_stage}" <<'EOF'
*
!Dockerfile
!bin/
!bin/mihomo
EOF
chmod 0400 "${dockerignore_stage}"

cat >"${compose_stage}" <<EOF
name: geo-media-proxy
x-security: &security
  restart: unless-stopped
  user: "1000:1000"
  read_only: true
  init: true
  cap_drop:
    - ALL
  security_opt:
    - no-new-privileges:true
  pids_limit: 128
  mem_limit: 384m
  stop_grace_period: 20s
  tmpfs:
    - /tmp:rw,noexec,nosuid,nodev,size=16m
  logging:
    driver: json-file
    options:
      max-size: 10m
      max-file: "3"
services:
  subscription-fetcher:
    <<: *security
    image: ${NODE_IMAGE}
    command:
      - node
      - /opt/geo/subscription-fetcher.mjs
    volumes:
      - type: bind
        source: ./subscription-fetcher.mjs
        target: /opt/geo/subscription-fetcher.mjs
        read_only: true
      - type: bind
        source: ./subscription-url
        target: /run/secrets/subscription-url
        read_only: true
    networks:
      - subscription-control
      - subscription-egress
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - >-
          fetch('http://127.0.0.1:7800/health',{signal:AbortSignal.timeout(3000)})
          .then(response=>{if(response.status!==204)process.exit(1)})
          .catch(()=>process.exit(1))
      interval: 15s
      timeout: 5s
      retries: 8
      start_period: 10s
  proxy:
    <<: *security
    image: geo-media-proxy:mihomo-v1.19.29-clash-verge-v2.5.2
    build:
      context: .
      dockerfile: Dockerfile
      args:
        GEO_IMAGE_REVISION: clash-verge-rev-v2.5.2
    volumes:
      - type: bind
        source: ./config.yaml
        target: /run/secrets/config.yaml
        read_only: true
      - type: bind
        source: ./data
        target: /var/lib/mihomo
    networks:
      geo-frontend:
        aliases:
          - geo-media-proxy
      subscription-control: {}
    depends_on:
      subscription-fetcher:
        condition: service_healthy
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - >-
          const net=require('node:net');const socket=net.connect(7890,'127.0.0.1');
          const timer=setTimeout(()=>{socket.destroy();process.exit(1)},3000);
          socket.once('connect',()=>{clearTimeout(timer);socket.end()});
          socket.once('error',()=>{clearTimeout(timer);process.exit(1)});
      interval: 15s
      timeout: 5s
      retries: 8
      start_period: 20s
networks:
  geo-frontend:
    external: true
    name: geo-saas_frontend
  subscription-control:
    internal: true
  subscription-egress:
    driver: bridge
EOF
chmod 0400 "${compose_stage}"

timeout --signal=TERM --kill-after=5s 120s \
  "${STATE_ROOT}/bin/mihomo" -t -d "${STATE_ROOT}/data" -f "${config_stage}" \
  >/dev/null 2>&1 || die 'Mihomo rejected the generated configuration'

mv -fT -- "${config_stage}" "${STATE_ROOT}/config.yaml"
mv -fT -- "${subscription_stage}" "${STATE_ROOT}/subscription-url"
mv -fT -- "${fetcher_stage}" "${STATE_ROOT}/subscription-fetcher.mjs"
mv -fT -- "${dockerfile_stage}" "${STATE_ROOT}/Dockerfile"
mv -fT -- "${dockerignore_stage}" "${STATE_ROOT}/.dockerignore"
mv -fT -- "${compose_stage}" "${STATE_ROOT}/compose.yaml"

if [[ "${mode}" == fresh ]]; then
  secret_stage="$(mktemp /srv/geo-saas/secrets/.geo-media-proxy.env.XXXXXX)" ||
    die 'could not create the media proxy Secret stage'
  printf 'GEO_MEDIA_HTTPS_PROXY_URL=%s\n' "${proxy_url}" >"${secret_stage}"
  chmod 0600 "${secret_stage}"
  mv -fT -- "${secret_stage}" "${SECRET_FRAGMENT}"
fi

docker compose --project-directory "${STATE_ROOT}" -f "${STATE_ROOT}/compose.yaml" config --quiet ||
  die 'generated media proxy Compose configuration is invalid'
docker compose --project-directory "${STATE_ROOT}" -f "${STATE_ROOT}/compose.yaml" \
  up --detach --build --wait --wait-timeout 180 || die 'media proxy did not become healthy'

for container_name in geo-media-proxy-proxy-1 geo-media-proxy-subscription-fetcher-1; do
  port_bindings="$(docker inspect --format '{{json .HostConfig.PortBindings}}' "${container_name}")"
  [[ "${port_bindings}" == null || "${port_bindings}" == '{}' ]] ||
    die "media proxy container unexpectedly publishes a host port: ${container_name}"
done

[[ -f "${GEO_ENV_FILE}" && ! -L "${GEO_ENV_FILE}" ]] ||
  die 'the production GEO env file is unavailable for the isolated probe'
probe_output="$({ printf '%s' "${proxy_url}"; } | \
  docker compose --project-directory "${GEO_RELEASE_ROOT}" --env-file "${GEO_ENV_FILE}" \
    -f "${GEO_RELEASE_ROOT}/compose.yaml" -f "${GEO_RELEASE_ROOT}/compose.production.yaml" \
    --profile production exec -T api node --input-type=module -e '
      let proxyUrl = "";
      for await (const chunk of process.stdin) proxyUrl += chunk;
      try {
        const { WikimediaCommonsImageSearchProvider } = await import("@geo/media");
        const provider = new WikimediaCommonsImageSearchProvider({ proxyUrl });
        try {
          const candidates = await provider.search({
            query: "Tokyo Station",
            limit: 3,
            signal: AbortSignal.timeout(60_000),
          });
          if (candidates.length === 0) throw new Error("MEDIA_PROXY_SEARCH_EMPTY");
          const image = await provider.downloadAndNormalize({
            candidate: candidates[0],
            signal: AbortSignal.timeout(60_000),
          });
          console.log(JSON.stringify({
            provider: provider.provider,
            candidateCount: candidates.length,
            normalized: image.mimeType === "image/jpeg" && image.width === 1200 && image.height === 900,
          }));
        } finally {
          await provider.close();
        }
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error &&
          typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code)
          ? error.code
          : "MEDIA_PROXY_PROBE_FAILED";
        console.log(JSON.stringify({ errorCode: code }));
        process.exitCode = 1;
      }
    ')" || die 'real Wikimedia search/download probe through the media proxy failed'
[[ "${probe_output}" == *'"provider":"wikimedia_commons"'* && \
   "${probe_output}" == *'"normalized":true'* ]] ||
  die 'media proxy probe returned an invalid result'

trap - EXIT INT TERM
printf 'Installed GEO media proxy: Mihomo v1.19.29 from Clash Verge Rev v2.5.2\n'
printf 'Proxy and private subscription fetcher are healthy, publish no host ports, and passed a real Wikimedia probe.\n'
printf 'Production env fragment: %s (mode 600)\n' "${SECRET_FRAGMENT}"
if [[ -n "${backup_dir}" ]]; then
  printf 'Restricted pre-repair backup retained at: %s\n' "${backup_dir}"
fi
printf 'GEO has not been restarted and geo.env has not been modified.\n'
