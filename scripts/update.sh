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
NGINX_TEMPLATE="$REPO_ROOT/nginx/nginx.conf.template"

log()  { echo "[update] $*"; }
fail() {
  echo "[update] ERROR: $*" >&2
  echo "[update] Next step: resolve the error above, then re-run: ./scripts/update.sh" >&2
  exit 1
}

# Copy of install.sh's enable_tls_template() (see this repo's "no shared shell lib" convention).
# install.sh turns TLS on by editing the TRACKED nginx.conf.template in place, so on every HTTPS
# install that file is a local change. Left alone, the checkout below refuses to run the first time
# the template changes upstream -- the customer is stuck on "you have local changes" for an edit
# they never made. So the flip is undone before moving and redone on whatever version lands.
enable_tls_template() {
  grep -q "Enabled by scripts/install.sh" "$NGINX_TEMPLATE" 2>/dev/null || return 0
  awk '
    index($0, "Enabled by scripts/install.sh") > 0 { found=1; next }
    found { line=$0; sub(/^# ?/, "", line); print line; next }
  ' "$NGINX_TEMPLATE" > "$NGINX_TEMPLATE.new"
  mv "$NGINX_TEMPLATE.new" "$NGINX_TEMPLATE"
  log "Re-enabled the TLS server block in nginx.conf.template."
}

# The install dir can be owned by a different user than the one running this (copied in, or cloned
# before `sudo warmhawk update`). Git then refuses it as "dubious ownership". This script only ever
# touches its own install, so trust exactly that one directory.
git() { command git -c safe.directory="$REPO_ROOT" "$@"; }

[ -f "$REPO_ROOT/.env/.env" ] || fail "No .env/.env found — this instance was never installed. Run scripts/install.sh first."

# `master` is the released branch. It is deliberately not `main`: that is the development trunk, so
# defaulting to it upgraded every install to unreleased code. Pass a tag (`./scripts/update.sh
# v1.0.3`) to pin to an exact version instead.
TARGET_REF="${1:-master}"
# Logged before anything else touches git, so the ref this run targets is always visible — including
# on a host with no git and in the "no remote" path below.
log "Target version: ${TARGET_REF}"
BEFORE="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"

# The marker line is gone once install.sh has enabled TLS.
TLS_ENABLED=false
grep -q "Enabled by scripts/install.sh" "$NGINX_TEMPLATE" 2>/dev/null || TLS_ENABLED=true

# An install created by copying a local directory has no remote. WARMHAWK_CORE_REPO_URL (the same
# variable the one-line installer clones from) links it to the repository in place, so it can take
# updates from then on. `checkout -f` below then overwrites the copied files with the fetched ones;
# .env/.env is untracked and ignored, so the install's secrets are never touched.
FORCE_CHECKOUT=()
if ! git -C "$REPO_ROOT" remote get-url origin >/dev/null 2>&1 && [ -n "${WARMHAWK_CORE_REPO_URL:-}" ]; then
  log "No git remote configured — linking this install to ${WARMHAWK_CORE_REPO_URL}."
  [ -d "$REPO_ROOT/.git" ] || git -C "$REPO_ROOT" init -q \
    || fail "git init failed in ${REPO_ROOT}. Nothing was changed."
  git -C "$REPO_ROOT" remote add origin "$WARMHAWK_CORE_REPO_URL" \
    || fail "Could not add ${WARMHAWK_CORE_REPO_URL} as the git remote. Nothing was changed."
  FORCE_CHECKOUT=(-f)
fi

# Otherwise an install with no remote is still a supported way to run this engine, so it updates
# from the working tree as-is rather than failing.
if ! git -C "$REPO_ROOT" remote get-url origin >/dev/null 2>&1; then
  log "No git remote configured — updating from the working tree as-is."
  log "  To take released updates from now on, run once: WARMHAWK_CORE_REPO_URL=https://github.com/warmhawk/warmhawk-core-engine.git warmhawk update"
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

  # Undo install.sh's TLS edit so it is not mistaken for a customer change (see enable_tls_template).
  # A freshly linked install has no HEAD to restore from; its checkout is forced anyway.
  if [ "$TLS_ENABLED" = true ] && [ "${#FORCE_CHECKOUT[@]}" -eq 0 ]; then
    git -C "$REPO_ROOT" checkout -- nginx/nginx.conf.template 2>/dev/null || true
  fi

  CHECKOUT_OK=true
  if git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/remotes/origin/${TARGET_REF}" >/dev/null; then
    # `checkout <branch>` alone is a no-op when already on it: the fetched commits sit in
    # origin/<branch> and the build below would rebuild the version already installed. Point the
    # branch at what was just fetched. This refuses to run rather than discard local edits.
    git -C "$REPO_ROOT" checkout "${FORCE_CHECKOUT[@]+"${FORCE_CHECKOUT[@]}"}" -B "$TARGET_REF" "origin/${TARGET_REF}" 2>/dev/null \
      || CHECKOUT_OK=branch
  else
    # Not a branch — a tag or a commit, which needs no fast-forward.
    git -C "$REPO_ROOT" checkout "${FORCE_CHECKOUT[@]+"${FORCE_CHECKOUT[@]}"}" "$TARGET_REF" 2>/dev/null \
      || CHECKOUT_OK=ref
  fi

  # Runs whether or not the checkout worked, so a failed update leaves TLS exactly as it found it.
  [ "$TLS_ENABLED" = true ] && enable_tls_template

  [ "$CHECKOUT_OK" = branch ] \
    && fail "Could not move to ${TARGET_REF} — you have local changes to tracked files. Commit or stash them, then re-run. Nothing was changed."
  [ "$CHECKOUT_OK" = ref ] \
    && fail "Could not check out '${TARGET_REF}' — no such branch, tag or commit. Nothing was changed."
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

# --- n8n workflow provisioning (all bundled workflows, incl. the real send path) ---------------
# Mirrors install.sh's own block (kept as a separate copy — see this repo's "no shared shell lib"
# convention) — needed HERE, not just in install.sh, because an instance installed before this fix
# shipped will never pick it up otherwise: nothing else ever re-runs install.sh on an existing
# instance. Without this, `dispatch.json` (the workflow the worker's `processDispatchJob` actually
# POSTs every real campaign send to) stays uninmported/inactive forever on any pre-existing
# install, meaning outbound sending — and blocklist/lookalike/reply/seed-placement monitoring —
# silently never started, with no update path that would ever fix it. Guarded by name (via
# `n8n list:workflow`) so re-running this script never creates duplicate workflow entities;
# degrades, never aborts the update.
#
# A workflow that is already there is re-imported when its bundled file changed since the last
# run, not skipped: skipping by name alone meant no release could ever ship a workflow fix to an
# existing install (found 2026-09-27 — v1.4.0's dispatch.json never reached a single updated
# instance). The hash of each file as last imported lives in .env/n8n-workflows.sha256 (untracked,
# like .env/.env). The re-import carries the existing workflow's id, which `n8n import:workflow`
# upserts in place, so the webhook path and execution history stay put. An install from before
# the state file existed has no recorded hashes, so its first update re-imports every workflow once.
#
# Bug fix (confirmed live on sas-stage, 2026-09-08): `n8n import:workflow --input=<single-file>`
# throws `workflows.map is not a function` on this n8n version — reproduced even against
# blocklist-poll.json itself, so it's not content-specific, just how this CLI parses a bare object
# vs. an array. `--separate --input=<directory>` (n8n's own documented mode for "one workflow per
# file in a directory") does not hit this. It has no per-name skip-existing behavior of its own, so
# each not-yet-imported file is copied into its own single-file staging directory and imported one
# at a time — keeping the exact same per-file guard/logging as before, just changing the CLI shape.
N8N_STATE_FILE="$REPO_ROOT/.env/n8n-workflows.sha256"
file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
log "Provisioning n8n workflows (dispatch, reply-poll, seed-placement-poll, blocklist-poll, lookalike-scan, warmup-tick)..."
# n8n runs its own DB setup when its container (re)starts; an import or list issued before that
# finishes fails with nothing but "User settings loaded" (seen 2026-09-27 on a fresh install, where
# the first workflow in the loop never imported). Wait for its own health endpoint first.
N8N_READY=false
for _ in $(seq 1 60); do
  if docker compose --env-file "$REPO_ROOT/.env/.env" -f "$COMPOSE_FILE" exec -T n8n wget -qO- http://127.0.0.1:5678/healthz >/dev/null 2>&1; then N8N_READY=true; break; fi
  sleep 2
done
[ "$N8N_READY" = true ] || log "WARNING: n8n did not report healthy within 2 minutes — trying the import anyway."
N8N_IMPORT_FAILED=false
N8N_LIST_OK=true
EXISTING_N8N_WORKFLOWS=$(docker compose --env-file "$REPO_ROOT/.env/.env" -f "$COMPOSE_FILE" exec -T n8n n8n list:workflow 2>/dev/null) || N8N_LIST_OK=false
if [ "$N8N_LIST_OK" = false ]; then
  # Without the list, every existing workflow looks absent and would be imported a second time.
  log "WARNING: could not list the existing n8n workflows — skipping the import so nothing is duplicated."
  N8N_IMPORT_FAILED=true
fi
N8N_WORKFLOW_NAMES=()
N8N_NEW_STATE=""
for wf_file in "$REPO_ROOT"/n8n/workflows/*.json; do
  wf_name=$(grep -m1 '"name"' "$wf_file" | sed -E 's/.*"name"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
  if [ -z "$wf_name" ]; then
    log "WARNING: could not read workflow name from $wf_file — skipping."
    N8N_IMPORT_FAILED=true
    continue
  fi
  N8N_WORKFLOW_NAMES+=("$wf_name")
  wf_key=$(basename "$wf_file")
  wf_hash=$(file_sha256 "$wf_file")
  recorded_hash=$(awk -v f="$wf_key" '$2 == f { print $1; exit }' "$N8N_STATE_FILE" 2>/dev/null || true)
  if [ "$N8N_LIST_OK" = false ]; then
    if [ -n "$recorded_hash" ]; then N8N_NEW_STATE+="$recorded_hash $wf_key"$'\n'; fi
    continue
  fi
  existing_id=$(printf '%s\n' "$EXISTING_N8N_WORKFLOWS" | awk -F'|' -v n="$wf_name" '$2 == n { print $1; exit }')
  if [ -n "$existing_id" ] && [ "$recorded_hash" = "$wf_hash" ]; then
    log "n8n workflow '$wf_name' is up to date."
    N8N_NEW_STATE+="$wf_hash $wf_key"$'\n'
    continue
  fi
  # `compose cp` lands the file root-owned while n8n runs as `node`, so it's staged outside the
  # import directory and node writes the file that actually gets imported — carrying the existing
  # workflow's id when there is one, which makes the import update that workflow in place.
  if docker compose --env-file "$REPO_ROOT/.env/.env" -f "$COMPOSE_FILE" exec -T n8n mkdir -p /tmp/n8n-import-one \
    && docker compose --env-file "$REPO_ROOT/.env/.env" -f "$COMPOSE_FILE" exec -T n8n rm -f /tmp/n8n-import-one/workflow.json \
    && docker compose --env-file "$REPO_ROOT/.env/.env" -f "$COMPOSE_FILE" cp "$wf_file" n8n:/tmp/n8n-import-src.json \
    && docker compose --env-file "$REPO_ROOT/.env/.env" -f "$COMPOSE_FILE" exec -T n8n node -e \
      'const fs=require("fs"),w=JSON.parse(fs.readFileSync("/tmp/n8n-import-src.json","utf8"));if(process.argv[1])w.id=process.argv[1];fs.writeFileSync("/tmp/n8n-import-one/workflow.json",JSON.stringify(w));' \
      "$existing_id" \
    && docker compose --env-file "$REPO_ROOT/.env/.env" -f "$COMPOSE_FILE" exec -T n8n n8n import:workflow --separate --input=/tmp/n8n-import-one/; then
    if [ -n "$existing_id" ]; then
      log "Updated n8n workflow '$wf_name' to this release's version."
    else
      log "Imported n8n workflow '$wf_name'."
    fi
    N8N_NEW_STATE+="$wf_hash $wf_key"$'\n'
  else
    log "WARNING: failed to import n8n workflow '$wf_name' — import it manually via the n8n editor."
    N8N_IMPORT_FAILED=true
    # Keep the old hash (if any), so the next update tries this file again.
    if [ -n "$recorded_hash" ]; then N8N_NEW_STATE+="$recorded_hash $wf_key"$'\n'; fi
  fi
done
printf '%s' "$N8N_NEW_STATE" > "$N8N_STATE_FILE" \
  || log "WARNING: could not write $N8N_STATE_FILE — the next update will re-import every n8n workflow."
if [ "${#N8N_WORKFLOW_NAMES[@]}" -eq 0 ]; then
  log "WARNING: no n8n workflow names resolved — skipping activation."
  N8N_IMPORT_FAILED=true
else
  SQL_NAME_LIST=""
  for n in "${N8N_WORKFLOW_NAMES[@]}"; do
    escaped_name=$(printf '%s' "$n" | sed "s/'/''/g")
    SQL_NAME_LIST="${SQL_NAME_LIST}${SQL_NAME_LIST:+, }'${escaped_name}'"
  done
  if docker compose --env-file "$REPO_ROOT/.env/.env" -f "$COMPOSE_FILE" exec -T postgres \
      psql -U warmhawk -d warmhawk -c "UPDATE workflow_entity SET active = true WHERE name IN (${SQL_NAME_LIST}) AND active = false;"; then
    docker compose --env-file "$REPO_ROOT/.env/.env" -f "$COMPOSE_FILE" restart n8n \
      || log "WARNING: n8n workflows activated in the database but the n8n container failed to restart — restart it manually to register the schedule/webhook triggers."
  else
    log "WARNING: failed to activate n8n workflows — activate them manually in the n8n editor (Active toggle) after import."
    N8N_IMPORT_FAILED=true
  fi
fi
if [ "$N8N_IMPORT_FAILED" = true ]; then
  log "n8n workflow provisioning had at least one warning above — outbound sending and/or blocklist/lookalike/reply/seed monitoring may not be running yet. Safe to retry any time by re-running this script."
else
  log "n8n workflow provisioning complete."
fi

if [ "$AFTER" = unknown ]; then
  log "Update complete. Run 'docker compose ps' to confirm every service is healthy."
else
  log "Update complete — now running ${TARGET_REF} (${AFTER}). Run 'docker compose ps' to confirm every service is healthy."
fi
