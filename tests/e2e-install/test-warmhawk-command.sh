#!/usr/bin/env bash
# ==================================================================================================
# WarmHawk Core Engine — tests/e2e-install/test-warmhawk-command.sh
# Regression test for the `warmhawk` command on PATH (2026-08-30 go-live audit, finding C3).
# --------------------------------------------------------------------------------------------------
# scripts/update.sh's header claimed since day one that it was "symlinked into PATH as warmhawk
# during install". Nothing in install.sh's 384 lines ever created that symlink, so every doc and
# log line telling a customer to run `warmhawk update` named a command that did not exist on their
# box.
#
# This is the FAST tier: it runs entirely inside a throwaway `bash:5` container, so it needs no
# scratch VM, no DNS, no Postgres/Redis, and — importantly — never writes to the host's
# /usr/local/bin the way running install.sh for real would.
#
# What it asserts:
#   1. install.sh actually contains symlink creation, and treats failure as non-fatal (an
#      unprivileged install must still succeed).
#   2. Invoked THROUGH a symlink, `warmhawk` resolves back to the real checkout — not to
#      /usr/local — so its compose/env paths point at the install directory.
#   3. `warmhawk update <ref>` forwards <ref> to update.sh. This is the bug a bare symlink would
#      have shipped: update.sh reads $1 as a git ref, so `warmhawk update` would have tried to
#      check out a branch named "update".
#   4. An unknown subcommand fails loudly rather than silently doing nothing.
# ==================================================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

log() { echo "[test-warmhawk-command] $*"; }
fail() {
  echo "[test-warmhawk-command] FAIL: $*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "Docker is not installed."

# --- 1. install.sh wires the symlink up, non-fatally ---------------------------------------------
log "Checking install.sh creates the symlink..."
grep -q 'ln -sf "$SCRIPT_DIR/warmhawk" "$WARMHAWK_BIN"' "$REPO_ROOT/scripts/install.sh" \
  || fail "install.sh no longer symlinks scripts/warmhawk into PATH — finding C3 has regressed."
grep -q 'could not write ${WARMHAWK_BIN}' "$REPO_ROOT/scripts/install.sh" \
  || fail "install.sh lost its non-fatal fallback for an unwritable /usr/local/bin."
[ -f "$REPO_ROOT/scripts/warmhawk" ] || fail "scripts/warmhawk is missing."

# --- 2-4. Behaviour of the command itself, through a real symlink ---------------------------------
log "Running dispatcher assertions in a container..."
docker run --rm \
  -v "$REPO_ROOT:/src:ro" \
  bash:5 bash -euo pipefail -c '
    # Build a throwaway "installed instance" in a writable dir. Deliberately NOT the read-only
    # /src mount: update.sh refuses to run without a .env/.env ("this instance was never installed"),
    # and depending on the developer’s own untracked .env/.env would make this test pass or fail based
    # on the host it ran on.
    mkdir -p /work/scripts /work/.env
    cp /src/scripts/warmhawk /src/scripts/update.sh /work/scripts/
    chmod +x /work/scripts/warmhawk /work/scripts/update.sh
    : > /work/.env/.env

    ln -sf /work/scripts/warmhawk /usr/local/bin/warmhawk

    # 2. Resolves through the symlink to the install dir, not /usr/local.
    resolved="$(warmhawk help | grep "^Installed at:" | awk "{print \$3}")"
    [ "$resolved" = "/work" ] || { echo "FAIL: resolved install dir was $resolved, expected /work"; exit 1; }

    # 3. The subcommand is consumed; the ref is forwarded. update.sh echoes the ref it targets, and
    #    a git-less container makes it warn-and-continue rather than mutate anything.
    out="$(warmhawk update v9.9.9-nonexistent 2>&1 || true)"
    if ! echo "$out" | grep -q "Fetching latest release (v9.9.9-nonexistent)"; then
      echo "FAIL: ref not forwarded to update.sh. Got:"; echo "$out"; exit 1
    fi
    if echo "$out" | grep -q "Fetching latest release (update)"; then
      echo "FAIL: the word update leaked through as the git ref"; exit 1
    fi

    # 4. Unknown subcommands are a hard error.
    if warmhawk definitely-not-a-command >/dev/null 2>&1; then
      echo "FAIL: unknown subcommand exited 0"; exit 1
    fi
  ' || fail "dispatcher assertions failed (see output above)."

log "PASSED."
