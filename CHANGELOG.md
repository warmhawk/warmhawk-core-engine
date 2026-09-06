# Changelog

All notable changes to `warmhawk-core-engine` are documented here. The licensed dashboard product
shows an "update available" banner by comparing its running version against this repo's latest
GitHub release tag — keep this file current on every release, not just as a courtesy.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/), versions follow semver.

## [Unreleased]

### Removed

- **`GET /v1/public/domain-check`** — deleted, along with its rate-limit constant. It was
  WarmHawk's own free marketing tool, and shipping it here put an unauthenticated,
  recursive-DNS endpoint on every self-hosted install: a stranger abusing your server got **your**
  IP throttled by Spamhaus, silently degrading the domain monitoring you run this engine for. It
  now runs as a service WarmHawk operates. **No action needed** — the route required no auth and
  stored nothing, so nothing of yours depended on it.
- **Barracuda, SORBS and Spamhaus ZEN blocklist sources.** `dnsbl.sorbs.net` has been retired and
  answered NXDOMAIN for every query, which the code read as *not listed* — a permanently green
  badge that had never checked anything. The other two are IP-based zones that were being queried
  against the domain's **A record**, i.e. its website (usually a CDN or shared host), not the
  address its mail leaves from. Blocklist monitoring is now **Spamhaus DBL, domain-level**.

### Fixed

- **Blocklist checks reported every domain as listed when queried through a shared resolver.**
  DNSBL zones answer `127.255.255.252/254/255` to mean *"this query was refused"* — malformed,
  sent via a public resolver, or rate-limited. Those were read as listings. On any host whose
  resolver Spamhaus refuses (most shared and cloud resolvers, including several large providers'),
  **every domain you monitored was flagged blocklisted**. They now report `PENDING`.
- **A domain with no A record was reported as clean** by three of the four blocklist sources
  rather than unchecked. Removed with the A-record path.
- **A single DNS timeout failed an entire domain refresh.** Blocklist sources are now settled
  independently; one unreachable zone reports `PENDING` for itself alone.
- **DKIM reported `FAIL` when none of the nine guessed selectors resolved.** Selectors cannot be
  enumerated from DNS, so a miss means *we did not find one*, not *this domain has no DKIM*; it
  now reports `PENDING`. An explicit selector you supply still `FAIL`s when it does not resolve.
  The nine candidates are also queried in parallel rather than serially — previously up to nine
  sequential round trips per domain.
- **SPF and DMARC reported `FAIL` on resolver errors.** A SERVFAIL or timeout is not a missing
  record; both now report `PENDING`.

> **Note on `PENDING`.** It is not a new value — `DnsRecordStatus` already defined it and it is
> already the column default, so **no migration is required**. It simply had no way of being
> returned. Badges that previously showed a confident PASS or FAIL may now show *pending* where
> the check genuinely could not complete.

## [1.0.0] - 2026-09-01 — Initial public release

### Added

- **Self-hosted install**: `scripts/install.sh` — idempotent, preflight-checked, bundles its own
  nginx + certbot (TLS degrades to HTTP-only rather than crashing on issuance failure), falls back
  to alt ports instead of failing when 80/443 are already taken on the host. `scripts/update.sh`
  and `scripts/backup-postgres.sh`/`restore-postgres.sh` round out day-2 operations — see
  `docs/quickstart.md`, `docs/backup-and-restore.md`, `docs/troubleshooting.md`.
- **Core sending engine**: campaigns, lead import (CSV and webhook, injection-defended), weighted
  mailbox rotation with cadence/jitter, BullMQ-based dispatch worker, and a crash-recovery
  reconciliation cron backed by Redis AOF durability.
- **Guardrails, enforced structurally**: CAN-SPAM auto-injection, RFC 8058 List-Unsubscribe
  headers, EU AI Act Article 50 disclosure marker, bounce/complaint circuit breaker (mailbox- and
  campaign-level), spam-score/spintax validation, login brute-force throttle, and GDPR erase
  (`DELETE /v1/leads/erase` — PII nulled, aggregates preserved).
- **Deliverability monitoring**: continuous SPF/DKIM/DMARC and DNSBL blocklist checks (Spamhaus
  ZEN/DBL, Barracuda, SORBS), plus a Seed-Inbox Placement Test (placement sampling across seed
  inboxes, not full inbox-placement testing).
- **Mailbox auth**: SMTP/IMAP username+password as the universal fallback for any provider, plus
  Google Workspace OAuth. Microsoft 365 OAuth is built and unit-tested, pending Microsoft's Entra
  app verification.
- **Reply handling**: IMAP polling, AI-assisted reply classification, and automatic
  opt-out-to-suppression wiring.
- **AI personalization (BYOK)**: bring your own Gemini or Claude API key; personalization retries
  once on failure, then falls back to the raw template rather than blocking the send.
- **Free public tool**: `GET /public/domain-check` — SPF/DKIM/DMARC lookup, no auth required.
- **Operations**: internal-only Docker network (only nginx/certbot ports are published),
  auto-provisioned Uptime Kuma monitoring, OTEL instrumentation (inert until an OTLP endpoint is
  configured), and an optional auth bridge (`OPERATOR_SERVICE_TOKEN`) for the separate, private
  licensed dashboard product.
- **v1 API surface**: all routes under `/v1`, machine-only routes (n8n callbacks) isolated under
  `/internal/*` rather than the publicly-reachable group.
