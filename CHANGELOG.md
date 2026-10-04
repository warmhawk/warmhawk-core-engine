# Changelog

All notable changes to `warmhawk-core-engine` are documented here. The licensed dashboard product
shows an "update available" banner by comparing its running version against this repo's latest
GitHub release tag — keep this file current on every release, not just as a courtesy.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/), versions follow semver.

## [Unreleased]

## [1.9.1] - 2026-10-04

### Fixed

- **Deleting a mailbox left its leads' follow-ups stuck.** Follow-ups only ever go from the mailbox
  that sent a lead's first email, so once that mailbox is deleted the rest of the sequence can never
  send — but the lead kept its next follow-up date and was counted under *follow-ups due* forever.
  Deleting a mailbox now ends those sequences, and leads with no mailbox left are no longer counted
  as due.
- **`install.sh` and `warmhawk update` could skip every n8n workflow import on a busy host.** n8n's
  CLI can still fail for a few seconds after its health check answers, and one failed workflow
  list skipped the whole import, leaving sending unprovisioned. The list is now tried up to five
  times first.

## [1.9.0] - 2026-10-03

### Added

- **A mailing address per domain.** The CAN-SPAM footer address now belongs to the domain a mailbox
  sends from (`mailingAddress`, or `mailingAddressParts` with street, city and country), so each
  client brand prints its own. Adding a domain never needs one; launching a campaign that sends
  from it does.
- **Each campaign picks the mailboxes it sends from** (`mailboxIds`). First emails rotate across
  only those, so one client's campaign never goes out from another client's mailbox. New
  mailboxes are never added to a campaign on their own.
- **Follow-up sequences.** Up to three follow-ups per campaign (`steps`), each waiting 1–30 days,
  sent from the same mailbox as the first email as a reply in the same thread. A reply, bounce,
  unsubscribe or suppression ends the sequence. Due follow-ups go before new first emails in a
  mailbox's daily cap.
- **`GET /v1/campaigns/:id/launch-check`** returns the same problems and warnings a launch would,
  without launching.
- **The sender name is filled from Google or Microsoft** when a mailbox connects.

### Changed

- **`POST /v1/campaigns/:id/launch` returns every problem at once** (`problems[]`, `warnings[]`)
  and refuses a campaign with no senders or a sending domain with no address.
- **DKIM checks find Cloudflare and other providers' keys**, Spamhaus DBL is queried on its own
  nameservers, and every domain is re-checked hourly.

### Upgrade notes

- **`PATCH /v1/campaigns/:id` refuses `status` and unknown fields** with 422. Use `/launch` and
  `/pause`.
- **`PUT /v1/instance-settings` returns 410.** The install-wide mailing address is no longer read;
  add an address to each sending domain before launching.
- **Clearing a domain's address that campaigns use** returns 409 `ADDRESS_IN_USE` unless the
  request sends `confirm: true`.

## [1.8.0] - 2026-10-02

### Added

- **A built-in unsubscribe page** for campaigns with no unsubscribe link of their own.

### Fixed

- **Gmail Promotions-tab copies** are recorded as `PROMOTIONS` in seed placement.
- **Dependencies:** fastify 5.12.5, `@grpc/grpc-js` pinned to 1.14.5.

## [1.7.1] - 2026-09-30

### Fixed

- **Warm-up "today" counts from the start of the warm-up day**, not the UTC day.

## [1.7.0] - 2026-09-28

### Added

- **Checked warm-up emails are filed under a WarmHawk warm-up folder.**

## [1.6.0] - 2026-09-28

### Added

- **Bounced warm-up emails are recorded with the reason.**

## [1.5.1] - 2026-09-28

### Fixed

- **WarmHawk Connect names Microsoft failures** and flags mailboxes that lose access.

## [1.5.0] - 2026-09-27

### Added

- **WarmHawk Connect:** one-click Google and Microsoft mailbox connect.

## [1.4.3] - 2026-09-27

### Fixed

- **`warmhawk update` says when the checked-out `update.sh` takes over.**

## [1.4.2] - 2026-09-27

### Fixed

- **`warmhawk update` hands over to the checked-out `update.sh`**, so script fixes apply on the
  same update.

## [1.4.1] - 2026-09-27

### Fixed

- **`warmhawk update` re-imports bundled n8n workflows that changed.**

## [1.4.0] - 2026-09-27

### Added

- **Template-aware AI compose and a CAN-SPAM footer on every send.**

### Fixed

- **nginx proxies `/v1/warmup`**, so the Warmup page loads.

## [1.3.0] - 2026-09-27

### Added

- **Warm-up engine** with placement checks, test inboxes and paged lists.

## [1.2.5] - 2026-09-26

### Fixed

- **Microsoft 365 connect works for single-tenant apps.**

## [1.2.4] - 2026-09-26

### Fixed

- **`warmhawk update` trusts the install directory** when another user owns it.

## [1.2.3] - 2026-09-26

### Fixed

- **`backup-postgres.sh`** now finds the Postgres container.
- **An unconfigured Google or Microsoft OAuth connect** no longer crashes.
- **HTTPS installs behind a proxy**, `warmhawk update` and `DASHBOARD_APP_URL`.

## [1.2.2] - 2026-09-09

### Fixed

- **n8n workflow names are read without a Node dependency on the host.**

## [1.2.1] - 2026-09-09

### Fixed

- **All bundled n8n workflows are activated** on install and update, not just 2 of 5.

## [1.2.0] - 2026-09-09

### Added

- **Domain check history**, recording what changed between DNS checks.
- **Lookalike and typosquat domain monitoring** (Tier 2).
- **An alert webhook on domain DNS-check changes** (Tier 2).

### Fixed

- **The API service has internet egress**, and RDAP fetches time out.

## [1.1.0] - 2026-09-07

### Added

- **`DELETE /v1/domains/:id`**, refusing while mailboxes are still attached.

## [1.0.4] - 2026-09-06

### Fixed

- **Uptime Kuma monitors container names**, not bare service names.
- **`warmhawk update` could report success without having updated anything.** It fetched the new
  commits and then ran `git checkout <branch>` — which does nothing when you are already on that
  branch — so the fetched version sat unused while the script rebuilt, re-migrated and printed
  *"Update complete"* against the version you already had. A failed fetch or checkout was likewise
  only a warning, so an offline server also reported success. Both now stop with an error that says
  the install was left untouched, and the log names the versions: `Updating 007e861 -> af87f07`.
- **`warmhawk update` defaulted to the development branch.** With no argument it tracked `main`,
  the unreleased trunk. It now defaults to `master`, the released branch. Pass a tag
  (`./scripts/update.sh v1.0.3`) to pin to an exact version.

## [1.0.3] - 2026-09-06

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
