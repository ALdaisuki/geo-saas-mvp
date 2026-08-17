#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly current_link=/srv/geo-saas/app/current
readonly begin_marker='# BEGIN GEO_SAAS_LOCAL_OPERATIONS'
readonly end_marker='# END GEO_SAAS_LOCAL_OPERATIONS'
readonly action=${1:-}

die() {
  printf 'Production local cron management failed: %s\n' "$1" >&2
  exit 1
}

usage() {
  printf 'Usage: manage-production-local-cron.sh install|verify|remove\n' >&2
  exit 64
}

(($# == 1)) || usage
case "${action}" in
  install|verify|remove) ;;
  *) usage ;;
esac

[[ "$(uname -s)" == Linux ]] || die 'local cron management runs only on Linux'
((EUID != 0)) || die 'run local cron management as the non-root deploy user'
for command_name in awk cat cmp crontab grep mktemp systemctl systemd-cat timeout; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command is unavailable: ${command_name}"
done
[[ -L "${current_link}" && -d "${current_link}" ]] || die 'current release link is missing or unsafe'
readonly release_root="$(cd -- "${current_link}" && pwd -P)"
for script_name in check-production-health.sh run-production-backup-cycle.sh; do
  [[ -f "${release_root}/scripts/${script_name}" && ! -L "${release_root}/scripts/${script_name}" &&
    -x "${release_root}/scripts/${script_name}" ]] ||
    die "active release script is missing or unsafe: ${script_name}"
done

readonly work_root="$(mktemp -d "${TMPDIR:-/tmp}/geo-local-cron.XXXXXX")"
readonly snapshot=${work_root}/current
readonly read_error=${work_root}/read-error
readonly expected=${work_root}/expected
readonly actual=${work_root}/actual
readonly staged=${work_root}/staged
trap 'rm -rf -- "${work_root}"' EXIT

write_managed_block() {
  cat <<'CRON'
# BEGIN GEO_SAAS_LOCAL_OPERATIONS
*/2 * * * * /bin/bash -o pipefail -c '/usr/bin/timeout --signal=TERM --kill-after=5s 9m /srv/geo-saas/app/current/scripts/check-production-health.sh --local-only 2>&1 | /usr/bin/systemd-cat --identifier=geo-saas-local-health'
15 3 * * * /bin/bash -o pipefail -c '/usr/bin/timeout --signal=TERM --kill-after=5s 45m /srv/geo-saas/app/current/scripts/run-production-backup-cycle.sh --local-only 2>&1 | /usr/bin/systemd-cat --identifier=geo-saas-local-backup'
# END GEO_SAAS_LOCAL_OPERATIONS
CRON
}

read_current_crontab() {
  local status
  : >"${snapshot}"
  : >"${read_error}"
  if crontab -l >"${snapshot}" 2>"${read_error}"; then
    return 0
  else
    status=$?
  fi
  if ((status == 1)) && [[ ! -s "${snapshot}" ]] &&
    grep -Eq '^no crontab for [A-Za-z0-9._-]+$' "${read_error}"; then
    return 0
  fi
  die 'could not read the deploy-user crontab'
}

require_no_managed_block() {
  [[ "$(grep -Fxc -- "${begin_marker}" "${snapshot}" || true)" == 0 &&
    "$(grep -Fxc -- "${end_marker}" "${snapshot}" || true)" == 0 ]] ||
    die 'the managed local operations block already exists or is malformed'
  if grep -Eq 'check-production-health\.sh --local-only|run-production-backup-cycle\.sh --local-only' \
    "${snapshot}"; then
    die 'an unmanaged local operations cron command already exists'
  fi
}

verify_managed_block() {
  local begin_count
  local end_count
  begin_count=$(grep -Fxc -- "${begin_marker}" "${snapshot}" || true)
  end_count=$(grep -Fxc -- "${end_marker}" "${snapshot}" || true)
  [[ "${begin_count}" == 1 && "${end_count}" == 1 ]] ||
    die 'the managed local operations block is missing or duplicated'
  write_managed_block >"${expected}"
  awk -v begin="${begin_marker}" -v end="${end_marker}" '
    $0 == begin { inside = 1; seen_begin += 1 }
    inside { print }
    $0 == end { inside = 0; seen_end += 1 }
    END {
      if (inside || seen_begin != 1 || seen_end != 1) exit 1
    }
  ' "${snapshot}" >"${actual}" || die 'the managed local operations block is malformed'
  cmp --silent -- "${expected}" "${actual}" || die 'the managed local operations block drifted'
  awk -v begin="${begin_marker}" -v end="${end_marker}" '
    $0 == begin { inside = 1; next }
    $0 == end { inside = 0; next }
    !inside && /check-production-health\.sh --local-only|run-production-backup-cycle\.sh --local-only/ {
      exit 1
    }
  ' "${snapshot}" || die 'a duplicate local operations cron command exists outside the managed block'
}

require_no_operations_timers() {
  local timer
  for timer in geo-saas-local-health.timer geo-saas-local-backup.timer \
    geo-saas-health.timer geo-saas-backup.timer; do
    if systemctl is-enabled --quiet "${timer}" 2>/dev/null ||
      systemctl is-active --quiet "${timer}"; then
      die "disable the systemd operations timer before enabling local cron: ${timer}"
    fi
  done
}

read_current_crontab
case "${action}" in
  install)
    require_no_operations_timers
    systemctl is-active --quiet cron || die 'the system cron daemon is not active'
    systemctl is-enabled --quiet cron || die 'the system cron daemon is not enabled at boot'
    require_no_managed_block
    {
      if [[ -s "${snapshot}" ]]; then
        cat "${snapshot}"
        printf '\n'
      fi
      write_managed_block
    } >"${staged}"
    crontab "${staged}" || die 'could not install the managed local operations block'
    read_current_crontab
    verify_managed_block
    printf 'Production local operations cron installed.\n'
    ;;
  verify)
    require_no_operations_timers
    systemctl is-active --quiet cron || die 'the system cron daemon is not active'
    systemctl is-enabled --quiet cron || die 'the system cron daemon is not enabled at boot'
    verify_managed_block
    printf 'Production local operations cron verified.\n'
    ;;
  remove)
    verify_managed_block
    awk -v begin="${begin_marker}" -v end="${end_marker}" '
      $0 == begin { inside = 1; next }
      $0 == end { inside = 0; next }
      !inside { print }
    ' "${snapshot}" >"${staged}"
    crontab "${staged}" || die 'could not remove the managed local operations block'
    read_current_crontab
    require_no_managed_block
    printf 'Production local operations cron removed.\n'
    ;;
esac
