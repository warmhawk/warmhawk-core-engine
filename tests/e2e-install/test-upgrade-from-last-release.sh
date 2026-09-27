#!/usr/bin/env bash
# ==================================================================================================
# WarmHawk Core Engine — tests/e2e-install/test-upgrade-from-last-release.sh
# Installs the LAST RELEASED version the way a customer has it, then runs `warmhawk update` to the
# commit under test — the one path every existing customer takes, and the one no other test took.
# --------------------------------------------------------------------------------------------------
# Every other test here installs this commit and, at most, updates it to itself. On 2026-09-27 that
# let three update bugs through to a paying install, each invisible unless the old and new versions
# really differ:
#   - update.sh skipped every n8n workflow already imported, so a release that changed one never
#     reached an existing install (a fresh install imports everything, so it always looked fine);
#   - bash kept running the OLD update.sh after `git checkout` replaced it, so fixes to update.sh's
#     own steps landed one update late (old and new are the same file when you update to yourself);
#   - nothing checked that an install is left clean enough for the NEXT update to run.
#
# What it does:
#   1. Builds a local stand-in for GitHub: a full clone of the public repo (every release tag), plus
#      the commit under test. A local run with uncommitted edits tests those edits too.
#   2. Points its master at the previous release and clones it exactly as the one-line installer
#      does (`git clone --depth 1 --branch master`), then runs THAT release's own install.sh.
#   3. Writes a marker row, moves master to the commit under test, and runs `warmhawk update`.
#   4. Asserts: it moved from the old release to this commit; this commit's update steps ran (the
#      hand-over); every bundled n8n workflow that changed was re-imported, new ones imported and
#      unchanged ones left alone, each exactly once and active; the data survived; the app is
#      healthy; and the checkout has no local changes to block the next update.
#   5. Runs `warmhawk update` again: already current, no hand-over, nothing re-imported.
#   6. Tears its own stack and scratch directory down, always.
#
# The scratch install lives under the repo root, not /tmp: CI runs Docker in a sibling DinD
# container that shares only the workspace, and install.sh's compose file bind-mounts from it.
#
# Overrides: WARMHAWK_E2E_UPSTREAM (repo to take releases from), WARMHAWK_E2E_FROM_TAG (release to
# start from; default: the newest v* tag that isn't the commit under test).
# ==================================================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

UPSTREAM="${WARMHAWK_E2E_UPSTREAM:-https://github.com/warmhawk/warmhawk-core-engine.git}"
TEST_DOMAIN="warmhawk-release-upgrade-test.invalid"   # .invalid never resolves (RFC 2606)
MARKER_NOTE="upgrade-from-release-canary-$$"
export COMPOSE_PROJECT_NAME="warmhawk-e2e-from-release"
HEALTH_CHECK_HOST="${HEALTH_CHECK_HOST:-localhost}"

WORK="$REPO_ROOT/.e2e-from-release"
ORIGIN="$WORK/origin.git"
INSTALL="$WORK/warmhawk-core-engine"
PREV_WORKFLOWS="$WORK/previous-release-workflows"
UPDATE_LOG="$WORK/update.log"
RERUN_LOG="$WORK/update-rerun.log"

log()  { echo "[test-upgrade-from-last-release] $*"; }
fail() {
  echo "[test-upgrade-from-last-release] FAIL: $*" >&2
  exit 1
}

compose() { docker compose --env-file "$INSTALL/.env/.env" -f "$INSTALL/docker/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME" "$@"; }

cleanup() {
  local exit_code=$?
  log "Tearing down (project-scoped — does not touch any other stack on this host)..."
  if [ -f "$INSTALL/docker/docker-compose.yml" ]; then
    docker compose -f "$INSTALL/docker/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  # Containers can leave root-owned files in the bind-mounted install dir.
  rm -rf "$WORK" 2>/dev/null || docker run --rm -v "$REPO_ROOT:/r" alpine:3 rm -rf /r/.e2e-from-release >/dev/null 2>&1 || true
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
command -v git >/dev/null 2>&1 || fail "git is not installed."

log "Pre-cleanup: removing any leftover state from a prior interrupted run of this test..."
if [ -f "$INSTALL/docker/docker-compose.yml" ]; then
  docker compose -f "$INSTALL/docker/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME" down -v --remove-orphans >/dev/null 2>&1 || true
fi
rm -rf "$WORK" 2>/dev/null || docker run --rm -v "$REPO_ROOT:/r" alpine:3 rm -rf /r/.e2e-from-release >/dev/null 2>&1 || true
mkdir -p "$WORK"

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

workflow_name() { grep -m1 '"name"' "$1" | sed -E 's/.*"name"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/'; }
n8n_sql() { compose exec -T postgres psql -U warmhawk -d warmhawk -tAc "$1"; }

# --- 1. A local stand-in for GitHub, with every release and the commit under test ----------------
log "Cloning ${UPSTREAM} (all release tags)..."
git clone -q --bare "$UPSTREAM" "$ORIGIN" || fail "Could not clone ${UPSTREAM}."
# CI checkouts can be shallow; let the push below carry a shallow history into the stand-in.
git -C "$ORIGIN" config receive.shallowUpdate true

# `stash create` snapshots uncommitted edits to tracked files as a commit without touching the
# working tree; on a clean checkout (CI) it prints nothing and HEAD is the candidate.
# safe.directory: CI's checkout is owned by another user than the one running this script.
repo_git() { GIT_COMMITTER_NAME=e2e GIT_COMMITTER_EMAIL=e2e@acme.example git -c safe.directory="$REPO_ROOT" -C "$REPO_ROOT" "$@"; }
CANDIDATE="$(repo_git stash create 2>/dev/null || true)"
[ -n "$CANDIDATE" ] || CANDIDATE="$(repo_git rev-parse HEAD)"
repo_git push -q "$ORIGIN" "${CANDIDATE}:refs/heads/e2e-candidate" \
  || fail "Could not publish the commit under test to the local stand-in."

if [ -n "${WARMHAWK_E2E_FROM_TAG:-}" ]; then
  PREV_TAG="$WARMHAWK_E2E_FROM_TAG"
else
  PREV_TAG=""
  for tag in $(git -C "$ORIGIN" tag -l 'v*' --sort=-v:refname); do
    [ "$(git -C "$ORIGIN" rev-parse "${tag}^{commit}")" = "$(git -C "$ORIGIN" rev-parse "${CANDIDATE}^{commit}")" ] && continue
    PREV_TAG="$tag"
    break
  done
fi
[ -n "$PREV_TAG" ] || fail "No previous release tag found in ${UPSTREAM}."
PREV_SHA="$(git -C "$ORIGIN" rev-parse "${PREV_TAG}^{commit}")" || fail "Release ${PREV_TAG} not found."
log "Upgrading from ${PREV_TAG} (${PREV_SHA:0:7}) to the commit under test (${CANDIDATE:0:7})."

# --- 2. Install the previous release the way the one-line installer does -------------------------
git -C "$ORIGIN" update-ref refs/heads/master "$PREV_SHA"
git clone -q --depth 1 --branch master "file://$ORIGIN" "$INSTALL" || fail "Could not clone ${PREV_TAG}."
cp -r "$INSTALL/n8n/workflows" "$PREV_WORKFLOWS"
PREV_HAS_HANDOVER=false
grep -q WARMHAWK_UPDATE_HANDED_OVER_FROM "$INSTALL/scripts/update.sh" && PREV_HAS_HANDOVER=true

log "Running ${PREV_TAG}'s own scripts/install.sh --domain ${TEST_DOMAIN} --skip-certbot..."
(
  cd "$INSTALL"
  ./scripts/install.sh --domain "$TEST_DOMAIN" --skip-certbot --cert-path /dev/null --key-path /dev/null
) || fail "${PREV_TAG}'s install.sh failed — can't test upgrading from it."
wait_for_health "${PREV_TAG}, before the update"
# Releases before the hash state file existed recorded nothing, so their first update re-imports
# every workflow once — expected, and asserted as such below.
PREV_HAS_STATE=false
[ -s "$INSTALL/.env/n8n-workflows.sha256" ] && PREV_HAS_STATE=true

compose exec -T postgres psql -U warmhawk -d warmhawk -c \
  "CREATE TABLE IF NOT EXISTS e2e_upgrade_marker (id serial PRIMARY KEY, note text); INSERT INTO e2e_upgrade_marker (note) VALUES ('${MARKER_NOTE}');" \
  >/dev/null || fail "Could not write the marker row before the update."
log "Marker row written: ${MARKER_NOTE}"

# --- 3. Release the commit under test, then update exactly as a customer would -------------------
git -C "$ORIGIN" update-ref refs/heads/master "$CANDIDATE"
PREV_SHORT="$(git -C "$INSTALL" rev-parse --short HEAD)"
log "Running 'warmhawk update' (the customer command, default release line)..."
"$INSTALL/scripts/warmhawk" update > "$UPDATE_LOG" 2>&1 || { cat "$UPDATE_LOG" >&2; fail "warmhawk update exited non-zero."; }
cat "$UPDATE_LOG"
NEW_SHORT="$(git -C "$INSTALL" rev-parse --short HEAD)"

# --- 4. Assertions -------------------------------------------------------------------------------
[ "$(git -C "$INSTALL" rev-parse HEAD)" = "$(git -C "$ORIGIN" rev-parse "${CANDIDATE}^{commit}")" ] \
  || fail "The install is at $(git -C "$INSTALL" rev-parse HEAD), not the commit under test."
grep -q "Updating ${PREV_SHORT} -> ${NEW_SHORT} (master)" "$UPDATE_LOG" \
  || fail "update.sh did not report moving ${PREV_SHORT} -> ${NEW_SHORT} — see the log above."
grep -q "Update complete" "$UPDATE_LOG" || fail "update.sh did not report completion."

if [ "$PREV_HAS_HANDOVER" = true ]; then
  grep -q "Continuing with the update steps of the version just checked out" "$UPDATE_LOG" \
    || fail "${PREV_TAG}'s update.sh ran its own steps instead of handing over to this commit's."
  log "Confirmed: this commit's update steps ran, not ${PREV_TAG}'s."
else
  log "NOTE: ${PREV_TAG} predates the update.sh hand-over, so its own steps ran; step checks below"
  log "      still hold only if those steps were already correct."
fi

log "Checking every bundled n8n workflow against ${PREV_TAG}'s copy..."
EXPECTED_ROWS=0
for wf_file in "$INSTALL"/n8n/workflows/*.json; do
  wf_key="$(basename "$wf_file")"
  wf_name="$(workflow_name "$wf_file")"
  EXPECTED_ROWS=$((EXPECTED_ROWS + 1))
  if [ ! -f "$PREV_WORKFLOWS/$wf_key" ]; then
    grep -q "Imported n8n workflow '${wf_name}'" "$UPDATE_LOG" || fail "New workflow '${wf_name}' was not imported."
  elif [ "$PREV_HAS_STATE" = false ] || ! cmp -s "$wf_file" "$PREV_WORKFLOWS/$wf_key"; then
    grep -q "Updated n8n workflow '${wf_name}'" "$UPDATE_LOG" || fail "Changed workflow '${wf_name}' was not re-imported."
  else
    grep -q "n8n workflow '${wf_name}' is up to date" "$UPDATE_LOG" || fail "Unchanged workflow '${wf_name}' was not left alone."
  fi
  rows="$(n8n_sql "SELECT count(*) || '|' || coalesce(bool_and(active), false)::text FROM workflow_entity WHERE name = '${wf_name//\'/\'\'}';" | tr -d '[:space:]')"
  [ "$rows" = "1|true" ] || fail "Expected exactly one active '${wf_name}' workflow, got count|active = ${rows}."
  grep -q "^$(sha256sum "$wf_file" | cut -d' ' -f1) ${wf_key}$" "$INSTALL/.env/n8n-workflows.sha256" \
    || fail "The recorded hash for ${wf_key} is not this release's — the next update would re-import it."
done
TOTAL_ROWS="$(n8n_sql "SELECT count(*) FROM workflow_entity;" | tr -d '[:space:]')"
[ "$TOTAL_ROWS" = "$EXPECTED_ROWS" ] || fail "n8n has ${TOTAL_ROWS} workflows for ${EXPECTED_ROWS} bundled files — duplicates or strays."
log "Confirmed: every workflow is this release's, once, and active."

wait_for_health "after the update"
FOUND_NOTE="$(compose exec -T postgres psql -U warmhawk -d warmhawk -tAc \
  "SELECT note FROM e2e_upgrade_marker WHERE note = '${MARKER_NOTE}';" || true)"
[ "$(echo "$FOUND_NOTE" | tr -d '[:space:]')" = "$MARKER_NOTE" ] || fail "The marker row did not survive the update."
log "Confirmed: data written under ${PREV_TAG} survived."

DIRTY="$(git -C "$INSTALL" status --porcelain --untracked-files=no)"
[ -z "$DIRTY" ] || fail "The update left local changes to tracked files, which block the next update: ${DIRTY}"

# --- 5. The next update finds nothing to do ------------------------------------------------------
log "Running 'warmhawk update' again..."
"$INSTALL/scripts/warmhawk" update > "$RERUN_LOG" 2>&1 || { cat "$RERUN_LOG" >&2; fail "The second warmhawk update exited non-zero."; }
grep -q "Already at the latest master (${NEW_SHORT})" "$RERUN_LOG" || { cat "$RERUN_LOG" >&2; fail "The second update did not find the install current."; }
if grep -q "Continuing with the update steps" "$RERUN_LOG"; then
  cat "$RERUN_LOG" >&2; fail "The second update handed over although nothing was checked out."
fi
if grep -qE "Updated n8n workflow|Imported n8n workflow" "$RERUN_LOG"; then
  cat "$RERUN_LOG" >&2; fail "The second update re-imported workflows that had not changed."
fi
wait_for_health "after the second update"

log ""
log "=================================================================================="
log " UPGRADE-FROM-LAST-RELEASE TEST: ALL ASSERTIONS PASSED (${PREV_TAG} -> ${NEW_SHORT})"
log "=================================================================================="
exit 0
