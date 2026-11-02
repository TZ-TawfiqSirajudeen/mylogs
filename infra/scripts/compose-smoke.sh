#!/usr/bin/env bash
# Smoke test of the running compose stack. Needs Docker + curl. Used by .github/workflows/ci.yml; runnable locally:
#
#     docker compose up -d --build --wait && infra/scripts/compose-smoke.sh default
#     docker compose down -v
#     AUTH_MODE=oidc docker compose --profile oidc up -d --build --wait && infra/scripts/compose-smoke.sh oidc
#     docker compose --profile oidc down -v
#
# It only checks behaviour that is visible from the host through the published ports and through nginx (the same path a browser uses).
# Exit code 1 when any check fails. No credentials are involved (the stack uses the documented throw-away dev defaults).
set -uo pipefail
PHASE="${1:-default}"
API="${API_URL:-http://localhost:4000}"
INGEST="${INGEST_URL:-http://localhost:4318}"
WEB="${WEB_URL:-http://localhost:8080}"
failed=0

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1${2:+  -> $2}"; failed=1; }
status() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || echo 000; }
retry_ok() { curl -fsS -o /dev/null --max-time 10 --retry 20 --retry-delay 2 --retry-connrefused "$1"; }
expect_status() { # name expected curl-args...
  local name="$1" want="$2"; shift 2
  local got; got="$(status "$@")"
  if [ "$got" = "$want" ]; then pass "$name"; else fail "$name" "HTTP $got, wanted $want"; fi
}
expect_body() { # name regex url
  local body; body="$(curl -fsS --max-time 10 "$3" 2>/dev/null || true)"
  if echo "$body" | grep -Eq "$2"; then pass "$1"; else fail "$1" "body did not match $2"; fi
}
service_health() { # service
  local id; id="$(docker compose ps -q "$1" 2>/dev/null | head -n1)"
  [ -n "$id" ] || { fail "$1 container exists"; return; }
  local h; h="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")"
  if [ "$h" = "healthy" ]; then pass "$1 container is healthy"; else fail "$1 container is healthy" "health=$h"; fi
}

echo "== compose smoke, phase: $PHASE"
retry_ok "$API/healthz" && pass "api /healthz (published port 4000)" || fail "api /healthz"
retry_ok "$INGEST/healthz" && pass "ingest /healthz (published port 4318)" || fail "ingest /healthz"
retry_ok "$WEB/nginx-health" && pass "web /nginx-health (nginx up on 8080)" || fail "web /nginx-health"
for s in mongo api worker ingest web; do service_health "$s"; done

# nginx: SPA shell, security headers, a missing asset is a 404 (never the SPA shell), /api proxied to the API service
expect_status "web / serves the SPA" 200 "$WEB/"
hdrs="$(curl -sI --max-time 10 "$WEB/" | tr -d '\r')"
echo "$hdrs" | grep -qi '^content-security-policy:.*frame-ancestors' && pass "web / sends the CSP" || fail "web / sends the CSP"
echo "$hdrs" | grep -qi '^x-content-type-options: *nosniff' && pass "web / sends nosniff" || fail "web / sends nosniff"
echo "$hdrs" | grep -qi '^server: *nginx/' && fail "web / hides the nginx version (server_tokens off)" || pass "web / hides the nginx version (server_tokens off)"
expect_status "web /assets/missing.js is 404, not the SPA shell" 404 "$WEB/assets/does-not-exist.js"
expect_status "web deep link falls back to the SPA" 200 "$WEB/logs/some/deep/link"
expect_status "api via nginx: protected route needs a session" 401 "$WEB/api/v1/projects"

# ingest rejects unauthenticated telemetry
expect_status "ingest rejects a request without a token" 401 -X POST -H 'content-type: application/json' -d '{"resourceLogs":[]}' "$INGEST/v1/logs"

case "$PHASE" in
  default)
    expect_body "auth config via nginx reports dev mode" '"mode" *: *"dev"' "$WEB/api/v1/auth/config"
    ;;
  oidc)
    expect_body "auth config via nginx reports oidc mode" '"mode" *: *"oidc"' "$WEB/api/v1/auth/config"
    expect_status "dev login does not exist in oidc mode" 404 -X POST -H 'content-type: application/json' -H "origin: ${WEB_ORIGIN:-http://localhost:8080}" -d '{"email":"owner@acme.test"}' "$API/api/v1/auth/dev-login"
    # The API container must reach the mock IdP by its compose name, and the login must redirect to it (not to ?auth_error=idp_unavailable).
    loc="$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 15 "$WEB/api/v1/auth/oidc/login" || true)"
    case "$loc" in http://mock-idp:9000/*) pass "oidc login redirects to the mock IdP";; *) fail "oidc login redirects to the mock IdP" "redirect_url is not under http://mock-idp:9000/";; esac
    ;;
  *) echo "unknown phase: $PHASE"; exit 2 ;;
esac

if [ "$failed" -ne 0 ]; then echo "SMOKE FAILED"; exit 1; fi
echo "SMOKE OK"
