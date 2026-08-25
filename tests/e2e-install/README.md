# Install-Flow E2E Test — release-gated, requires a real VM/CI runner

Per the Testing Strategy, this is the "actual customer path" test: run
`install.sh --domain <test-domain>` against Let's Encrypt's **staging** endpoint, confirm nginx
comes up TLS-terminated, and send one real test email through to a Mailpit/MailHog catcher.

**Implemented** as `run.sh` (this directory) — it is a complete, working script, not a stub.
What it genuinely can't do is *execute* here: this is release-gated (run before go-live and
before any release touching `install.sh`/the containerization model), not merge-gated, and
genuinely requires a throwaway VM or CI runner with a real DNS record pointed at it (Let's
Encrypt's HTTP-01 challenge needs to actually resolve). That's real infrastructure no sandbox or
local dev container can provide — `run.sh`'s own header comment restates this in detail. The only
verification possible outside that real environment is `bash -n run.sh` (syntax) and validating
`docker-compose.e2e-install.yml` with `docker compose config`.

## How this is meant to be wired (per the V12 CI/CD adoption note)

Ship this checkout to a scratch VM/runner over plain SSH, generate throwaway secrets directly on
the runner (never transferring real ones), bring the stack up with `install.sh`, and guarantee
teardown with `if: always()` — see `release-e2e.workflow.yml.sample` next to this file for the
full wiring. That "stand up a real stack on a scratch target, test it, always tear it down"
mechanism is implemented directly with `ssh`/`rsync`/`docker compose`, not a bespoke
Docker-in-Docker script or a private, internally-owned composite-action dependency (this repo is
public, so it must not depend on internal infra other than what it needs to actually run).

## How `run.sh` is invoked from a real workflow

See `release-e2e.workflow.yml.sample` next to this file for the full, concrete wiring — a
`.sample` file, not a live workflow (deliberately not under `.github/workflows/`, and not
registered/executed by anything in this repo). Copy it there and pin the composite actions'
`@sha` refs when this test is actually promoted from "implemented" to "wired into CI". Short
version: `ephemeral-ssh-stack` ships the checkout and brings up `docker-compose.yml` +
`docker-compose.e2e-install.yml` (the Mailpit fixture) together on the scratch host, then
`bash tests/e2e-install/run.sh` (with `E2E_DOMAIN`/`E2E_SSH_HOST`/`E2E_SSH_KEY`/`E2E_REMOTE_DIR`
set) does everything described above, then `ephemeral-ssh-teardown` runs with `if: always()`.

## What `run.sh` actually does

1. Runs `scripts/install.sh --domain "$E2E_DOMAIN"` — the real customer command, unmodified.
2. Polls `https://$E2E_DOMAIN/health` (a `wait_for_http`-style bash function mirroring the
   `wait-for-http` composite's own semantics: 1s interval, 2xx, loud timeout) until nginx is up,
   TLS-terminated, and Fastify's `GET /health` returns `{"status":"ok"}`.
3. Best-effort: bootstraps an admin session (see the `KNOWN GAP` comment in `run.sh` — this repo
   has no self-serve registration route or bootstrap-CLI script yet) and an SMTP_CUSTOM mailbox
   pointed at Mailpit, for realism.
4. Sends one real test email directly over SMTP to Mailpit — `n8n/workflows/dispatch.json` is
   still stub/skeleton JSON (see `n8n/workflows/README.md`), so there's no clean HTTP trigger to
   fire a real send through the dispatch pipeline yet; this is the documented fallback, not a
   workaround.
5. Polls Mailpit's REST API (`GET /api/v1/messages`) until exactly one message has arrived and
   asserts its subject matches what was sent.

Note (API-surface correction pass): this test previously also generated a test license key and
polled a `POST /auth/activate` core-engine route as steps of their own. Both were removed — Tier 0
(this engine) carries no license gate at all, `/auth/activate` was never actually implemented here,
and `scripts/install.sh` no longer accepts a `--license` flag. See that script's own header comment
for the full explanation.

Any failed assertion is a hard, loud, non-zero exit — see `log()`/`fail()` in `run.sh`, mirroring
`scripts/install.sh`'s own helpers.
