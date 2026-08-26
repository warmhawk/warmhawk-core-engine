#!/usr/bin/env bash
# ==================================================================================================
# WarmHawk Core Engine — tests/e2e-install/test-port-fallback.sh
# Local regression test for scripts/install.sh's alt-port co-exist mode.
# --------------------------------------------------------------------------------------------------
# Unlike tests/e2e-install/run.sh (which needs a real scratch VM + real public DNS for certbot's
# HTTP-01 challenge), this test needs neither. The behavior it verifies — install.sh detecting that
# 80/443 are already taken and falling back to alt ports instead of failing — is pure local Docker
# port-binding logic, so it runs anywhere Docker runs: a laptop, a normal CI runner, no scratch VM.
#
# It deliberately does NOT exercise real TLS/certbot issuance in alt-port mode (that still requires
# a real domain forwarding through a real reverse proxy — see docs/troubleshooting.md's "Installing
# alongside an existing web server"). It runs with --skip-certbot instead, and verifies the thing
# that's actually new here: the fallback triggers, the stack comes up anyway, and the app is
# genuinely reachable through the alt port, not just "the container started."
#
# What this script does, in order:
#   1. Starts a throwaway container bound to 80/443 — simulates a customer's box that already runs
#      something else there (a hand-rolled nginx, another app, warmhawk-enterprise-operator, etc).
#   2. Runs scripts/install.sh --domain <non-resolving test domain> --skip-certbot, isolated into
#      its own Compose project (COMPOSE_PROJECT_NAME) so it never touches any other stack already
#      running on this machine.
#   3. Asserts install.sh actually fell back (didn't just fail): .env picked up alt ports, nginx is
#      running and bound to them, and a real HTTP request through the alt port reaches the API.
#   4. Tears its OWN stack down (`docker compose -p ... down -v`, project-scoped — never touches
#      sibling containers) and removes the port-hog container, always, even on failure.
# ==================================================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

TEST_DOMAIN="warmhawk-port-fallback-test.invalid"   # .invalid never resolves (RFC 2606) — no real DNS/network needed
ALT_HTTP_PORT="${ALT_HTTP_PORT:-8080}"
ALT_HTTPS_PORT="${ALT_HTTPS_PORT:-8443}"
PORT_HOG_NAME="warmhawk-e2e-port-hog"
export COMPOSE_PROJECT_NAME="warmhawk-e2e-portfallback"

log()  { echo "[test-port-fallback] $*"; }
fail() {
  echo "[test-port-fallback] FAIL: $*" >&2
  exit 1
}

# Bug fix (deeper-coverage authoring pass, 2026-08-26): only ever set true once the
# pre-existence guard below has actually passed. Earlier, this trap's `rm -f "$REPO_ROOT/.env"`
# ran unconditionally — including on the exact failure path where the guard rejects a
# PRE-EXISTING .env that does not belong to this run, which deleted it anyway. Confirmed live:
# a stray .env left over from unrelated manual testing was destroyed this way, with no running
# containers left to prove after the fact whether it was actually still load-bearing.
OWN_ENV=false

cleanup() {
  local exit_code=$?
  log "Tearing down (project-scoped — does not touch any other stack on this host)..."
  docker compose -f "$REPO_ROOT/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME" down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f "$PORT_HOG_NAME" >/dev/null 2>&1 || true
  [ "$OWN_ENV" = true ] && rm -f "$REPO_ROOT/.env"
  if [ "$exit_code" -eq 0 ]; then
    log "Teardown complete. PASSED."
  else
    log "Teardown complete. FAILED (exit $exit_code)."
  fi
  exit "$exit_code"
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || fail "Docker is not installed."
docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin is not available."
[ -f "$REPO_ROOT/.env" ] && fail "$REPO_ROOT/.env already exists — refusing to overwrite a real install's config. Remove it (after confirming it's not a live instance) and re-run."
OWN_ENV=true

# Defensive pre-cleanup: a prior run of this same test killed mid-build/mid-up (Ctrl-C, CI cancel,
# an interrupted session) can leave containers behind under this project name before its own EXIT
# trap gets a chance to run. Starting from a guaranteed-clean slate here means a stale leftover
# container never masquerades as a false failure on the next run.
log "Pre-cleanup: removing any leftover state from a prior interrupted run of this test..."
docker compose -f "$REPO_ROOT/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME" down -v --remove-orphans >/dev/null 2>&1 || true
docker rm -f "$PORT_HOG_NAME" >/dev/null 2>&1 || true

# --- 1. Occupy 80/443 with a throwaway container, simulating a non-empty customer box ------------
log "Starting a throwaway container on 80/443 (simulates an already-occupied customer box)..."
docker rm -f "$PORT_HOG_NAME" >/dev/null 2>&1 || true
docker run -d --name "$PORT_HOG_NAME" -p 80:80 -p 443:443 nginx:1.27-alpine >/dev/null \
  || fail "Could not start the port-hog container — is something else already using 80/443 on this host? Free them first."

for i in $(seq 1 15); do
  status="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:80/ || echo 000)"
  [ "$status" -ge 200 ] && [ "$status" -lt 500 ] && break
  sleep 1
done
[ "$status" -ge 200 ] && [ "$status" -lt 500 ] || fail "Port-hog container never came up on port 80 — can't validate the fallback without something genuinely occupying it."
log "Port-hog confirmed listening on 80/443."

# --- 2. Run the real install.sh against the now-occupied host -------------------------------------
log "Running scripts/install.sh --domain ${TEST_DOMAIN} --skip-certbot (real script, isolated Compose project)..."
(
  cd "$REPO_ROOT"
  ./scripts/install.sh --domain "$TEST_DOMAIN" --skip-certbot --cert-path /dev/null --key-path /dev/null
) || fail "install.sh exited non-zero — it should degrade to alt-port mode, not fail outright, when 80/443 are occupied."

# --- 3. Assert the fallback actually happened, not just "didn't crash" ---------------------------
grep -q "^NGINX_HTTP_HOST_PORT=${ALT_HTTP_PORT}$" "$REPO_ROOT/.env" \
  || fail ".env does not show NGINX_HTTP_HOST_PORT=${ALT_HTTP_PORT} — fallback did not trigger as expected. Contents: $(grep NGINX_ "$REPO_ROOT/.env" || true)"
grep -q "^NGINX_HTTPS_HOST_PORT=${ALT_HTTPS_PORT}$" "$REPO_ROOT/.env" \
  || fail ".env does not show NGINX_HTTPS_HOST_PORT=${ALT_HTTPS_PORT} — fallback did not trigger as expected."
log "Confirmed: .env recorded the alt ports (${ALT_HTTP_PORT}/${ALT_HTTPS_PORT})."

docker compose -f "$REPO_ROOT/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME" ps nginx | grep -q "Up" \
  || fail "nginx container is not running after install.sh completed."
log "Confirmed: nginx container is running."

log "Polling http://localhost:${ALT_HTTP_PORT}/health for a real response through the alt port..."
HEALTH_OK=false
for i in $(seq 1 30); do
  BODY="$(curl -s "http://localhost:${ALT_HTTP_PORT}/health" || true)"
  case "$BODY" in
    *'"status"'*'"ok"'*) HEALTH_OK=true; break ;;
  esac
  sleep 2
done
[ "$HEALTH_OK" = true ] || fail "http://localhost:${ALT_HTTP_PORT}/health never returned {\"status\":\"ok\"} — nginx is up but not actually proxying to a healthy api through the alt port. Last body: ${BODY}"
log "Confirmed: GET http://localhost:${ALT_HTTP_PORT}/health -> ${BODY}"

# Non-goal, stated explicitly rather than silently skipped: real TLS/certbot issuance through a
# forwarding proxy still needs a real domain + real proxy config, and is NOT what this test covers.
log ""
log "=================================================================================="
log " PORT-FALLBACK TEST: ALL ASSERTIONS PASSED"
log "   - install.sh detected 80/443 occupied and fell back instead of failing"
log "   - nginx came up bound to ${ALT_HTTP_PORT}/${ALT_HTTPS_PORT}"
log "   - the app was genuinely reachable end to end through the alt port"
log "   - NOT covered here: real certbot issuance through a forwarding proxy (needs real DNS —"
log "     see docs/troubleshooting.md's 'Installing alongside an existing web server')"
log "=================================================================================="

exit 0
