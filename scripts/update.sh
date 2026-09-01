#!/usr/bin/env bash
# WarmHawk Core Engine — scripts/update.sh ("warmhawk update")
#
# Zero-touch upgrade: pulls the latest image/tag, runs any pending migrations, does a rolling
# `docker compose up -d` restart. One command, no manual steps, no re-entering secrets or the
# license key (already persisted in .env/.env from install.sh).
#
# Reached as `warmhawk update` via scripts/warmhawk, which install.sh symlinks into PATH. Note the
# indirection is load-bearing: $1 here is a git ref, so a bare symlink of this script to
# /usr/local/bin/warmhawk would make `warmhawk update` try to check out a branch named "update".
# Covered by tests/e2e-install/test-warmhawk-command.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$REPO_ROOT/docker/docker-compose.yml"

log()  { echo "[update] $*"; }
fail() {
  echo "[update] ERROR: $*" >&2
  echo "[update] Next step: resolve the error above, then re-run: ./scripts/update.sh" >&2
  exit 1
}

[ -f "$REPO_ROOT/.env/.env" ] || fail "No .env/.env found — this instance was never installed. Run scripts/install.sh first."

TARGET_REF="${1:-main}"
log "Fetching latest release (${TARGET_REF})..."
git -C "$REPO_ROOT" fetch --tags origin >/dev/null 2>&1 || log "WARNING: git fetch failed (offline or no remote configured) — proceeding with the working tree as-is."
git -C "$REPO_ROOT" checkout "$TARGET_REF" 2>/dev/null || log "WARNING: could not check out ${TARGET_REF} — staying on the current ref."

log "Rebuilding images..."
docker compose --env-file "$REPO_ROOT/.env/.env" -f "$COMPOSE_FILE" build

log "Running pending database migrations..."
docker compose --env-file "$REPO_ROOT/.env/.env" -f "$COMPOSE_FILE" run --rm migrate || fail "Migration failed. The previous version's containers are still running — nothing was torn down. Check 'docker compose logs migrate' before retrying."

log "Rolling restart..."
docker compose --env-file "$REPO_ROOT/.env/.env" -f "$COMPOSE_FILE" up -d --remove-orphans

log "Update complete. Run 'docker compose ps' to confirm every service is healthy."
