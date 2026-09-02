#!/usr/bin/env bash
# WarmHawk — scripts/backup-postgres.sh
#
# Nightly Postgres backup, bundled + install-time optional but strongly defaulted-on (see
# Backups & Disaster Recovery). Runs `pg_dump | gzip` to a configurable LOCAL path (default) or an
# optional customer-supplied `rclone` remote (their own S3/B2 bucket, etc.) — WarmHawk never
# receives or stores a customer's backup; this stays entirely on the customer's own
# infrastructure, consistent with the self-hosted/no-data-leaves-the-box positioning.
#
# Invoked by a cron entry `install.sh` writes during setup (opt-in, default yes). Safe to run
# manually at any time: `./scripts/backup-postgres.sh`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# Load .env/.env if present (for POSTGRES_PASSWORD, BACKUP_* vars) without requiring the caller to
# export them manually.
if [ -f "$REPO_ROOT/.env/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env/.env"
  set +a
fi

BACKUP_LOCAL_PATH="${BACKUP_LOCAL_PATH:-/var/backups/warmhawk}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-$(basename "$REPO_ROOT")-postgres-1}"
POSTGRES_USER="${POSTGRES_USER:-warmhawk}"
POSTGRES_DB="${POSTGRES_DB:-warmhawk}"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILENAME="warmhawk-postgres-${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_LOCAL_PATH"

echo "[backup-postgres] dumping ${POSTGRES_DB} from container ${POSTGRES_CONTAINER}..."

# Runs pg_dump INSIDE the postgres container (via `docker exec`) so this script has no dependency
# on a local `pg_dump` binary matching the server's major version — works identically whether
# invoked from the host cron or from inside another container with the Docker socket mounted.
if ! docker exec "$POSTGRES_CONTAINER" pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip -9 > "${BACKUP_LOCAL_PATH}/${FILENAME}.partial"; then
  echo "[backup-postgres] ERROR: pg_dump failed. No backup was written for this run." >&2
  rm -f "${BACKUP_LOCAL_PATH}/${FILENAME}.partial"
  exit 1
fi

mv "${BACKUP_LOCAL_PATH}/${FILENAME}.partial" "${BACKUP_LOCAL_PATH}/${FILENAME}"
echo "[backup-postgres] wrote ${BACKUP_LOCAL_PATH}/${FILENAME}"

# Optional off-box copy via rclone, to a remote the CUSTOMER configures themselves
# (BACKUP_RCLONE_REMOTE, e.g. "s3:my-bucket/warmhawk-backups"). WarmHawk never operates or has
# access to this remote — it's the customer's own account/credentials via their own rclone config.
if [ -n "$BACKUP_RCLONE_REMOTE" ]; then
  if command -v rclone >/dev/null 2>&1; then
    echo "[backup-postgres] copying to off-box remote: ${BACKUP_RCLONE_REMOTE}"
    rclone copy "${BACKUP_LOCAL_PATH}/${FILENAME}" "$BACKUP_RCLONE_REMOTE" || \
      echo "[backup-postgres] WARNING: rclone copy failed; the local backup above is still valid." >&2
  else
    echo "[backup-postgres] WARNING: BACKUP_RCLONE_REMOTE is set but rclone is not installed. Skipping off-box copy." >&2
  fi
fi

# Retention window — delete local backups older than BACKUP_RETENTION_DAYS. Does not touch
# anything already copied to an off-box remote (rclone's own remote-side retention, if any, is
# the customer's responsibility to configure).
echo "[backup-postgres] pruning backups older than ${BACKUP_RETENTION_DAYS} days from ${BACKUP_LOCAL_PATH}"
find "$BACKUP_LOCAL_PATH" -name 'warmhawk-postgres-*.sql.gz' -type f -mtime "+${BACKUP_RETENTION_DAYS}" -delete

echo "[backup-postgres] done."
