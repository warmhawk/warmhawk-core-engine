# Install-Flow E2E Test — release-gated, runs in an automated Docker sandbox

This directory holds five fast-tier scripts — pure local Docker logic, no scratch VM or real DNS
needed. **All five run in CI** as an `install-flow-fast` workflow (every push/PR, not
release-gated): `test-port-fallback.sh`, `test-idempotent-rerun.sh`, `test-restart-persistence.sh`,
`test-upgrade-in-place.sh`, `test-warmhawk-command.sh`. A permanent `verify-scripts-wired` guard
step runs first in that workflow to catch a script ever going un-wired again — it globs
`tests/e2e-install/test-*.sh` on disk and fails loudly on any mismatch with the wired-in list. See
each script's own header comment for what it covers. Everything below this point is about `run.sh`
specifically — the one test in this directory that exercises a real install end to end.

Per the Testing Strategy, this is the "actual customer path" test: run `install.sh --domain
<test-domain>`, confirm nginx comes up TLS-terminated, and send one real test email through to a
Mailpit/MailHog catcher.

**Implemented** as `run.sh` (this directory) — it is a complete, working script, not a stub. It's
release-gated (run before go-live and before any release touching `install.sh`/the containerization
model), not merge-gated, and it's dual-mode:

- **Automated, in CI:** the `release-e2e` workflow drives it entirely inside a
  privileged `docker:26-dind` sandbox in CI, against Pebble (Let's Encrypt's own ACME
  *test* server) rather than the real Let's Encrypt endpoint — no scratch VM, no real public DNS,
  no host port ever published. See "How this is wired" below.
- **Manual, pre-go-live only:** run by hand against a genuinely disposable throwaway VM with real
  public DNS (and, optionally, Let's Encrypt's real staging endpoint) — see "Manual pre-go-live
  checklist" below. This is the only path that exercises the real Let's Encrypt HTTP-01 challenge
  and real DNS resolution end to end.

The only verification possible without either of the above is `bash -n run.sh` (syntax) and
validating `docker-compose.e2e-install.yml` with `docker compose config`.

## How this is wired

**Rebuilt 2026-08-30** — this used to run on a shared, wiped scratch VM reached over SSH, guarded
by a cross-repo box lock, described in a now-deleted workflow sample file. That whole mechanism is
gone: no scratch VM, no box lock, no wipe, no teardown of shared infrastructure, nothing ever
shipped over SSH.

The `release-e2e` workflow now runs entirely inside a `docker:26-dind` sibling service
(`privileged: true`) in CI — release-tag-gated only. Steps, in order:

1. **`wait-for-docker`** — poll the DinD sibling until its daemon is ready.
2. **`bring-up-pebble`** — create a docker network, then bring up
   [Pebble](https://github.com/letsencrypt/pebble) (Let's Encrypt's own ACME *test* server) as a
   throwaway container inside the sandbox. Pebble's image is distroless/shell-less, so its config
   is injected via `docker create` → `docker cp` → `docker start`, never a bind mount; the step
   polls it ready before moving on.
3. **`install-pass-1`** — the real `scripts/install.sh --domain <e2eDomain> --acme-server
   https://pebble:14000/dir --acme-ca-bundle <pebble.minica.pem>` (plus this repo's Mailpit
   sidecar bring-up first — the same `docker-compose.e2e-install.yml` overlay as before). Certbot
   fails on this first pass because nginx has no network alias yet, so `install.sh` degrades to
   HTTP-only *by design* — that's expected, not a bug.
4. **`wire-network-alias`** — connects nginx onto the sandbox's own docker network with a network
   alias equal to the e2e domain, and connects certbot onto that same network, so Pebble's HTTP-01
   challenge resolves the domain over real Docker-network DNS.
5. **`install-pass-2`** — `bash scripts/install.sh --retry-tls`, which only redoes certbot.
   Succeeds for real now that the alias is wired.
6. **`run-install-flow-e2e`** — runs this repo's own `run.sh` with `E2E_SKIP_INSTALL=true`, so it
   skips straight to its own post-install assertions against the stack the workflow just brought
   up, plus an `/etc/hosts` trick so `run.sh`'s own shell can resolve the e2e domain too.

Nothing this sandbox does ever binds a host port or opens anything public. No public DNS record
exists for the e2e domain (e.g. `e2e-core.warmhawk.test`) — it only ever resolves as a Docker
network alias inside this one ephemeral sandbox.

## How `run.sh` is invoked from the automated `release-e2e` workflow

`bash tests/e2e-install/run.sh` runs as that workflow's own `run-install-flow-e2e` step, with
`E2E_SKIP_INSTALL=true` — it never runs `install.sh` itself in this mode (the workflow's own
`install-pass-1`/`install-pass-2` steps above already did, twice), and it never drives anything
over SSH. `MAILPIT_HTTP_HOST`/`MAILPIT_SMTP_HOST` point at the DinD sibling's own service name. The
two-Docker-engine/two-install-pass design (why TLS needs two passes, and how a step's own raw
`curl` calls reach the inner daemon differently than `docker` CLI calls do) is described above in
"How this is wired".

## Manual pre-go-live checklist

The automated `release-e2e` workflow above proves the install flow works — but against Pebble, a
*test* CA, never the real Let's Encrypt service or real public DNS. Before go-live, and before any
release that touches `install.sh`/the containerization model, also run this by hand:

- [ ] Stand up a genuinely disposable throwaway VM with a real DNS A record pointed at it.
- [ ] Run `tests/e2e-install/run.sh` against it directly, with `E2E_SSH_HOST` pointed at that VM
      and `E2E_LETSENCRYPT_STAGING=true` (Let's Encrypt's real **staging** endpoint, to avoid
      tripping the production rate limit) — exactly as `run.sh` already supports, no code changes
      needed.
- [ ] Confirm the run's real certbot issuance, real DNS resolution, and the real test email all
      pass, then destroy the VM.

## What `run.sh` actually does

(This describes the manual/real-VM invocation, where `run.sh` drives `install.sh` itself. In the
automated `release-e2e` workflow, `E2E_SKIP_INSTALL=true` skips step 1 below — the workflow's own
`install-pass-1`/`install-pass-2` already did it — and `run.sh` starts at step 2.)

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
