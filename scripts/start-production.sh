#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${GEO_ENV_FILE:-${ROOT_DIR}/.env.production}"

if [[ ! -f "${ENV_FILE}" ]]; then
  printf 'Missing production env file: %s\n' "${ENV_FILE}" >&2
  printf 'Create it from .env.example and inject secrets through the server secret manager.\n' >&2
  exit 1
fi

cd "${ROOT_DIR}"

# This is the server entrypoint.  It intentionally does not read Codex settings,
# invoke a desktop client, or enable fixture seed/demo profiles.
docker compose \
  --env-file "${ENV_FILE}" \
  -f compose.yaml \
  -f compose.production.yaml \
  --profile production \
  config --quiet

docker compose \
  --env-file "${ENV_FILE}" \
  -f compose.yaml \
  -f compose.production.yaml \
  --profile production \
  run --rm config-preflight

docker compose \
  --env-file "${ENV_FILE}" \
  -f compose.yaml \
  -f compose.production.yaml \
  --profile production \
  up -d --build

docker compose \
  --env-file "${ENV_FILE}" \
  -f compose.yaml \
  -f compose.production.yaml \
  --profile production \
  ps --all
