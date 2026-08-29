#!/usr/bin/env bash
# ==================================================================================================
# WarmHawk Core Engine — tests/e2e-install/test-idempotent-rerun.sh
# Local regression test for scripts/install.sh's idempotency claim ("safe to re-run after any
# failure, a typo'd domain, or an interrupted connection" — see that script's own header comment).
# --------------------------------------------------------------------------------------------------
# Like test-port-fallback.sh, this needs neither a real scratch VM nor real public DNS — it runs
# anywhere Docker runs. What it verifies is different: that running install.sh a SECOND time
# against an already-installed stack reuses the secrets already written to .env instead of silently
# regenerating them (which would desync every running container's DATABASE_URL/REDIS_URL/JWT_SECRET
# from what .env now claims), and that the stack is still healthy afterward.
#
# What this script does, in order:
#   1. Runs scripts/install.sh --domain <non-resolving test domain> --skip-certbot once, isolated
#      into its own Compose project (COMPOSE_PROJECT_NAME) so it never touches any other stack
#      already running on this machine.
#   2. Confirms the app is genuinely healthy and snapshots .env's checksum.
#   3. Runs the exact same install.sh command again, without tearing anything down first.
#   4. Asserts: the second run's own log said it detected and reused existing secrets, .env is
#      byte-for-byte unchanged (proves secrets weren't regenerated out from under the running
#      containers), and the app is still healthy.
#   5. Tears its OWN stack down, always, even on failure.
# ==================================================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

TEST_DOMAIN="warmhawk-idempotent-test.invalid"   # .invalid never resolves (RFC 2606) — no real DNS/network needed
export COMPOSE_PROJECT_NAME="warmhawk-e2e-idempotent"
# See test-port-fallback.sh's identical override for why this exists.
HEALTH_CHECK_HOST="${HEALTH_CHECK_HOST:-localhost}"

log()  { echo "[test-idempotent-rerun] $*"; }
fail() {
  echo "[test-idempotent-rerun] FAIL: $*" >&2
  exit 1
}

# See test-port-fallback.sh's identical guard for why this exists: only ever set true once the
# pre-existence guard below has actually passed — otherwise a pre-existing .env that doesn't
# belong to this run gets deleted by this trap on the exact failure path meant to protect it.
OWN_ENV=false

cleanup() {
  local exit_code=$?
  log "Tearing down (project-scoped — does not touch any other stack on this host)..."
  docker compose -f "$REPO_ROOT/docker/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME" down -v --remove-orphans >/dev/null 2>&1 || true
  [ "$OWN_ENV" = true ] && rm -f "$REPO_ROOT/.env"
  rm -f "${RUN2_LOG:-}" "${ENV_SNAPSHOT:-}"
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
log "Pre-cleanup: removing any leftover state from a prior interrupted run of this test..."
docker compose -f "$REPO_ROOT/docker/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME" down -v --remove-orphans >/dev/null 2>&1 || true

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

# --- 1. First install ------------------------------------------------------------------------------
log "Running scripts/install.sh --domain ${TEST_DOMAIN} --skip-certbot (run 1 of 2)..."
(
  cd "$REPO_ROOT"
  ./scripts/install.sh --domain "$TEST_DOMAIN" --skip-certbot --cert-path /dev/null --key-path /dev/null
) || fail "first install.sh run failed — can't test re-run idempotency without a working first install."

wait_for_health "after run 1"

ENV_SNAPSHOT="$(mktemp)"
cp "$REPO_ROOT/.env" "$ENV_SNAPSHOT"
log "Snapshotted .env after run 1 ($(sha256sum "$ENV_SNAPSHOT" | cut -d' ' -f1))."

# --- 2. Second install — same args, nothing torn down in between ----------------------------------
log "Running scripts/install.sh --domain ${TEST_DOMAIN} --skip-certbot (run 2 of 2, no teardown in between)..."
RUN2_LOG="$(mktemp)"
(
  cd "$REPO_ROOT"
  ./scripts/install.sh --domain "$TEST_DOMAIN" --skip-certbot --cert-path /dev/null --key-path /dev/null
) > "$RUN2_LOG" 2>&1 || { cat "$RUN2_LOG" >&2; fail "second install.sh run exited non-zero — it should be safe to re-run, not fail."; }
cat "$RUN2_LOG"

# --- 3. Assert idempotency, not just "didn't crash" ------------------------------------------------
grep -q "re-run detected, reusing existing secrets" "$RUN2_LOG" \
  || fail "second run's own log never said it detected an existing .env and reused secrets — see full log above."
log "Confirmed: second run recognized the existing install and reused its secrets."

if ! cmp -s "$ENV_SNAPSHOT" "$REPO_ROOT/.env"; then
  fail ".env changed between run 1 and run 2 — secrets were regenerated, which desyncs already-running containers' env from what .env now claims. Diff:
$(diff "$ENV_SNAPSHOT" "$REPO_ROOT/.env" || true)"
fi
log "Confirmed: .env is byte-for-byte identical after the second run — secrets were reused, not regenerated."

wait_for_health "after run 2"

log ""
log "=================================================================================="
log " IDEMPOTENT-RERUN TEST: ALL ASSERTIONS PASSED"
log "   - install.sh detected the existing .env on the second run and reused its secrets"
log "   - .env was not rewritten with new secret values"
log "   - the app was genuinely healthy both before and after the second run"
log "=================================================================================="

exit 0
