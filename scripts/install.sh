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
#   ./scripts/install.sh --domain api.yourcompany.com --http-port 8080 --https-port 8443
#     # install alongside an existing web server that already owns 80/443 — see the port-selection
#     # block below and docs/troubleshooting.md's "Installing alongside an existing web server".
#     # Omit --http-port/--https-port and this happens automatically when 80/443 are occupied.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$REPO_ROOT/.env"
NGINX_TEMPLATE="$REPO_ROOT/nginx/nginx.conf.template"

# Bug fix (DooD end-to-end install run, 2026-08-25): mirrors
# warmhawk-enterprise-operator/scripts/install.sh's enable_tls_template() — nginx.conf.template
# ships with the `listen 443 ssl` block commented out (see that file's own header comment for why:
# nginx validates every ssl_certificate path at config-load time, so a cert that doesn't exist yet
# crashes the whole process, not just that server block). Only ever called after certbot has
# actually issued a cert. envsubst only runs at container START (the official nginx image's
# docker-entrypoint hook), never on `nginx -s reload` — so enabling TLS always means a `restart`,
# not a `reload`.
enable_tls_template() {
  if ! grep -q "Enabled by scripts/install.sh" "$NGINX_TEMPLATE" 2>/dev/null; then
    log "nginx.conf.template already TLS-enabled — nothing to flip."
    return 0
  fi
  awk '
    index($0, "Enabled by scripts/install.sh") > 0 { found=1; next }
    found { line=$0; sub(/^# ?/, "", line); print line; next }
  ' "$NGINX_TEMPLATE" > "$NGINX_TEMPLATE.new"
  mv "$NGINX_TEMPLATE.new" "$NGINX_TEMPLATE"
  log "nginx.conf.template updated to enable the TLS server block."
}

DOMAIN=""
RETRY_TLS=false
SKIP_CERTBOT=false
CERT_PATH=""
KEY_PATH=""
HTTP_PORT_FLAG=""
HTTPS_PORT_FLAG=""

log()  { echo "[install] $*"; }
fail() {
  echo "[install] ERROR: $*" >&2
  echo "[install] Next step: fix the issue above, then re-run: ./scripts/install.sh --domain <domain>" >&2
  exit 1
}

# A container failing to become healthy during `docker compose up` previously aborted here with
# zero visible cause (set -e catching compose's own non-zero exit) — a real customer hitting this
# had nothing to go on but "it failed." Dumps every service's recent logs so the actual crash
# reason (bad env var, port clash inside the container, migration error, etc.) is visible instead.
dump_compose_logs_and_fail() {
  log "docker compose up failed — dumping recent logs from every service for diagnosis:"
  docker compose -f "$REPO_ROOT/docker-compose.yml" logs --no-color --tail=100 || true
  fail "$1"
}

# --- Argument parsing -------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --retry-tls) RETRY_TLS=true; shift ;;
    --skip-certbot) SKIP_CERTBOT=true; shift ;;
    --cert-path) CERT_PATH="$2"; shift 2 ;;
    --key-path) KEY_PATH="$2"; shift 2 ;;
    --http-port) HTTP_PORT_FLAG="$2"; shift 2 ;;
    --https-port) HTTPS_PORT_FLAG="$2"; shift 2 ;;
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
  # --entrypoint certbot: the certbot service's own entrypoint (docker-compose.yml)
  # is pinned to /bin/sh so the renewal loop's `command: ['-c', '...']` works —
  # but `docker compose run` only replaces `command:`, never `entrypoint:`, so
  # without this override the override args below would run as `sh certbot
  # certonly ...`, and sh tries to open a file literally named "certbot" as a
  # script ("/bin/sh: can't open 'certbot': No such file or directory").
  docker compose -f "$REPO_ROOT/docker-compose.yml" run --rm --entrypoint certbot certbot \
    certonly --webroot -w /var/www/certbot -d "$WARMHAWK_DOMAIN" --non-interactive --agree-tos -m "admin@${WARMHAWK_DOMAIN}" \
    || fail "certbot retry failed. Confirm DNS for ${WARMHAWK_DOMAIN} now resolves to this server, then re-run: ./scripts/install.sh --retry-tls"
  enable_tls_template
  log "Restarting nginx so it re-renders its template (envsubst only runs at container start, never on reload)..."
  docker compose -f "$REPO_ROOT/docker-compose.yml" restart nginx
  log "TLS issuance succeeded and nginx restarted with TLS enabled."
  exit 0
fi

# --- Required flags for a fresh/full install ----------------------------------------------------
[ -z "$DOMAIN" ] && fail "--domain is required (e.g. --domain api.yourcompany.com)"

# --- Preflight checks — BEFORE anything destructive ---------------------------------------------
log "Running preflight checks..."

command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install Docker first: https://docs.docker.com/engine/install/"
# Bug fix (install-flow-fast's first real DinD run, 2026-08-26): gen_secret below shells out to
# openssl directly (not a containerized one) — without this check, a host missing it doesn't fail
# here, it silently writes EMPTY secrets into .env (openssl rand producing no output is not itself
# an error `set -e` catches, since it's nested inside a `:=` parameter expansion), which then
# surfaces many minutes later as postgres refusing to start on an empty POSTGRES_PASSWORD, with
# nothing pointing back at the real cause. Confirmed live: this exact CI step's own base image
# doesn't ship openssl.
command -v openssl >/dev/null 2>&1 || fail "openssl is not installed — it's required to generate this install's secrets. Install it first (e.g. 'apt install openssl' / 'apk add openssl')."
docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin is not available. Install/upgrade Docker to a version that includes 'docker compose'."

# Bug fix (port-fallback authoring pass): `ss`/`netstat -ltn` aren't guaranteed present — a minimal
# base image commonly ships neither. Falls back to bash's own /dev/tcp builtin (a real TCP connect
# attempt, no external command needed) rather than silently reporting every port "free" when neither
# tool exists, which would have made the port-conflict fallback below never trigger.
#
# Bug fix (install-flow-fast's DinD run, 2026-08-26): ss/netstat only ever introspect THIS PROCESS's
# own network namespace. Under DinD (this script's own docker/docker-compose commands talking to a
# remote daemon via DOCKER_HOST, same as HEALTH_CHECK_HOST's rationale a few lines below), the actual
# port bindings this check needs to see live in that remote daemon's namespace, not this one — so
# ss/netstat always reported 80/443 "free" even when the daemon had already bound them, and the real
# `docker compose up` a few lines down then failed outright with "port is already allocated" instead
# of ever reaching the alt-port fallback path. ss/netstat stay the fast, preferred path for the
# ordinary same-namespace case (a real customer's box); a non-loopback HEALTH_CHECK_HOST means the
# daemon is elsewhere, so only a real TCP connect attempt against that host can answer correctly.
HEALTH_CHECK_HOST="${HEALTH_CHECK_HOST:-127.0.0.1}"
check_port_free() {
  local port="$1"
  if [ "$HEALTH_CHECK_HOST" = "127.0.0.1" ] || [ "$HEALTH_CHECK_HOST" = "localhost" ]; then
    if command -v ss >/dev/null 2>&1; then
      ss -ltn "( sport = :$port )" 2>/dev/null | grep -q ":$port" && return 1
      return 0
    elif command -v netstat >/dev/null 2>&1 && netstat -ltn >/dev/null 2>&1; then
      netstat -ltn 2>/dev/null | grep -q ":$port " && return 1
      return 0
    fi
  fi
  (exec 3<>"/dev/tcp/${HEALTH_CHECK_HOST}/$port") 2>/dev/null && { exec 3<&-; exec 3>&-; return 1; }
  return 0
}

# --- Port selection: 80/443, or an alt-port co-exist mode ---------------------------------------
# A real customer's box is not guaranteed to be empty — it may already run some other web server
# on 80/443. This used to be a hard fail(); now it falls back to alt ports instead, so the install
# actually completes either way. `nginx_already_running` distinguishes "occupied by something else"
# from "occupied by our OWN already-running stack from a prior install" — without that check, every
# idempotent re-run of an already-installed, working instance would wrongly trip the fallback path,
# since our own nginx would itself be the thing holding the port.
nginx_already_running() {
  docker compose -f "$REPO_ROOT/docker-compose.yml" ps --status running nginx 2>/dev/null | grep -q nginx
}

if [ -n "$HTTP_PORT_FLAG" ] || [ -n "$HTTPS_PORT_FLAG" ]; then
  NGINX_HTTP_HOST_PORT="${HTTP_PORT_FLAG:-${NGINX_HTTP_HOST_PORT:-80}}"
  NGINX_HTTPS_HOST_PORT="${HTTPS_PORT_FLAG:-${NGINX_HTTPS_HOST_PORT:-443}}"
  log "Using explicit port override: ${NGINX_HTTP_HOST_PORT}/${NGINX_HTTPS_HOST_PORT}."
elif nginx_already_running; then
  : "${NGINX_HTTP_HOST_PORT:=80}"
  : "${NGINX_HTTPS_HOST_PORT:=443}"
  log "nginx is already running from a prior install — reusing its ports (${NGINX_HTTP_HOST_PORT}/${NGINX_HTTPS_HOST_PORT})."
elif check_port_free 80 && check_port_free 443; then
  NGINX_HTTP_HOST_PORT=80
  NGINX_HTTPS_HOST_PORT=443
else
  : "${NGINX_HTTP_HOST_PORT:=8080}"
  : "${NGINX_HTTPS_HOST_PORT:=8443}"
  PORT_FALLBACK=true
  log "WARNING: port 80 and/or 443 is already in use by something else on this host."
  log "  Continuing anyway — nginx will publish ${NGINX_HTTP_HOST_PORT}/${NGINX_HTTPS_HOST_PORT} instead of 80/443."
  log "  You'll need to forward ${DOMAIN} from whatever already owns 80/443 to 127.0.0.1:${NGINX_HTTP_HOST_PORT}"
  log "  (HTTP, including the /.well-known/acme-challenge/ path certbot needs below) and"
  log "  127.0.0.1:${NGINX_HTTPS_HOST_PORT} (HTTPS) — see docs/troubleshooting.md's 'Installing"
  log "  alongside an existing web server' section for a copy-paste config snippet."
fi

RESOLVED_IP=""
# Bug fix (install-flow-fast's first real DinD run, 2026-08-26): a non-resolving domain (this
# script's own test suite uses .invalid domains, and any real customer running this before DNS
# has propagated hits the exact same thing) makes dig/getent exit non-zero — under this script's
# `set -euo pipefail`, an unguarded `VAR="$(cmd | ...)"` assignment treats that as a fatal error
# and aborts silently right here, never reaching the "DNS not resolving yet, continuing anyway"
# warning a few lines down that this whole block exists to reach. `|| true` on each assignment
# means "couldn't resolve" is treated the same whether the lookup tool itself is missing or just
# came back empty — both correctly leave RESOLVED_IP empty instead of crashing.
if command -v dig >/dev/null 2>&1; then
  RESOLVED_IP="$(dig +short "$DOMAIN" A | tail -n1)" || true
elif command -v getent >/dev/null 2>&1; then
  RESOLVED_IP="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | tail -n1)" || true
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

log "Preflight checks passed (Docker present, ports ${NGINX_HTTP_HOST_PORT}/${NGINX_HTTPS_HOST_PORT} selected)."

# --- Secret generation (idempotent — only fill in what's missing) ------------------------------
# Bug fix (DooD end-to-end install run, 2026-08-25): -base64 output can (and did, ~75% of the
# time by the base64 alphabet's own math) contain '/', '+', or other characters that are illegal
# unescaped in a URL's userinfo component per RFC 3986. Every secret generated here gets embedded
# directly into a connection string (DATABASE_URL, REDIS_URL) without any URL-encoding step, so a
# generated password containing '/' broke ioredis's strict WHATWG URL parser outright — confirmed
# live: apps/worker crash-looped forever on a freshly generated REDIS_PASSWORD containing '/'.
# -hex reads the same number of random bytes (identical entropy) and is unconditionally URL-safe.
# Bug fix (deeper-coverage authoring pass, 2026-08-26): some openssl builds (confirmed on a
# Windows/MSYS dev box, not real Linux CI/customer targets) emit a trailing CRLF rather than a
# bare LF — `tr -d '\n'` alone left a stray \r embedded at the end of the secret. Invisible in
# every log (a CR never renders as a visible character) but a real value corruption: sourcing
# this same .env back on a re-run strips that \r again on reload, so the "same" secret came back
# one byte shorter than what was actually written — caught by test-idempotent-rerun.sh's
# byte-for-byte .env comparison, not by anything that only checks the app still starts.
gen_secret() { openssl rand -hex "$1" | tr -d '\r\n'; }

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
NGINX_HTTP_HOST_PORT=$NGINX_HTTP_HOST_PORT
NGINX_HTTPS_HOST_PORT=$NGINX_HTTPS_HOST_PORT
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
docker compose -f "$REPO_ROOT/docker-compose.yml" up -d postgres redis migrate api worker n8n uptime-kuma nginx \
  || dump_compose_logs_and_fail "core services failed to start — see logs above."

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
  log "Skipping certbot (BYO-cert escape hatch) — mount ${CERT_PATH}/${KEY_PATH} into the nginx container's /etc/letsencrypt/live/${DOMAIN}/ path per docs/backup-and-restore.md's sibling TLS doc, then re-run with --retry-tls to enable the TLS server block."
  TLS_READY=true
else
  log "Requesting a Let's Encrypt certificate for ${DOMAIN} via certbot (webroot HTTP-01)..."
  # --entrypoint certbot — see the matching --retry-tls invocation above for why.
  if docker compose -f "$REPO_ROOT/docker-compose.yml" run --rm --entrypoint certbot certbot \
      certonly --webroot -w /var/www/certbot -d "$DOMAIN" --non-interactive --agree-tos -m "admin@${DOMAIN}"; then
    enable_tls_template
    log "Restarting nginx so it re-renders its template with TLS enabled (envsubst only runs at container start)..."
    docker compose -f "$REPO_ROOT/docker-compose.yml" restart nginx
    TLS_READY=true
    log "TLS certificate issued and nginx restarted with TLS enabled."
  else
    # Certbot failure degrades, never crashes — nginx stays up HTTP-only.
    log "WARNING: certbot TLS issuance failed. nginx remains up in HTTP-only mode."
    log "  Most common cause: DNS for ${DOMAIN} hasn't propagated to this server yet."
    log "  Next step once DNS is confirmed: ./scripts/install.sh --retry-tls"
  fi
fi

docker compose -f "$REPO_ROOT/docker-compose.yml" up -d certbot \
  || dump_compose_logs_and_fail "certbot renewal sidecar failed to start — see logs above."

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
docker compose -f "$REPO_ROOT/docker-compose.yml" up -d --build \
  || dump_compose_logs_and_fail "final full-stack startup failed — see logs above."

if [ "${PORT_FALLBACK:-false}" = true ]; then
  log "Done. TLS ready: ${TLS_READY}. nginx is on alt ports ${NGINX_HTTP_HOST_PORT}/${NGINX_HTTPS_HOST_PORT} —"
  log "  visit https://${DOMAIN}/ once your existing web server is forwarding to them (see the WARNING above)."
else
  log "Done. TLS ready: ${TLS_READY}. Visit https://${DOMAIN}/ once TLS is confirmed."
fi
log "Run './scripts/update.sh' any time to pull the latest release and migrate in place."
log "Running warmhawk-enterprise-operator too? Copy this .env's OPERATOR_SERVICE_TOKEN value into"
log "  that repo's own .env as CORE_ENGINE_SERVICE_TOKEN — the two packages never share a .env, so"
log "  nothing does this for you automatically. Without it, the dashboard's data pages 401."
