#!/usr/bin/env bash
# WarmHawk — scripts/restore-postgres.sh
#
# Restores a `.sql.gz` dump produced by scripts/backup-postgres.sh. Mirrors that script's own
# conventions (env loading, container-name discovery, docker-exec-based, no local pg_dump/psql
# version-matching required). Automates exactly the manual steps documented in
# docs/backup-and-restore.md's "Restoring from a backup" section — stop app services, drop +
# recreate the database (the troubleshooting note's own fix for FK-conflict restores, applied by
# default here rather than left as a manual follow-up step), restore, restart app services.
#
# Usage:
#   ./scripts/restore-postgres.sh --latest                       # restore the newest local backup
#   ./scripts/restore-postgres.sh /path/to/warmhawk-postgres-*.sql.gz
#   ./scripts/restore-postgres.sh --latest --yes                  # skip the interactive confirmation
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

if [ -f "$REPO_ROOT/.env/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env/.env"
  set +a
fi

BACKUP_LOCAL_PATH="${BACKUP_LOCAL_PATH:-/var/backups/warmhawk}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-$(basename "$REPO_ROOT")-postgres-1}"
POSTGRES_USER="${POSTGRES_USER:-warmhawk}"
POSTGRES_DB="${POSTGRES_DB:-warmhawk}"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_ROOT/docker/docker-compose.yml}"

log()  { echo "[restore-postgres] $*"; }
fail() { echo "[restore-postgres] ERROR: $*" >&2; exit 1; }

BACKUP_FILE=""
ASSUME_YES=false
USE_LATEST=false

while [ $# -gt 0 ]; do
  case "$1" in
    --latest) USE_LATEST=true; shift ;;
    --yes|-y) ASSUME_YES=true; shift ;;
    -*) fail "Unknown flag: $1" ;;
    *) BACKUP_FILE="$1"; shift ;;
  esac
done

if [ "$USE_LATEST" = true ]; then
  BACKUP_FILE="$(find "$BACKUP_LOCAL_PATH" -maxdepth 1 -name 'warmhawk-postgres-*.sql.gz' -type f -print0 \
    | xargs -0 ls -t 2>/dev/null | head -n1 || true)"
  [ -z "$BACKUP_FILE" ] && fail "No backups found in ${BACKUP_LOCAL_PATH} (looked for warmhawk-postgres-*.sql.gz)."
  log "Using latest backup: ${BACKUP_FILE}"
fi

[ -z "$BACKUP_FILE" ] && fail "Usage: ./scripts/restore-postgres.sh (--latest | /path/to/backup.sql.gz) [--yes]"
[ -f "$BACKUP_FILE" ] || fail "Backup file not found: ${BACKUP_FILE}"

docker inspect "$POSTGRES_CONTAINER" >/dev/null 2>&1 \
  || fail "Postgres container '${POSTGRES_CONTAINER}' is not running. Bring the stack up first (docker compose up -d postgres)."

if [ "$ASSUME_YES" != true ]; then
  echo "[restore-postgres] WARNING: this will STOP api/worker/n8n, DROP the '${POSTGRES_DB}' database," >&2
  echo "  and restore it from: ${BACKUP_FILE}" >&2
  echo "  Everything currently in '${POSTGRES_DB}' that isn't in that backup will be LOST." >&2
  read -r -p "[restore-postgres] Type 'restore' to continue: " CONFIRM
  [ "$CONFIRM" = "restore" ] || fail "Confirmation not given — aborted, nothing was changed."
fi

log "Stopping api/worker/n8n (postgres stays up)..."
docker compose --env-file "$REPO_ROOT/.env/.env" -f "$COMPOSE_FILE" stop api worker n8n 2>/dev/null || true

log "Terminating existing connections to '${POSTGRES_DB}' and dropping/recreating it..."
docker exec "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${POSTGRES_DB}' AND pid <> pg_backend_pid();" \
  >/dev/null
docker exec "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c \
  "DROP DATABASE IF EXISTS \"${POSTGRES_DB}\";" >/dev/null
docker exec "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c \
  "CREATE DATABASE \"${POSTGRES_DB}\" OWNER \"${POSTGRES_USER}\";" >/dev/null

log "Restoring ${BACKUP_FILE} into '${POSTGRES_DB}'..."
if ! gunzip -c "$BACKUP_FILE" | docker exec -i "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 >/dev/null; then
  fail "Restore failed partway through. The database is now in an INDETERMINATE state — do not assume it's usable. Re-run this script against a known-good backup, or restore manually per docs/backup-and-restore.md."
fi

log "Restore completed — data is in. Starting api/worker/n8n back up..."
if ! docker compose --env-file "$REPO_ROOT/.env/.env" -f "$COMPOSE_FILE" start api worker n8n 2>/dev/null && \
   ! docker compose --env-file "$REPO_ROOT/.env/.env" -f "$COMPOSE_FILE" up -d api worker n8n 2>/dev/null; then
  echo "[restore-postgres] WARNING: the database restore itself SUCCEEDED, but bringing api/worker/n8n" >&2
  echo "  back up failed. Re-run: docker compose --env-file ${REPO_ROOT}/.env/.env -f ${COMPOSE_FILE} up -d api worker n8n" >&2
  exit 0
fi

log "Done. Verify: confirm leads/campaigns/domains data matches what you expect as of this backup's timestamp."
