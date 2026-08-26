#!/usr/bin/env bash
# ==================================================================================================
# WarmHawk Core Engine — tests/e2e-install/test-restart-persistence.sh
# Local regression test for the volume-mount contract every service in docker-compose.yml relies
# on: a customer restarting their box (or just running `docker compose down` / `up -d` themselves)
# must never lose data, since postgres_data/redis_data/etc. are the only thing standing between
# "restart" and "silent data loss."
# --------------------------------------------------------------------------------------------------
# Like test-port-fallback.sh, this needs neither a real scratch VM nor real public DNS. What it
# verifies is different: that a `docker compose down` (WITHOUT -v — never destroying volumes,
# exactly what a customer rebooting their server or restarting the stack would do) followed by
# `docker compose up -d` brings every service back up healthy with prior data intact, not a fresh
# empty database.
#
# What this script does, in order:
#   1. Runs scripts/install.sh --domain <non-resolving test domain> --skip-certbot once, isolated
#      into its own Compose project (COMPOSE_PROJECT_NAME) so it never touches any other stack
#      already running on this machine.
#   2. Confirms the app is healthy, then writes a marker row directly into Postgres.
#   3. `docker compose down` (no -v) — simulates a reboot/restart, not a wipe.
#   4. `docker compose up -d` — brings the exact same stack back up against the same volumes.
#   5. Asserts: every service comes back healthy, and the marker row written in step 2 is still
#      there — proving the restart cycle didn't touch the underlying volumes.
#   6. Tears its OWN stack down (this time WITH -v — this is the test's own final cleanup, not the
#      restart being simulated), always, even on failure.
# ==================================================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

TEST_DOMAIN="warmhawk-restart-test.invalid"   # .invalid never resolves (RFC 2606) — no real DNS/network needed
MARKER_NOTE="restart-persistence-canary-$$"
export COMPOSE_PROJECT_NAME="warmhawk-e2e-restart"

log()  { echo "[test-restart-persistence] $*"; }
fail() {
  echo "[test-restart-persistence] FAIL: $*" >&2
  exit 1
}

# See test-port-fallback.sh's identical guard for why this exists: only ever set true once the
# pre-existence guard below has actually passed — otherwise a pre-existing .env that doesn't
# belong to this run gets deleted by this trap on the exact failure path meant to protect it.
OWN_ENV=false

cleanup() {
  local exit_code=$?
  log "Tearing down (project-scoped, WITH volumes this time — does not touch any other stack on this host)..."
  docker compose -f "$REPO_ROOT/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME" down -v --remove-orphans >/dev/null 2>&1 || true
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

# Defensive pre-cleanup — same reasoning as test-port-fallback.sh's own.
log "Pre-cleanup: removing any leftover state (including volumes) from a prior interrupted run of this test..."
docker compose -f "$REPO_ROOT/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME" down -v --remove-orphans >/dev/null 2>&1 || true

compose() { docker compose -f "$REPO_ROOT/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME" "$@"; }

wait_for_health() {
  local label="$1"
  log "Polling http://localhost/health for a real response ($label)..."
  for i in $(seq 1 30); do
    BODY="$(curl -s "http://localhost/health" || true)"
    case "$BODY" in
      *'"status"'*'"ok"'*) log "Confirmed healthy ($label): ${BODY}"; return 0 ;;
    esac
    sleep 2
  done
  fail "http://localhost/health never returned {\"status\":\"ok\"} ($label). Last body: ${BODY}"
}

# --- 1. Install -------------------------------------------------------------------------------
log "Running scripts/install.sh --domain ${TEST_DOMAIN} --skip-certbot..."
(
  cd "$REPO_ROOT"
  ./scripts/install.sh --domain "$TEST_DOMAIN" --skip-certbot --cert-path /dev/null --key-path /dev/null
) || fail "install.sh failed — can't test restart persistence without a working install."

wait_for_health "before restart"

# --- 2. Write a marker row directly into Postgres, independent of any real application schema ---
log "Writing a marker row into Postgres (independent of the app's own schema, so this test never breaks on an unrelated migration change)..."
compose exec -T postgres psql -U warmhawk -d warmhawk -c \
  "CREATE TABLE IF NOT EXISTS e2e_restart_marker (id serial PRIMARY KEY, note text); INSERT INTO e2e_restart_marker (note) VALUES ('${MARKER_NOTE}');" \
  || fail "Could not write the marker row before the restart — Postgres isn't actually reachable despite /health reporting ok."
log "Marker row written: ${MARKER_NOTE}"

# --- 3. Simulate a restart/reboot — down WITHOUT -v, then up again -----------------------------
log "Bringing the stack down (no -v — volumes persist, simulating a reboot, not a wipe)..."
compose down --remove-orphans || fail "docker compose down failed."

log "Bringing the stack back up against the same volumes..."
compose up -d || fail "docker compose up -d failed after the simulated restart."

# --- 4. Assert everything came back — healthy AND with the marker row intact -------------------
wait_for_health "after restart"

log "Confirming the marker row survived the restart..."
FOUND_NOTE="$(compose exec -T postgres psql -U warmhawk -d warmhawk -tAc \
  "SELECT note FROM e2e_restart_marker WHERE note = '${MARKER_NOTE}';" || true)"
[ "$(echo "$FOUND_NOTE" | tr -d '[:space:]')" = "$MARKER_NOTE" ] \
  || fail "Marker row '${MARKER_NOTE}' did not survive the restart — postgres_data did not persist across down/up. Got: '${FOUND_NOTE}'"
log "Confirmed: marker row survived the restart intact."

log ""
log "=================================================================================="
log " RESTART-PERSISTENCE TEST: ALL ASSERTIONS PASSED"
log "   - the stack came back healthy after a down (no -v) / up -d cycle"
log "   - data written to Postgres before the restart was still present after it"
log "=================================================================================="

exit 0
