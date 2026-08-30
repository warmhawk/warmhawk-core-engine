# Install-Flow E2E Test — release-gated, requires a real VM/CI runner

This directory holds five fast-tier scripts — pure local Docker logic, no scratch VM or real DNS
needed. **Four of them run in CI** as Woodpecker's `install-flow-fast` workflow (every push/PR, not
release-gated): `test-port-fallback.sh`, `test-idempotent-rerun.sh`, `test-restart-persistence.sh`,
`test-upgrade-in-place.sh`. See each script's own header comment for what it covers. Everything
below this point is about `run.sh` specifically — the one test in this directory that genuinely
can't run without real infrastructure.

> **⚠️ The fifth, `test-warmhawk-command.sh`, is NOT wired into CI — so nothing currently guards the
> `warmhawk` PATH symlink on a push.** The step list is the `installFlowTest.scriptPaths` array in
> `ks-woodpecker-config`'s `src/repo-map.ts` (the `warmhawk-core-engine` entry). Adding this one
> line there is the whole fix:
>
> ```ts
> 'tests/e2e-install/test-warmhawk-command.sh',
> ```
>
> Left unmade deliberately as of 2026-08-30: that array sits in the middle of the install-flow
> verification workstream another agent owns, and editing it risks colliding with their in-flight
> work. Until it lands, run the script by hand — unlike its siblings it stands up no stack at all
> (one short-lived `bash:5` container), so it costs a couple of seconds:
>
> ```bash
> bash tests/e2e-install/test-warmhawk-command.sh
> ```
>
> (An earlier version of this note pointed at `src/templates/self-hosted-ci.ts`. That file only
> declares the *type* for `scriptPaths`; the actual list is in `repo-map.ts`.)

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

## How this is wired (per docs/warmhawk-install-verification-plan.md in ks-woodpecker-config)

**Live as of 2026-08-26** — this used to be described here as a `.sample` GitHub Actions file,
copy-paste-and-pin-the-shas away from actually running. It's wired now, natively, as Woodpecker's
own `release-e2e` workflow (see `ks-woodpecker-config/src/templates/self-hosted-ci.ts`, configured
for this repo in that project's `src/repo-map.ts`) — release-tag-gated only, three steps in one
workflow: lock and fully wipe the shared scratch host (SaaS-Stage, a rotating single-tenant box —
see `ks-platform-infra/servers/saas-stage.md` — also used by
`warmhawk-enterprise-operator`'s own `release-e2e` pass, never at the same time), bring up a
throwaway stack on it over SSH, run `run.sh` against it, then always tear the stack down and
release the lock, Woodpecker's own equivalent of `if: always()`. Still blocked on provisioning the
`e2e_core_scratch_host`/`e2e_core_scratch_domain`/`e2e_core_scratch_ssh_key` Woodpecker secrets it
reads — see that plan doc for the current status.

## How `run.sh` is invoked from a real workflow

`bash tests/e2e-install/run.sh` runs directly on Woodpecker's own runner (not shipped to the
scratch host — it drives that host over SSH itself, via `E2E_SSH_HOST`/`E2E_SSH_KEY`/
`E2E_REMOTE_DIR`), pointed at whatever stack the workflow's own first step already brought up with
`docker-compose.yml` + `docker-compose.e2e-install.yml` (the Mailpit fixture). See
`self-hosted-ci.ts`'s `release-e2e` workflow for the exact three steps.

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
