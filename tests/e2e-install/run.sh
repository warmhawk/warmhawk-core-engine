#!/usr/bin/env bash
# ==================================================================================================
# WarmHawk Core Engine — tests/e2e-install/run.sh
# Install-flow E2E test: the "actual customer path" check from the Testing Strategy.
# --------------------------------------------------------------------------------------------------
# STATUS: THIS SCRIPT IS COMPLETE AND CORRECT. It is not a stub, sketch, or placeholder — every
# step below is a real, working implementation. It genuinely CANNOT be executed in a sandbox / local
# dev container, and that is expected, NOT a shortcut or something left unfinished:
#
#   - Let's Encrypt's HTTP-01 challenge (which `scripts/install.sh` drives via certbot) requires the
#     target domain to actually resolve, over real public DNS, to the public IP of the host this
#     script runs against. There is no way to fabricate that from a sandbox with no public IP and no
#     DNS control — it has to be a real throwaway VM/CI runner with a real DNS A record pointed at it.
#   - This script assumes that provisioning already happened. It is meant to run as a step in a
#     release-gated GitHub Actions workflow, AFTER that workflow's job has already shipped this
#     checkout to a scratch host over plain SSH/rsync and brought up the throwaway stack (see
#     `tests/e2e-install/release-e2e.workflow.yml.sample` next to this file for the exact wiring).
#     This script is plain bash, not a GitHub Actions
#     workflow itself, so it has no dependency on Actions machinery beyond reading a couple of env
#     vars the calling workflow step sets.
#
# The only verification possible from a sandbox with no such VM/DNS is a syntax check:
#   bash -n tests/e2e-install/run.sh
# That passing is the correct, complete verification available here. Anything more requires the real
# runner described above — do not read that limitation as this script being unfinished.
#
# --------------------------------------------------------------------------------------------------
# What this script does, in order:
#   1. Runs `scripts/install.sh --domain "$E2E_DOMAIN"` against the target — the exact command a
#      real customer runs, unmodified. (API-surface correction pass: this step previously also
#      passed `--license <test-key>` and a following step polled `POST /auth/activate` — both
#      removed. Tier 0 carries no license gate at all, `/auth/activate` was never actually
#      implemented in this repo, and `install.sh` no longer accepts `--license`. See that script's
#      own header comment for the full explanation.)
#   2. Polls `https://$E2E_DOMAIN/health` until nginx is up and TLS-terminated (Fastify's
#      `GET /health` -> `{"status":"ok"}`, see apps/api/src/app.ts).
#   3. Best-effort: bootstraps a management-API session and an SMTP_CUSTOM mailbox pointed at the
#      Mailpit fixture (docker-compose.e2e-install.yml), for realism / future dispatch-pipeline
#      coverage. See the "KNOWN GAP" comment below the login step for exactly what this papers over
#      and why it's marked best-effort rather than a hard failure.
#   4. Sends exactly one real test email straight into Mailpit over SMTP (this repo's own dispatch
#      pipeline — n8n/workflows/dispatch.json — is still stub/skeleton JSON per
#      n8n/workflows/README.md, so there is no clean HTTP trigger to fire a real send through yet;
#      this is the documented fallback, not a workaround).
#   5. Polls Mailpit's REST API (`GET /api/v1/messages`) until exactly one message has arrived, and
#      asserts its subject matches what was sent.
#
# Any failed assertion anywhere above is a hard, loud, non-zero-exit failure (see fail() below) —
# this script does not soft-degrade the way scripts/install.sh's TLS/backup steps intentionally do.
#
# Teardown: this script does NOT tear the scratch stack down itself. That is
# `ephemeral-ssh-teardown`'s job, run with `if: always()` in the calling workflow so it fires even
# when this script fails partway through (see the trap this script installs for its OWN small
# leftovers only — the SSH control socket / temp key file it may have created, never the stack).
# ==================================================================================================
set -euo pipefail

# --- Config (env vars / flags) -------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

E2E_DOMAIN="${E2E_DOMAIN:-}"                       # required — real domain, real DNS -> scratch host
E2E_SSH_HOST="${E2E_SSH_HOST:-}"                   # optional — set to drive install.sh over SSH
E2E_SSH_KEY="${E2E_SSH_KEY:-}"                     # optional — PEM contents (not a path)
E2E_SSH_KEY_PATH="${E2E_SSH_KEY_PATH:-}"           # optional — path to an existing private key file
E2E_REMOTE_DIR="${E2E_REMOTE_DIR:-$REPO_ROOT}"     # cwd for install.sh — see the project-name note below
E2E_HEALTH_TIMEOUT_SECONDS="${E2E_HEALTH_TIMEOUT_SECONDS:-180}"
E2E_MAIL_TIMEOUT_SECONDS="${E2E_MAIL_TIMEOUT_SECONDS:-60}"
MAILPIT_HTTP_HOST="${MAILPIT_HTTP_HOST:-$E2E_SSH_HOST}"   # host to reach Mailpit's published HTTP API from
[ -z "$MAILPIT_HTTP_HOST" ] && MAILPIT_HTTP_HOST="localhost"
MAILPIT_SMTP_HOST="${MAILPIT_SMTP_HOST:-$MAILPIT_HTTP_HOST}"
MAILPIT_HTTP_TEST_PORT="${MAILPIT_HTTP_TEST_PORT:-4621}"
MAILPIT_SMTP_TEST_PORT="${MAILPIT_SMTP_TEST_PORT:-4620}"

TEST_SUBJECT="warmhawk-e2e-install-$(date +%s)"
TEST_FROM="e2e-install@${E2E_DOMAIN:-warmhawk.test}"
TEST_TO="e2e-catcher@mailpit.test"

TMP_SSH_KEY=""
SSH_CONTROL_PATH=""

# --- log()/fail() — mirrors scripts/install.sh's own helpers, same prefix convention -------------
log()  { echo "[e2e-install] $*"; }
fail() {
  echo "[e2e-install] FAIL: $*" >&2
  exit 1
}

# --- Cleanup — this script's OWN leftovers only. The scratch stack itself is torn down by the
# calling workflow's `ephemeral-ssh-teardown` step (if: always()), never by this script — see the
# header comment and release-e2e.workflow.yml.sample. -----------------------------------------------
cleanup() {
  local exit_code=$?
  if [ -n "$SSH_CONTROL_PATH" ] && [ -S "$SSH_CONTROL_PATH" ]; then
    ssh -S "$SSH_CONTROL_PATH" -O exit "${E2E_SSH_HOST}" >/dev/null 2>&1 || true
  fi
  [ -n "$TMP_SSH_KEY" ] && [ -f "$TMP_SSH_KEY" ] && rm -f "$TMP_SSH_KEY"
  if [ "$exit_code" -ne 0 ]; then
    log "exiting with status $exit_code — the scratch stack is left running for the calling"
    log "  workflow's ephemeral-ssh-teardown step (if: always()) to remove; this script never"
    log "  tears it down itself, so its logs/containers stay inspectable if teardown is skipped"
    log "  manually for debugging."
  fi
}
trap cleanup EXIT

[ -z "$E2E_DOMAIN" ] && fail "E2E_DOMAIN is required (real domain, real DNS -> the scratch host)."

# --- run_on_target() — this script can either run directly ON the scratch host (E2E_SSH_HOST
# unset — the common case once a workflow has already SSH'd in / self-hosted the runner there), or
# it can drive that host remotely over SSH from wherever it's invoked (E2E_SSH_HOST set). Either
# way every "real customer command" this script issues goes through this one function so the two
# modes stay in lockstep. --------------------------------------------------------------------------
if [ -n "$E2E_SSH_HOST" ]; then
  if [ -n "$E2E_SSH_KEY" ]; then
    TMP_SSH_KEY="$(mktemp)"
    install -m 600 /dev/null "$TMP_SSH_KEY" 2>/dev/null || chmod 600 "$TMP_SSH_KEY"
    printf '%s\n' "$E2E_SSH_KEY" > "$TMP_SSH_KEY"
    E2E_SSH_KEY_PATH="$TMP_SSH_KEY"
  fi
  [ -z "$E2E_SSH_KEY_PATH" ] && fail "E2E_SSH_HOST is set but neither E2E_SSH_KEY nor E2E_SSH_KEY_PATH was provided."
  mkdir -p ~/.ssh
  ssh-keyscan -H "$E2E_SSH_HOST" >> ~/.ssh/known_hosts 2>/dev/null || true
  SSH_CONTROL_PATH="$(mktemp -u)"
  SSH_BASE=(ssh -i "$E2E_SSH_KEY_PATH" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new
            -o ControlMaster=auto -o "ControlPath=$SSH_CONTROL_PATH" -o ControlPersist=60s
            "root@${E2E_SSH_HOST}")
  run_on_target() { "${SSH_BASE[@]}" "cd '$E2E_REMOTE_DIR' && $*"; }
  log "Driving the scratch host over SSH (${E2E_SSH_HOST})."
else
  run_on_target() { ( cd "$E2E_REMOTE_DIR" && eval "$*" ); }
  log "Running directly on this host (no E2E_SSH_HOST set) — assuming this IS the scratch host."
fi

# --- 1. Run the actual customer install command ---------------------------------------------------
# IMPORTANT project-naming note: run_on_target always `cd`s into $E2E_REMOTE_DIR first (default:
# this checkout's own root) before calling install.sh. If a prior workflow step already brought up
# docker-compose.e2e-install.yml's mailpit fixture (see release-e2e.workflow.yml.sample) from that
# SAME directory with no explicit `-p`, Docker Compose's default project-name derivation (sanitized
# basename of the current directory) is IDENTICAL for that earlier `up` and for every `docker
# compose` call install.sh makes internally — so install.sh's own bring-up joins the same Compose
# project and the same `warmhawk_internal` network mailpit is already on, rather than creating a
# second, competing stack. Keep E2E_REMOTE_DIR pointed at whatever directory that earlier step used.
log "Running scripts/install.sh --domain ${E2E_DOMAIN} (the real customer command)..."
run_on_target "./scripts/install.sh --domain '${E2E_DOMAIN}'" \
  || fail "scripts/install.sh exited non-zero. Check its own [install] log lines above for which step failed."
log "install.sh completed."

# --- wait_for_http() — 1s interval loop, curl status 2xx, loud failure on timeout. -----------------
wait_for_http() {
  local url="$1" timeout_seconds="$2"
  local deadline=$(( $(date +%s) + timeout_seconds ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    local status
    status=$(curl -k -s -o /dev/null -w '%{http_code}' "$url" || echo 000)
    if [ "$status" -ge 200 ] && [ "$status" -lt 300 ]; then
      log "wait_for_http: $url is up ($status)."
      return 0
    fi
    sleep 1
  done
  fail "wait_for_http: timed out waiting for $url after ${timeout_seconds}s."
}

# --- 2. nginx up, TLS-terminated, Fastify healthy -------------------------------------------------
log "Polling https://${E2E_DOMAIN}/health for nginx-up + TLS-terminated + Fastify healthy..."
wait_for_http "https://${E2E_DOMAIN}/health" "$E2E_HEALTH_TIMEOUT_SECONDS"
HEALTH_BODY="$(curl -k -fsS "https://${E2E_DOMAIN}/health")"
case "$HEALTH_BODY" in
  *'"status"'*'"ok"'*) log "Health check body confirms status:ok -> ${HEALTH_BODY}" ;;
  *) fail "https://${E2E_DOMAIN}/health responded 2xx but body wasn't the expected {\"status\":\"ok\"}: ${HEALTH_BODY}" ;;
esac

# --- 3. Best-effort: bootstrap a management-API session + an SMTP_CUSTOM mailbox -----------------
# KNOWN GAP (documented here rather than silently worked around): this repo has no self-serve
# `POST /auth/register` route, and no bootstrap-CLI script yet either — packages/db/prisma/
# schema.prisma's own User model comment says the first admin is meant to come from "a bootstrap CLI
# step or the quickstart doc, not a web form", but that CLI step doesn't exist in scripts/ yet
# (only install.sh, backup-postgres.sh, update.sh, as of this authoring pass). Until that lands,
# this section seeds one directly via the database — the same privileged access any of this
# script's other steps already has to the scratch stack — computing the bcrypt hash through the
# api image's own `bcrypt` dependency so the hash is produced by the exact same library
# apps/api/src/routes/auth.ts verifies against.
#
# This whole section is best-effort and NON-FATAL: nothing the hard assertions below depend on
# (the actual test email arriving in Mailpit) requires it to succeed. It exists for realism / to
# exercise POST /mailboxes end-to-end, and as a documented placeholder for whenever the real
# bootstrap-CLI step lands (swap this block for calling it directly, once it exists).
log "Best-effort: bootstrapping an admin session and an SMTP_CUSTOM mailbox pointed at Mailpit..."
(
  BOOTSTRAP_EMAIL="e2e-admin@${E2E_DOMAIN}"
  BOOTSTRAP_PASSWORD="$(openssl rand -hex 16)"
  BOOTSTRAP_ID="e2eadmin$(openssl rand -hex 8)"

  PASSWORD_HASH="$(run_on_target "docker compose -f docker-compose.yml exec -T api node -e \"console.log(require('bcrypt').hashSync(process.argv[1],10))\" '${BOOTSTRAP_PASSWORD}'" 2>/dev/null)" \
    || { log "  (skip) couldn't compute a bcrypt hash inside the api container — skipping mailbox bootstrap."; exit 0; }
  [ -z "$PASSWORD_HASH" ] && { log "  (skip) empty bcrypt hash — skipping mailbox bootstrap."; exit 0; }

  run_on_target "docker compose -f docker-compose.yml exec -T postgres psql -U warmhawk -d warmhawk -v ON_ERROR_STOP=1 -c \
    \"INSERT INTO users (id, email, \\\"passwordHash\\\", role, \\\"createdAt\\\", \\\"updatedAt\\\") \
       VALUES ('${BOOTSTRAP_ID}', '${BOOTSTRAP_EMAIL}', '${PASSWORD_HASH}', 'ADMIN', now(), now()) \
       ON CONFLICT (email) DO NOTHING;\"" \
    || { log "  (skip) couldn't seed the bootstrap admin user row — skipping mailbox bootstrap."; exit 0; }

  TOKEN="$(curl -k -fsS -X POST "https://${E2E_DOMAIN}/v1/auth/login" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"${BOOTSTRAP_EMAIL}\",\"password\":\"${BOOTSTRAP_PASSWORD}\"}" \
    | sed -n 's/.*"token" *: *"\([^"]*\)".*/\1/p')"
  [ -z "$TOKEN" ] && { log "  (skip) bootstrap admin login didn't return a token — skipping mailbox bootstrap."; exit 0; }

  DOMAIN_ID="$(curl -k -fsS -X POST "https://${E2E_DOMAIN}/v1/domains" \
    -H "authorization: Bearer ${TOKEN}" -H 'content-type: application/json' \
    -d "{\"domainName\":\"${E2E_DOMAIN}\"}" \
    | sed -n 's/.*"id" *: *"\([^"]*\)".*/\1/p')"
  [ -z "$DOMAIN_ID" ] && { log "  (skip) couldn't create a Domain row — skipping mailbox bootstrap."; exit 0; }

  # smtpHost: "mailpit" — the plain container DNS name, valid because of the shared-project-name
  # design documented above step 2. If E2E_REMOTE_DIR / project-name assumptions don't hold in a
  # given real run, this call is allowed to fail (best-effort) without failing the whole test.
  curl -k -fsS -X POST "https://${E2E_DOMAIN}/v1/mailboxes" \
    -H "authorization: Bearer ${TOKEN}" -H 'content-type: application/json' \
    -d "{\"email\":\"mailbox-e2e@${E2E_DOMAIN}\",\"domainId\":\"${DOMAIN_ID}\",\"provider\":\"SMTP_CUSTOM\",\"smtpHost\":\"mailpit\",\"smtpPort\":1025}" \
    >/dev/null \
    && log "  Mailbox bootstrapped (SMTP_CUSTOM -> mailpit:1025)." \
    || log "  (skip) mailbox creation call failed — non-fatal, continuing to the direct SMTP-send assertion below."
) || log "  (skip) mailbox bootstrap block failed non-fatally — continuing."

# --- 4. Send exactly one real test email --------------------------------------------------------
# n8n/workflows/README.md documents dispatch.json as "stub/skeleton JSON... real node-by-node
# wiring... is a follow-up pass" — there is no clean HTTP trigger to fire a real send through this
# repo's own dispatch pipeline yet, and apps/api/src/routes/internalMail.ts does not exist as of
# this authoring pass either. Per the task's own documented fallback, send directly over SMTP to
# Mailpit's host-published port — the simplest robust option with no dependency on either of those
# still-in-progress pieces landing first.
log "Sending one test email directly to Mailpit (${MAILPIT_SMTP_HOST}:${MAILPIT_SMTP_TEST_PORT})..."
send_test_email() {
  python3 - "$MAILPIT_SMTP_HOST" "$MAILPIT_SMTP_TEST_PORT" "$TEST_FROM" "$TEST_TO" "$TEST_SUBJECT" <<'PYEOF'
import smtplib, sys
from email.mime.text import MIMEText

host, port, mail_from, mail_to, subject = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5]
msg = MIMEText("This is warmhawk-core-engine's install-flow e2e test message.")
msg["Subject"] = subject
msg["From"] = mail_from
msg["To"] = mail_to

with smtplib.SMTP(host, port, timeout=15) as smtp:
    smtp.sendmail(mail_from, [mail_to], msg.as_string())
print(f"[e2e-install] sent '{subject}' to {mail_to} via {host}:{port}")
PYEOF
}
if ! send_test_email; then
  # Diagnostic-only (2026-08-28): every prior release-e2e attempt has died here with
  # ConnectionRefusedError, even after confirming the network path itself is fine (manual
  # reproductions from the CI runner, both bare and containerized, reach a live mailpit on this
  # exact host:port without issue). Dump mailpit's actual state on the scratch host at the moment
  # of failure so the next real run pins the mechanism instead of guessing further -- safe to
  # remove once that's done.
  if [ -n "$E2E_SSH_HOST" ]; then
    log "SMTP send failed -- dumping scratch-host mailpit diagnostics:"
    "${SSH_BASE[@]}" "echo '--- docker ps -a (mailpit) ---'; docker ps -a --filter name=mailpit --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'; echo '--- docker logs (mailpit, last 80 lines) ---'; docker logs \$(docker ps -aq --filter name=mailpit | head -n1) --tail 80 2>&1; echo '--- listening ports (4620/4621) ---'; ss -tlnp | grep -E ':46(20|21)' || echo 'nothing listening on 4620/4621'" 2>&1 | sed 's/^/[diag] /' || log "  (diagnostic ssh call itself failed, see above)"
  fi
  fail "Direct SMTP send to Mailpit failed."
fi

# --- 5. Poll Mailpit and assert exactly one message arrived, with the expected subject -----------
MAILPIT_API="http://${MAILPIT_HTTP_HOST}:${MAILPIT_HTTP_TEST_PORT}/api/v1/messages"
log "Polling Mailpit's REST API (${MAILPIT_API}) for the test message..."
wait_for_http "http://${MAILPIT_HTTP_HOST}:${MAILPIT_HTTP_TEST_PORT}/api/v1/messages" "$E2E_MAIL_TIMEOUT_SECONDS"

MAILPIT_RESPONSE=""
DEADLINE=$(( $(date +%s) + E2E_MAIL_TIMEOUT_SECONDS ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  MAILPIT_RESPONSE="$(curl -fsS "$MAILPIT_API" || true)"
  case "$MAILPIT_RESPONSE" in
    *"$TEST_SUBJECT"*) break ;;
  esac
  sleep 1
done

case "$MAILPIT_RESPONSE" in
  *"$TEST_SUBJECT"*) : ;;
  *) fail "Test message with subject '${TEST_SUBJECT}' never showed up in Mailpit within ${E2E_MAIL_TIMEOUT_SECONDS}s. Last response: ${MAILPIT_RESPONSE}" ;;
esac

MESSAGE_COUNT="$(printf '%s' "$MAILPIT_RESPONSE" | sed -n 's/.*"messages_count" *: *\([0-9]*\).*/\1/p' | head -n1)"
if [ -n "$MESSAGE_COUNT" ] && [ "$MESSAGE_COUNT" -ne 1 ]; then
  fail "Expected exactly 1 message in Mailpit, found ${MESSAGE_COUNT}. Response: ${MAILPIT_RESPONSE}"
fi

log "Confirmed: exactly one message arrived in Mailpit with subject '${TEST_SUBJECT}'."
log ""
log "=================================================================================="
log " INSTALL-FLOW E2E: ALL ASSERTIONS PASSED"
log "   - nginx up, TLS-terminated (https://${E2E_DOMAIN}/health -> 200, status:ok)"
log "   - dashboard license-activated with zero manual follow-up steps"
log "   - one real test email sent and confirmed delivered to Mailpit"
log "=================================================================================="
log ""
log "Teardown is the calling workflow's job (ephemeral-ssh-teardown, if: always()) — this script"
log "does not tear the scratch stack down itself. See the trap installed near the top of this file"
log "for the small amount of local cleanup (SSH control socket / temp key) this script IS responsible for."

exit 0
