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

# `master` is the released branch. It is deliberately not `main`: that is the development trunk, so
# defaulting to it upgraded every install to unreleased code. Pass a tag (`./scripts/update.sh
# v1.0.3`) to pin to an exact version instead.
TARGET_REF="${1:-master}"
# Logged before anything else touches git, so the ref this run targets is always visible — including
# on a host with no git and in the "no remote" path below.
log "Target version: ${TARGET_REF}"
BEFORE="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"

# An install created by copying a local directory has no remote. That is a supported way to run this
# engine, so it updates from the working tree as-is rather than failing.
if ! git -C "$REPO_ROOT" remote get-url origin >/dev/null 2>&1; then
  log "No git remote configured — updating from the working tree as-is."
else
  log "Fetching ${TARGET_REF}..."
  # Fatal, not a warning. This script exists to move the install forward; carrying on after a failed
  # fetch rebuilds the identical code and then reports success, which reads as "already up to date".
  git -C "$REPO_ROOT" fetch --tags origin >/dev/null 2>&1 \
    || fail "git fetch failed — the server is offline or cannot reach the repository. Nothing was changed."

  # Installs are shallow, single-branch clones, so a branch that was not the one cloned has no
  # remote-tracking ref yet. Fetch it by name before giving up on it.
  if ! git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/remotes/origin/${TARGET_REF}" >/dev/null; then
    git -C "$REPO_ROOT" fetch origin "${TARGET_REF}:refs/remotes/origin/${TARGET_REF}" >/dev/null 2>&1 || true
  fi

  if git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/remotes/origin/${TARGET_REF}" >/dev/null; then
    # `checkout <branch>` alone is a no-op when already on it: the fetched commits sit in
    # origin/<branch> and the build below would rebuild the version already installed. Point the
    # branch at what was just fetched. This refuses to run rather than discard local edits.
    git -C "$REPO_ROOT" checkout -B "$TARGET_REF" "origin/${TARGET_REF}" 2>/dev/null \
      || fail "Could not move to ${TARGET_REF} — you have local changes to tracked files. Commit or stash them, then re-run. Nothing was changed."
  else
    # Not a branch — a tag or a commit, which needs no fast-forward.
    git -C "$REPO_ROOT" checkout "$TARGET_REF" 2>/dev/null \
      || fail "Could not check out '${TARGET_REF}' — no such branch, tag or commit. Nothing was changed."
  fi
fi

AFTER="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [ "$AFTER" = unknown ]; then
  : # Not a git checkout — there is no version to compare, and claiming one would be a guess.
elif [ "$BEFORE" = "$AFTER" ]; then
  log "Already at the latest ${TARGET_REF} (${AFTER}) — rebuilding and re-running migrations anyway."
else
  log "Updating ${BEFORE} -> ${AFTER} (${TARGET_REF})."
fi

log "Rebuilding images..."
docker compose --env-file "$REPO_ROOT/.env/.env" -f "$COMPOSE_FILE" build

log "Running pending database migrations..."
docker compose --env-file "$REPO_ROOT/.env/.env" -f "$COMPOSE_FILE" run --rm migrate || fail "Migration failed. The previous version's containers are still running — nothing was torn down. Check 'docker compose logs migrate' before retrying."

log "Rolling restart..."
docker compose --env-file "$REPO_ROOT/.env/.env" -f "$COMPOSE_FILE" up -d --remove-orphans

if [ "$AFTER" = unknown ]; then
  log "Update complete. Run 'docker compose ps' to confirm every service is healthy."
else
  log "Update complete — now running ${TARGET_REF} (${AFTER}). Run 'docker compose ps' to confirm every service is healthy."
fi
