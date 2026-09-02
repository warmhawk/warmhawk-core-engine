# Changelog

All notable changes to `warmhawk-core-engine` are documented here. The dashboard
(`warmhawk-enterprise-operator`) shows an "update available" banner by comparing its running
version against this repo's latest GitHub release tag — keep this file current on every release,
not just as a courtesy.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/), versions follow semver.

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
  configured), and an optional auth bridge (`OPERATOR_SERVICE_TOKEN`) for the separately-licensed
  `warmhawk-enterprise-operator` dashboard.
- **v1 API surface**: all routes under `/v1`, machine-only routes (n8n callbacks) isolated under
  `/internal/*` rather than the publicly-reachable group.
