# n8n Workflows

Real, fully-wired node graphs (not skeletons) — every HTTP Request node targets a genuinely
existing endpoint on this repo's own API over the internal Docker network
(`http://api:4600` in production; `$env.API_INTERNAL_BASE_URL` is set to that per-package,
see `docker-compose.yml`), authenticated via the `X-Callback-Secret` header
(`requireCallbackSecret`). The AI-personalization step targets this repo's own internal
`/internal/ai/personalize` endpoint instead of an external gateway — there is no `ai-gateway-net`
equivalent anywhere in this product, per the spec. None of these workflows talk to Postgres
directly — n8n has no direct DB credential in this design, only the shared callback secret, so
every step is a real HTTP call to this API.

- **`dispatch.json`** — triggered by the worker's callback
  (`N8N_BASE_URL`/`webhook/warmhawk/dispatch`, fired from `apps/worker/src/processor.ts` with
  `{leadId, mailboxId, campaignId, email}`). Calls `POST /internal/ai/personalize`, splits the
  returned `generatedText` into a subject/body pair (Code node — WarmHawk's `Campaign` model has
  no discrete subject field), then calls `POST /internal/mail/send` (the actual SMTP/OAuth send —
  see `apps/api/src/lib/mailSender.ts`), which itself: enforces CAN-SPAM compliance, attaches RFC
  8058 one-click-unsubscribe headers, applies the EU AI Act Article 50 disclosure marker, BCCs any
  active Seed-Inbox Placement Test seed accounts, and records the Lead/`ExecutionLog` outcome
  (SENT / hard-bounced / soft-failed-with-retry) server-side. The workflow branches on the HTTP
  call's success/error output into `Respond Sent` / `Respond Failed`.
- **`reply-poll.json`** — schedule-triggered every 5 minutes. Calls the new
  `GET /internal/mailboxes/active` (mailbox listing has no dashboard-JWT equivalent n8n can use),
  loops each mailbox, calls `GET /internal/replies/pending?mailboxId=` (which CONTACTED leads sent
  via that mailbox have no `Reply` row yet, plus the provider Message-ID to thread against), then
  for each pending lead: `GET /internal/imap/search` (matches by In-Reply-To/References header,
  not subject text), and on a match, `POST /internal/imap/fetch-reply` -> `POST /internal/replies`
  -> `POST /internal/ai/classify-reply`.
- **`seed-placement-poll.json`** *(new, V12 — Seed-Inbox Placement Test)* — schedule-triggered
  every 6 hours, calls `POST /internal/seed-placement/poll`, which checks every active
  `SeedAccount`'s IMAP folder placement for every recently-sent campaign and records a
  `SeedPlacementResult` row per (campaign, seed account) pair. Aggregated results are read via
  `GET /domains/:id/placement-sample`, not by this workflow.
- **`blocklist-poll.json`** *(new, Infra pass)* — schedule-triggered every 1 hour, calls the new
  `GET /internal/domains/active` (every registered domain name), loops each one, and calls the new
  `POST /internal/domains/check-blocklist` (runs `lib/dnsChecks.ts`'s real `checkBlocklists`
  against that domain and updates `Domain.blocklistStatus`/`lastBlocklistCheckAt`). Deliberately
  scoped to blocklist status only — SPF/DKIM/DMARC only change when a customer edits their own DNS
  records, so those stay on-demand via the dashboard's `POST /v1/domains/:domain/check`; a
  scheduled poll never overwrites them with a stale/redundant result.

**Three small internal-only routes were added specifically to make these workflows real** (all
guarded by `requireCallbackSecret`, all reachable only over `warmhawk_internal`): `GET
/internal/mailboxes/active`, `GET /internal/replies/pending`, and `GET /internal/domains/active` +
`POST /internal/domains/check-blocklist`. None existed before this pass — the prior skeleton JSON
assumed generic HTTP calls without checking whether a matching endpoint actually existed; these
close that gap. (`GET /replies/pending`, `POST /replies`, and all of `imap.ts`'s routes were
originally mounted under the public `/v1` group despite being n8n-only — a later fix moved them to
`/internal/replies` and `/internal/imap` respectively, matching every other internal route's
reachable-only-over-the-Docker-network guarantee.)

**Reply correlation is by Message-ID, not subject text.** `reply-poll.json`'s lead-to-reply
correlation matches IMAP's In-Reply-To/References header against the provider Message-ID recorded
on the original send's `ExecutionLog` row (`ExecutionLog.providerMessageId`, an opaque id — storing
it doesn't reopen the privacy fix that stopped `payloadSent` from retaining subject/body text).
This replaced an earlier subject-substring heuristic that silently broke once that privacy fix
landed (the heuristic read a `payloadSent.subject` field the fix had already stopped writing).

**Hand-authored, not editor-authored — get a visual sanity-check before production use.** These
three files were written directly as JSON (n8n's format is genuinely just JSON, contrary to what
an earlier pass in this repo assumed), and validated structurally (valid JSON, every connection
resolves to a real node, no orphaned/dead-end nodes) — but they have never been opened in a live
n8n editor. Import them into a real n8n instance and eyeball the canvas once before relying on them
in production; that is an expected, ordinary step, not a sign something is wrong.
