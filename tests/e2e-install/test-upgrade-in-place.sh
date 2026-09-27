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
#   3. Makes the imported 'WarmHawk Dispatch' n8n workflow look like an older release's copy (edits
#      its stored nodes, and the recorded hash of dispatch.json in .env/n8n-workflows.sha256) —
#      exactly the state of a customer whose bundled dispatch.json changed in the release they're
#      updating to.
#   4. Runs scripts/update.sh <current-commit-sha> — the real upgrade command, unmodified.
#   5. Asserts: update.sh reported success, the app is healthy again afterward, the marker row
#      from step 2 is still there — proving the rebuild/migrate/restart cycle didn't lose data — and
#      the dispatch workflow now carries this release's nodes, under the same id, once, and active,
#      while the unchanged workflows were left alone.
#   6. Tears its OWN stack down, always, even on failure.
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
  [ "$OWN_ENV" = true ] && rm -f "$REPO_ROOT/.env/.env" "$REPO_ROOT/.env/n8n-workflows.sha256"
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

# --- 3. Make the dispatch workflow look like an older release's copy -----------------------------
# Before 2026-09-27 update.sh skipped any workflow whose name was already imported, so a release
# that changed dispatch.json never reached a single existing install. Simulate that customer: the
# stored workflow lacks this release's aiOutcome wiring, and the hash recorded for dispatch.json is
# not the current file's.
DISPATCH_NAME="WarmHawk Dispatch"
N8N_STATE_FILE="$REPO_ROOT/.env/n8n-workflows.sha256"
n8n_sql() { compose exec -T postgres psql -U warmhawk -d warmhawk -tAc "$1"; }
[ -f "$N8N_STATE_FILE" ] || fail "install.sh did not write $N8N_STATE_FILE — update.sh would have nothing to compare against."
grep -q ' dispatch.json$' "$N8N_STATE_FILE" || fail "install.sh did not record a hash for dispatch.json. State file: $(cat "$N8N_STATE_FILE")"
DISPATCH_ID_BEFORE="$(n8n_sql "SELECT id FROM workflow_entity WHERE name = '${DISPATCH_NAME}';" | tr -d '[:space:]')"
[ -n "$DISPATCH_ID_BEFORE" ] || fail "install.sh never imported '${DISPATCH_NAME}'."
log "Rewinding '${DISPATCH_NAME}' (id ${DISPATCH_ID_BEFORE}) to look like an older release's copy..."
n8n_sql "UPDATE workflow_entity SET nodes = replace(nodes::text, 'aiOutcome', 'e2eOldField')::json WHERE id = '${DISPATCH_ID_BEFORE}';" >/dev/null \
  || fail "Could not rewrite the stored dispatch workflow."
[ "$(n8n_sql "SELECT count(*) FROM workflow_entity WHERE id = '${DISPATCH_ID_BEFORE}' AND nodes::text LIKE '%aiOutcome%';" | tr -d '[:space:]')" = "0" ] \
  || fail "The stored dispatch workflow still mentions aiOutcome after rewinding it — the test setup is wrong."
sed -i 's/^[0-9a-f]* dispatch\.json$/0000000000000000000000000000000000000000000000000000000000000000 dispatch.json/' "$N8N_STATE_FILE"

# --- 4. Run the real upgrade command, pinned to the exact commit already checked out here ------
CURRENT_REF="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
[ -n "$CURRENT_REF" ] || fail "git rev-parse HEAD failed — can't pin update.sh to a specific ref without silently drifting onto 'master' (its own default) instead of the commit actually under test."
log "Running scripts/update.sh ${CURRENT_REF} (pinned — never update.sh's own 'master' default, so this test can't silently upgrade away from the commit it's supposed to be testing)..."
UPDATE_LOG="$(mktemp)"
(
  cd "$REPO_ROOT"
  ./scripts/update.sh "$CURRENT_REF"
) > "$UPDATE_LOG" 2>&1 || { cat "$UPDATE_LOG" >&2; fail "update.sh exited non-zero."; }
cat "$UPDATE_LOG"

grep -q "Running pending database migrations" "$UPDATE_LOG" || fail "update.sh's log never showed it ran migrations — see full log above."
grep -q "Update complete" "$UPDATE_LOG" || fail "update.sh did not report completion — see full log above."
log "Confirmed: update.sh ran migrations and reported completion."

grep -q "Updated n8n workflow '${DISPATCH_NAME}'" "$UPDATE_LOG" \
  || fail "update.sh never re-imported the changed '${DISPATCH_NAME}' workflow — see full log above."
# Every other bundled workflow was imported by install.sh and is unchanged, so update.sh must leave
# it alone. This also catches install.sh failing to import one of them in the first place.
for wf_file in "$REPO_ROOT"/n8n/workflows/*.json; do
  [ "$(basename "$wf_file")" = dispatch.json ] && continue
  wf_name=$(grep -m1 '"name"' "$wf_file" | sed -E 's/.*"name"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
  grep -q "n8n workflow '${wf_name}' is up to date" "$UPDATE_LOG" \
    || fail "update.sh did not find '${wf_name}' imported and unchanged — see full log above."
done

# An unresolvable ref must stop before anything is rebuilt. This used to print a warning and carry
# on, so a customer whose upgrade never happened still saw "Update complete" and kept running the
# old version believing it was patched.
log "Checking that an unresolvable ref fails loudly instead of silently rebuilding the old version..."
BOGUS_LOG="$(mktemp)"
if ( cd "$REPO_ROOT" && ./scripts/update.sh no-such-ref-e2e-check ) > "$BOGUS_LOG" 2>&1; then
  cat "$BOGUS_LOG" >&2
  fail "update.sh exited 0 for a ref that does not exist — a failed upgrade must never report success."
fi
grep -q "Nothing was changed" "$BOGUS_LOG" \
  || { cat "$BOGUS_LOG" >&2; fail "update.sh failed on a bad ref but never said the install was left untouched."; }
if grep -q "Running pending database migrations" "$BOGUS_LOG"; then
  cat "$BOGUS_LOG" >&2
  fail "update.sh reached the migrate step despite an unresolvable ref — it must stop first."
fi
log "Confirmed: a bad ref stops the upgrade before any rebuild, and says so."

# --- 5. Assert the upgrade cycle didn't lose data or leave the app unhealthy --------------------
wait_for_health "after upgrade"

log "Confirming the marker row survived the upgrade..."
FOUND_NOTE="$(compose exec -T postgres psql -U warmhawk -d warmhawk -tAc \
  "SELECT note FROM e2e_upgrade_marker WHERE note = '${MARKER_NOTE}';" || true)"
[ "$(echo "$FOUND_NOTE" | tr -d '[:space:]')" = "$MARKER_NOTE" ] \
  || fail "Marker row '${MARKER_NOTE}' did not survive the upgrade — postgres_data was not preserved across update.sh's rebuild/migrate/restart cycle. Got: '${FOUND_NOTE}'"
log "Confirmed: marker row survived the upgrade intact."

log "Confirming '${DISPATCH_NAME}' now carries this release's version, in place..."
DISPATCH_ROWS="$(n8n_sql "SELECT id || '|' || active::text || '|' || (nodes::text LIKE '%aiOutcome%')::text FROM workflow_entity WHERE name = '${DISPATCH_NAME}';")"
[ "$(printf '%s\n' "$DISPATCH_ROWS" | grep -c .)" = "1" ] \
  || fail "Expected exactly one '${DISPATCH_NAME}' workflow after the update, got: ${DISPATCH_ROWS}"
[ "$(printf '%s' "$DISPATCH_ROWS" | tr -d '[:space:]')" = "${DISPATCH_ID_BEFORE}|true|true" ] \
  || fail "'${DISPATCH_NAME}' should be id ${DISPATCH_ID_BEFORE}, active, with this release's nodes (id|active|current). Got: ${DISPATCH_ROWS}"
grep -q "^$(sha256sum "$REPO_ROOT/n8n/workflows/dispatch.json" | cut -d' ' -f1) dispatch.json$" "$N8N_STATE_FILE" \
  || fail "update.sh did not record the new dispatch.json hash — the next update would re-import it again. State file: $(cat "$N8N_STATE_FILE")"
log "Confirmed: the changed workflow was re-imported under its existing id, active, and recorded."

log ""
log "=================================================================================="
log " UPGRADE-IN-PLACE TEST: ALL ASSERTIONS PASSED"
log "   - scripts/update.sh rebuilt, migrated, and rolling-restarted without error"
log "   - the app was healthy again afterward"
log "   - data written to Postgres before the upgrade was still present after it"
log "   - a bundled n8n workflow that changed was re-imported in place (same id, active); unchanged"
log "     ones were left alone"
log "   - NOT covered here: upgrading between two genuinely different released versions (needs a"
log "     second real release to check out — this test only proves the mechanism is data-safe)"
log "=================================================================================="

exit 0
