#!/usr/bin/env bash
# WarmHawk Core Engine — scripts/install.sh
#
# One command, zero-touch install (Minimal-Effort Launch): validates Docker/Compose, runs
# preflight checks BEFORE anything destructive, generates every secret via `openssl rand`, brings
# up nginx HTTP-only, runs certbot, reloads TLS, prompts once for nightly backups, and brings the
# full stack up. Idempotent — safe to re-run after any failure, a typo'd domain, or an interrupted
# connection.
#
# NOTE (API-surface correction pass): this script previously also required a `--license` flag,
# generated an RSA license-signing keypair, and POSTed to a core-engine `/auth/activate` route —
# all vestigial leftovers from a license-issuance system that was mistakenly built into this repo
# during an earlier parallel-agent build (see packages/db/prisma/schema.prisma's "V12 fix" note).
# Tier 0 (this engine) carries no license gate at all; license issuance/RSA signing lives solely in
# warmhawk-site, license VERIFICATION lives solely in warmhawk-enterprise-operator's own dashboard
# — core-engine was never meant to own either half. `/auth/activate` was never actually implemented
# here, so that block silently no-op'd on every real install; removed rather than built, per that
# same design decision.
#
# Usage:
#   ./scripts/install.sh --domain api.yourcompany.com
#   ./scripts/install.sh --retry-tls          # retry only the TLS issuance step after a prior failure
#   ./scripts/install.sh --skip-certbot --cert-path /path/to/fullchain.pem --key-path /path/to/privkey.pem
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$REPO_ROOT/.env"

DOMAIN=""
RETRY_TLS=false
SKIP_CERTBOT=false
CERT_PATH=""
KEY_PATH=""

log()  { echo "[install] $*"; }
fail() {
  echo "[install] ERROR: $*" >&2
  echo "[install] Next step: fix the issue above, then re-run: ./scripts/install.sh --domain <domain>" >&2
  exit 1
}

# --- Argument parsing -------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --retry-tls) RETRY_TLS=true; shift ;;
    --skip-certbot) SKIP_CERTBOT=true; shift ;;
    --cert-path) CERT_PATH="$2"; shift 2 ;;
    --key-path) KEY_PATH="$2"; shift 2 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

# --- Idempotency: load any already-generated secrets from a prior run --------------------------
if [ -f "$ENV_FILE" ]; then
  log ".env already exists — re-run detected, reusing existing secrets where present."
  set -a; source "$ENV_FILE"; set +a
fi

# --- --retry-tls short-circuit: only redo the certbot step, nothing else -----------------------
if [ "$RETRY_TLS" = true ]; then
  [ -z "${WARMHAWK_DOMAIN:-}" ] && fail "No existing WARMHAWK_DOMAIN found in .env — run a full install first."
  log "Retrying TLS issuance for ${WARMHAWK_DOMAIN}..."
  docker compose -f "$REPO_ROOT/docker-compose.yml" run --rm certbot \
    certbot certonly --webroot -w /var/www/certbot -d "$WARMHAWK_DOMAIN" --non-interactive --agree-tos -m "admin@${WARMHAWK_DOMAIN}" \
    || fail "certbot retry failed. Confirm DNS for ${WARMHAWK_DOMAIN} now resolves to this server, then re-run: ./scripts/install.sh --retry-tls"
  docker compose -f "$REPO_ROOT/docker-compose.yml" exec nginx nginx -s reload
  log "TLS issuance succeeded and nginx reloaded."
  exit 0
fi

# --- Required flags for a fresh/full install ----------------------------------------------------
[ -z "$DOMAIN" ] && fail "--domain is required (e.g. --domain api.yourcompany.com)"

# --- Preflight checks — BEFORE anything destructive ---------------------------------------------
log "Running preflight checks..."

command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install Docker first: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin is not available. Install/upgrade Docker to a version that includes 'docker compose'."

check_port_free() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "( sport = :$port )" 2>/dev/null | grep -q ":$port" && return 1
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | grep -q ":$port " && return 1
  fi
  return 0
}
check_port_free 80  || fail "Port 80 is already in use. Stop whatever's using it (another web server?) and re-run."
check_port_free 443 || fail "Port 443 is already in use. Stop whatever's using it and re-run."

RESOLVED_IP=""
if command -v dig >/dev/null 2>&1; then
  RESOLVED_IP="$(dig +short "$DOMAIN" A | tail -n1)"
elif command -v getent >/dev/null 2>&1; then
  RESOLVED_IP="$(getent hosts "$DOMAIN" | awk '{print $1}' | tail -n1)"
fi
CURRENT_PUBLIC_IP="$(curl -fsS https://api.ipify.org 2>/dev/null || true)"

DNS_RESOLVES=false
if [ -n "$RESOLVED_IP" ] && [ -n "$CURRENT_PUBLIC_IP" ] && [ "$RESOLVED_IP" = "$CURRENT_PUBLIC_IP" ]; then
  DNS_RESOLVES=true
fi

if [ "$DNS_RESOLVES" = false ] && [ "$SKIP_CERTBOT" = false ]; then
  log "WARNING: ${DOMAIN} does not appear to resolve to this server's public IP yet"
  log "  (resolved: ${RESOLVED_IP:-<none>}, this server: ${CURRENT_PUBLIC_IP:-<unknown>})."
  log "  Certbot issuance will likely fail until DNS propagates. Continuing preflight anyway —"
  log "  re-run with --retry-tls once DNS is confirmed."
fi

log "Preflight checks passed (Docker present, ports 80/443 free)."

# --- Secret generation (idempotent — only fill in what's missing) ------------------------------
gen_secret() { openssl rand -base64 "$1" | tr -d '\n'; }

: "${POSTGRES_PASSWORD:=$(gen_secret 32)}"
: "${REDIS_PASSWORD:=$(gen_secret 32)}"
: "${JWT_SECRET:=$(gen_secret 48)}"
: "${MAILBOX_CREDENTIAL_KEY:=$(gen_secret 32)}"
: "${NEXTJS_CALLBACK_SECRET:=$(gen_secret 32)}"
: "${OPERATOR_SERVICE_TOKEN:=$(gen_secret 32)}"
: "${N8N_ENCRYPTION_KEY:=$(gen_secret 32)}"
: "${UPTIME_KUMA_USERNAME:=admin}"
: "${UPTIME_KUMA_PASSWORD:=$(gen_secret 24)}"

cat > "$ENV_FILE" <<EOF
WARMHAWK_DOMAIN=$DOMAIN
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
REDIS_PASSWORD=$REDIS_PASSWORD
JWT_SECRET=$JWT_SECRET
MAILBOX_CREDENTIAL_KEY=$MAILBOX_CREDENTIAL_KEY
NEXTJS_CALLBACK_SECRET=$NEXTJS_CALLBACK_SECRET
OPERATOR_SERVICE_TOKEN=$OPERATOR_SERVICE_TOKEN
N8N_ENCRYPTION_KEY=$N8N_ENCRYPTION_KEY
UPTIME_KUMA_USERNAME=$UPTIME_KUMA_USERNAME
UPTIME_KUMA_PASSWORD=$UPTIME_KUMA_PASSWORD
# Optional — set this to a webhook URL (Slack/Discord/PagerDuty/etc.) to receive Uptime Kuma
# down/up alerts. Leave blank to run dashboard-only monitoring with no external alerting.
UPTIME_KUMA_ALERT_WEBHOOK_URL=${UPTIME_KUMA_ALERT_WEBHOOK_URL:-}
EOF
log "Secrets generated/loaded and written to .env (never committed — see .gitignore)."

# --- Bring up nginx HTTP-only + core services (no TLS yet) -------------------------------------
log "Starting core services (HTTP-only, pre-TLS)..."
docker compose -f "$REPO_ROOT/docker-compose.yml" up -d postgres redis migrate api worker n8n uptime-kuma nginx

# --- Uptime Kuma auto-provisioning (admin account + monitors + optional alert webhook) ---------
# Degrades, never aborts the install — this is bundled monitoring, not a guardrail the rest of the
# stack depends on. A failure here (e.g. Kuma still starting up, or a container-runtime quirk)
# just means monitors weren't created yet; re-run this exact command any time to retry.
log "Provisioning Uptime Kuma (admin account + monitors)..."
if docker compose -f "$REPO_ROOT/docker-compose.yml" run --rm kuma-provision; then
  log "Uptime Kuma provisioning complete."
else
  log "WARNING: Uptime Kuma provisioning failed. Retry any time with:"
  log "  docker compose -f $REPO_ROOT/docker-compose.yml run --rm kuma-provision"
fi

# --- TLS bootstrap -------------------------------------------------------------------------------
TLS_READY=false
if [ "$SKIP_CERTBOT" = true ]; then
  [ -z "$CERT_PATH" ] || [ -z "$KEY_PATH" ] && fail "--skip-certbot requires both --cert-path and --key-path"
  log "Skipping certbot (BYO-cert escape hatch) — mount ${CERT_PATH}/${KEY_PATH} into the nginx container per docs/backup-and-restore.md's sibling TLS doc."
  TLS_READY=true
else
  log "Requesting a Let's Encrypt certificate for ${DOMAIN} via certbot (webroot HTTP-01)..."
  if docker compose -f "$REPO_ROOT/docker-compose.yml" run --rm certbot \
      certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" --non-interactive --agree-tos -m "admin@${DOMAIN}"; then
    docker compose -f "$REPO_ROOT/docker-compose.yml" exec nginx nginx -s reload
    TLS_READY=true
    log "TLS certificate issued and nginx reloaded."
  else
    # Certbot failure degrades, never crashes — nginx stays up HTTP-only.
    log "WARNING: certbot TLS issuance failed. nginx remains up in HTTP-only mode."
    log "  Most common cause: DNS for ${DOMAIN} hasn't propagated to this server yet."
    log "  Next step once DNS is confirmed: ./scripts/install.sh --retry-tls"
  fi
fi

docker compose -f "$REPO_ROOT/docker-compose.yml" up -d certbot

# --- Nightly backup opt-in (prompts once) -------------------------------------------------------
ENABLE_BACKUPS="yes"
if [ -t 0 ]; then
  read -r -p "[install] Enable nightly Postgres backups? (recommended) [Y/n] " BACKUP_ANSWER || true
  case "${BACKUP_ANSWER:-Y}" in
    [nN]*) ENABLE_BACKUPS="no" ;;
    *) ENABLE_BACKUPS="yes" ;;
  esac
fi

BACKUP_PATH_WRITABLE=false
BACKUP_TARGET_DIR="${BACKUP_LOCAL_PATH:-/var/backups/warmhawk}"
mkdir -p "$BACKUP_TARGET_DIR" 2>/dev/null && [ -w "$BACKUP_TARGET_DIR" ] && BACKUP_PATH_WRITABLE=true

# Multi-condition go/no-go (V12 rule): backup cron setup requires BOTH "customer opted in" AND a
# writable target path — never assume the first-checked condition implies the second.
if [ "$ENABLE_BACKUPS" = "yes" ] && [ "$BACKUP_PATH_WRITABLE" = true ]; then
  CRON_LINE="0 2 * * * cd $REPO_ROOT && ./scripts/backup-postgres.sh >> /var/log/warmhawk-backup.log 2>&1"
  ( crontab -l 2>/dev/null | grep -v "warmhawk-backup" ; echo "$CRON_LINE" ) | crontab -
  log "Nightly backups enabled (02:00 daily -> ${BACKUP_TARGET_DIR}, ${BACKUP_RETENTION_DAYS:-14}-day retention)."
elif [ "$ENABLE_BACKUPS" = "yes" ] && [ "$BACKUP_PATH_WRITABLE" = false ]; then
  log "WARNING: backups were requested but ${BACKUP_TARGET_DIR} is not writable — cron NOT installed."
  log "  Next step: fix permissions on ${BACKUP_TARGET_DIR} (or set BACKUP_LOCAL_PATH in .env), then re-run this script."
else
  log "Nightly backups skipped by choice. Enable later by re-running this script."
fi

log "Bringing up the full stack..."
docker compose -f "$REPO_ROOT/docker-compose.yml" up -d --build

log "Done. TLS ready: ${TLS_READY}. Visit https://${DOMAIN}/ once TLS is confirmed."
log "Run './scripts/update.sh' any time to pull the latest release and migrate in place."
log "Running warmhawk-enterprise-operator too? Copy this .env's OPERATOR_SERVICE_TOKEN value into"
log "  that repo's own .env as CORE_ENGINE_SERVICE_TOKEN — the two packages never share a .env, so"
log "  nothing does this for you automatically. Without it, the dashboard's data pages 401."
