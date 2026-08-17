#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

die() {
  printf 'Production HTTPS verification failed: %s\n' "$1" >&2
  exit 1
}

usage() {
  printf 'Usage: verify-production-https.sh LOWERCASE_FQDN EXPECTED_IPV4 [CONNECT_IPV4]\n' >&2
  exit 64
}

((2 <= $# && $# <= 3)) || usage
readonly public_domain=$1
readonly expected_ipv4=$2
readonly connect_ipv4=${3:-${expected_ipv4}}

[[ "${public_domain}" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ &&
  "${public_domain}" != *..* ]] || die 'public domain is not a lowercase FQDN'
[[ "${expected_ipv4}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die 'expected IPv4 is invalid'
[[ "${connect_ipv4}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die 'connect IPv4 is invalid'

for command_name in curl dig openssl; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command is unavailable: ${command_name}"
done

readonly resolved_a="$(dig +short A "${public_domain}" | sed '/^$/d' | sort -u)"
[[ "${resolved_a}" == "${expected_ipv4}" ]] ||
  die "DNS A must resolve only to the expected production IPv4"
readonly resolved_aaaa="$(dig +short AAAA "${public_domain}" | sed '/^$/d' | sort -u)"
[[ -z "${resolved_aaaa}" ]] || die 'unexpected AAAA record exists for an IPv4-only production edge'

readonly temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/geo-https-verify.XXXXXX")"
trap 'rm -rf -- "${temporary_root}"' EXIT
readonly http_headers="${temporary_root}/http.headers"
readonly https_headers="${temporary_root}/https.headers"
readonly root_headers="${temporary_root}/root.headers"
readonly root_body="${temporary_root}/root.html"
readonly api_headers="${temporary_root}/api.headers"
readonly api_body="${temporary_root}/api.json"
readonly certificate="${temporary_root}/certificate.pem"
readonly tls_output="${temporary_root}/tls.output"
readonly tls_error="${temporary_root}/tls.error"

readonly http_status="$(curl --silent --show-error --noproxy '*' --connect-timeout 10 --max-time 20 \
  --resolve "${public_domain}:80:${connect_ipv4}" \
  --dump-header "${http_headers}" --output /dev/null --write-out '%{http_code}' \
  "http://${public_domain}/healthz")"
[[ "${http_status}" == 308 ]] || die "canonical HTTP request returned ${http_status}, expected 308"
tr -d '\r' <"${http_headers}" |
  grep -Fxiq "location: https://${public_domain}/healthz" ||
  die 'HTTP redirect Location is not the canonical HTTPS URL'

readonly unknown_host_status="$(curl --silent --show-error --noproxy '*' --connect-timeout 10 \
  --max-time 20 --header 'Host: invalid.invalid' --output /dev/null --write-out '%{http_code}' \
  "http://${connect_ipv4}/")"
[[ "${unknown_host_status}" == 421 ]] ||
  die "unknown HTTP Host returned ${unknown_host_status}, expected 421"

readonly https_status="$(curl --silent --show-error --noproxy '*' --connect-timeout 10 --max-time 20 \
  --proto '=https' --tlsv1.2 --resolve "${public_domain}:443:${connect_ipv4}" \
  --dump-header "${https_headers}" --output /dev/null --write-out '%{http_code}' \
  "https://${public_domain}/healthz")"
[[ "${https_status}" == 200 ]] || die "HTTPS readiness returned ${https_status}, expected 200"

readonly mismatched_https_host_status="$(curl --silent --show-error --noproxy '*' \
  --connect-timeout 10 --max-time 20 --proto '=https' --tlsv1.2 \
  --resolve "${public_domain}:443:${connect_ipv4}" --header 'Host: invalid.invalid' \
  --output /dev/null --write-out '%{http_code}' "https://${public_domain}/healthz")"
[[ "${mismatched_https_host_status}" == 421 ]] ||
  die "HTTPS SNI/Host mismatch returned ${mismatched_https_host_status}, expected 421"

readonly root_status="$(curl --silent --show-error --noproxy '*' --connect-timeout 10 --max-time 20 \
  --proto '=https' --tlsv1.2 --resolve "${public_domain}:443:${connect_ipv4}" \
  --dump-header "${root_headers}" --output "${root_body}" --write-out '%{http_code}' \
  "https://${public_domain}/")"
[[ "${root_status}" == 200 ]] || die "HTTPS web root returned ${root_status}, expected 200"
grep -Eiq '^content-type:[[:space:]]*text/html([;[:space:]]|$)' "${root_headers}" ||
  die 'HTTPS web root did not return an HTML content type'
grep -Eiq '<!doctype[[:space:]]+html|<html([[:space:]>])' "${root_body}" ||
  die 'HTTPS web root did not return an HTML document'

readonly api_status="$(curl --silent --show-error --noproxy '*' --connect-timeout 10 --max-time 20 \
  --proto '=https' --tlsv1.2 --resolve "${public_domain}:443:${connect_ipv4}" \
  --dump-header "${api_headers}" --output "${api_body}" --write-out '%{http_code}' \
  "https://${public_domain}/api/auth/session")"
[[ "${api_status}" == 401 ]] ||
  die "unauthenticated HTTPS API request returned ${api_status}, expected 401"
grep -Eiq '^content-type:[[:space:]]*application/json([;[:space:]]|$)' "${api_headers}" ||
  die 'unauthenticated HTTPS API response did not return JSON'
grep -Eq '"code"[[:space:]]*:[[:space:]]*"AUTHENTICATION_REQUIRED"' "${api_body}" ||
  die 'unauthenticated HTTPS API response did not return the expected authentication error'

for required_header in \
  'strict-transport-security: max-age=31536000' \
  'x-content-type-options: nosniff' \
  'x-frame-options: DENY' \
  'referrer-policy: same-origin' \
  'content-security-policy:'; do
  grep -Fiq "${required_header}" "${https_headers}" ||
    die "HTTPS response is missing required header: ${required_header}"
done

# LibreSSL can report a post-handshake poll error after emitting a valid certificate.
set +e
openssl s_client -connect "${connect_ipv4}:443" \
  -servername "${public_domain}" </dev/null >"${tls_output}" 2>"${tls_error}"
readonly tls_status=$?
set -e
if ((tls_status != 0)) && ! grep -Eiq 'poll error|post-handshake' "${tls_error}"; then
  die "TLS handshake failed: $(tr '\n' ' ' <"${tls_error}" | cut -c1-240)"
fi
openssl x509 -in "${tls_output}" -outform PEM >"${certificate}" ||
  die 'could not read the served TLS certificate'
openssl x509 -in "${certificate}" -noout -checkend 604800 >/dev/null ||
  die 'served TLS certificate expires within seven days'

printf 'Production HTTPS verification passed for https://%s via %s\n' "${public_domain}" "${connect_ipv4}"
