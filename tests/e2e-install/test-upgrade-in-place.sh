#!/usr/bin/env bash
# ==================================================================================================
# WarmHawk Core Engine — tests/e2e-install/test-upgrade-in-place.sh
# Local regression test for scripts/update.sh ("warmhawk update") — the zero-touch upgrade path
# every self-hosted customer runs against a live instance with real data in it. Never exercised by
# any other test: test-port-fallback.sh/test-idempotent-rerun.sh/test-restart-persistence.sh all
# only ever call install.sh.
# --------------------------------------------------------------------------------------------------
# Like the other tests in this directory (besides run.sh), this needs neither a real scratch VM nor
# real public DNS — it runs anywhere Docker (and git) runs. It deliberately does NOT test "does a
# genuinely older version upgrade cleanly to a genuinely newer one" (that would need a second real
# release to check out, and this repo's CI runs against whatever commit triggered it, not a fixed
# pair of tags). What it verifies instead is the thing that actually risks customer data: does
# update.sh's rebuild -> migrate -> rolling-restart sequence survive against a stack that already
# has real data in it, without losing that data or ending up unhealthy. update.sh is pointed at the
# exact commit SHA already checked out here (not its own "main" default) so this test can never
# silently upgrade away from the code actually under test.
#
# What this script does, in order:
#   1. Runs scripts/install.sh --domain <non-resolving test domain> --skip-certbot once, isolated
#      into its own Compose project (COMPOSE_PROJECT_NAME) so it never touches any other stack
#      already running on this machine.
#   2. Confirms the app is healthy, then writes a marker row directly into Postgres.
#   3. Runs scripts/update.sh <current-commit-sha> — the real upgrade command, unmodified.
#   4. Asserts: update.sh reported success, the app is healthy again afterward, and the marker row
#      from step 2 is still there — proving the rebuild/migrate/restart cycle didn't lose data.
#   5. Tears its OWN stack down, always, even on failure.
# ==================================================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

TEST_DOMAIN="warmhawk-upgrade-test.invalid"   # .invalid never resolves (RFC 2606) — no real DNS/network needed
MARKER_NOTE="upgrade-in-place-canary-$$"
export COMPOSE_PROJECT_NAME="warmhawk-e2e-upgrade"
# See test-port-fallback.sh's identical override for why this exists.
HEALTH_CHECK_HOST="${HEALTH_CHECK_HOST:-localhost}"

log()  { echo "[test-upgrade-in-place] $*"; }
fail() {
  echo "[test-upgrade-in-place] FAIL: $*" >&2
  exit 1
}

# See test-port-fallback.sh's identical guard for why this exists: only ever set true once the
# pre-existence guard below has actually passed — otherwise a pre-existing .env/.env that doesn't
# belong to this run gets deleted by this trap on the exact failure path meant to protect it.
OWN_ENV=false

cleanup() {
  local exit_code=$?
  log "Tearing down (project-scoped — does not touch any other stack on this host)..."
  docker compose -f "$REPO_ROOT/docker/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME" down -v --remove-orphans >/dev/null 2>&1 || true
  [ "$OWN_ENV" = true ] && rm -f "$REPO_ROOT/.env/.env"
  rm -f "${UPDATE_LOG:-}"
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
[ -f "$REPO_ROOT/.env/.env" ] && fail "$REPO_ROOT/.env/.env already exists — refusing to overwrite a real install's config. Remove it (after confirming it's not a live instance) and re-run."
OWN_ENV=true

# Defensive pre-cleanup — same reasoning as test-port-fallback.sh's own.
log "Pre-cleanup: removing any leftover state from a prior interrupted run of this test..."
docker compose -f "$REPO_ROOT/docker/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME" down -v --remove-orphans >/dev/null 2>&1 || true

compose() { docker compose --env-file "$REPO_ROOT/.env/.env" -f "$REPO_ROOT/docker/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME" "$@"; }

wait_for_health() {
  local label="$1"
  log "Polling http://${HEALTH_CHECK_HOST}/health for a real response ($label)..."
  for i in $(seq 1 30); do
    BODY="$(curl -s "http://${HEALTH_CHECK_HOST}/health" || true)"
    case "$BODY" in
      *'"status"'*'"ok"'*) log "Confirmed healthy ($label): ${BODY}"; return 0 ;;
    esac
    sleep 2
  done
  fail "http://${HEALTH_CHECK_HOST}/health never returned {\"status\":\"ok\"} ($label). Last body: ${BODY}"
}

# --- 1. Install -------------------------------------------------------------------------------
log "Running scripts/install.sh --domain ${TEST_DOMAIN} --skip-certbot..."
(
  cd "$REPO_ROOT"
  ./scripts/install.sh --domain "$TEST_DOMAIN" --skip-certbot --cert-path /dev/null --key-path /dev/null
) || fail "install.sh failed — can't test the upgrade path without a working install."

wait_for_health "before upgrade"

# --- 2. Write a marker row directly into Postgres, independent of any real application schema ---
log "Writing a marker row into Postgres (independent of the app's own schema, so this test never breaks on an unrelated migration change)..."
compose exec -T postgres psql -U warmhawk -d warmhawk -c \
  "CREATE TABLE IF NOT EXISTS e2e_upgrade_marker (id serial PRIMARY KEY, note text); INSERT INTO e2e_upgrade_marker (note) VALUES ('${MARKER_NOTE}');" \
  || fail "Could not write the marker row before the upgrade — Postgres isn't actually reachable despite /health reporting ok."
log "Marker row written: ${MARKER_NOTE}"

# --- 3. Run the real upgrade command, pinned to the exact commit already checked out here ------
CURRENT_REF="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
[ -n "$CURRENT_REF" ] || fail "git rev-parse HEAD failed — can't pin update.sh to a specific ref without silently drifting onto 'main' (its own default) instead of the commit actually under test."
log "Running scripts/update.sh ${CURRENT_REF} (pinned — never update.sh's own 'main' default, so this test can't silently upgrade away from the commit it's supposed to be testing)..."
UPDATE_LOG="$(mktemp)"
(
  cd "$REPO_ROOT"
  ./scripts/update.sh "$CURRENT_REF"
) > "$UPDATE_LOG" 2>&1 || { cat "$UPDATE_LOG" >&2; fail "update.sh exited non-zero."; }
cat "$UPDATE_LOG"

grep -q "Running pending database migrations" "$UPDATE_LOG" || fail "update.sh's log never showed it ran migrations — see full log above."
grep -q "Update complete" "$UPDATE_LOG" || fail "update.sh did not report completion — see full log above."
log "Confirmed: update.sh ran migrations and reported completion."

# --- 4. Assert the upgrade cycle didn't lose data or leave the app unhealthy --------------------
wait_for_health "after upgrade"

log "Confirming the marker row survived the upgrade..."
FOUND_NOTE="$(compose exec -T postgres psql -U warmhawk -d warmhawk -tAc \
  "SELECT note FROM e2e_upgrade_marker WHERE note = '${MARKER_NOTE}';" || true)"
[ "$(echo "$FOUND_NOTE" | tr -d '[:space:]')" = "$MARKER_NOTE" ] \
  || fail "Marker row '${MARKER_NOTE}' did not survive the upgrade — postgres_data was not preserved across update.sh's rebuild/migrate/restart cycle. Got: '${FOUND_NOTE}'"
log "Confirmed: marker row survived the upgrade intact."

log ""
log "=================================================================================="
log " UPGRADE-IN-PLACE TEST: ALL ASSERTIONS PASSED"
log "   - scripts/update.sh rebuilt, migrated, and rolling-restarted without error"
log "   - the app was healthy again afterward"
log "   - data written to Postgres before the upgrade was still present after it"
log "   - NOT covered here: upgrading between two genuinely different released versions (needs a"
log "     second real release to check out — this test only proves the mechanism is data-safe)"
log "=================================================================================="

exit 0
