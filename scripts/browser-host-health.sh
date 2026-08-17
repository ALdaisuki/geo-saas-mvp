#!/usr/bin/env bash
set -Eeuo pipefail

readonly PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

curl --fail --silent --show-error --max-time 2 \
  http://127.0.0.1:10005/health/live >/dev/null
curl --fail --silent --show-error --max-time 2 \
  http://127.0.0.1:10007/vnc.html >/dev/null
