#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

exec /usr/bin/node /usr/local/bin/browser-host-account-manager.mjs
