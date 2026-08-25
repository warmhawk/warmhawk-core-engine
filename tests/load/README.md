# BullMQ Dispatcher Load Test — release-gated, not merge-gated

Per the Testing Strategy, this k6 script formalizes "load-test the BullMQ dispatcher at realistic
multi-hundred-mailbox volume" as a repeatable, versioned artifact instead of a one-off manual
drill — but it is **release-gated** (run before go-live and before any release touching the
dispatcher/queue code), not run on every PR, since it's too slow for normal merge velocity.

## What's here

`dispatch-load-test.js` is a real, runnable k6 script — it will actually run against a live
instance — with two scenarios covering the two traffic shapes a live multi-hundred-mailbox
deployment actually produces:

| Scenario | Endpoint | Shape | Represents |
|---|---|---|---|
| `webhook_ingest_sustained` | `POST /webhooks/leads` | write-heavy | lead ingest at multi-hundred-mailbox volume |
| `queue_overview_polling` | `GET /queue/overview` | read-heavy | ops/dashboard polling of the live queue inspector |

Its **thresholds are intentionally left as loud `TODO` placeholders**, not a real number, per the
V12 calibration rule:

> "Thresholds must reflect a real measured baseline on representative hardware, not an
> aspirational number picked in advance — jitterflow's own load-test thresholds (`p95<10000ms`)
> are honest about current reality rather than hopeful."

This repo has never been run against real hardware at multi-hundred-mailbox volume, so there is
no honest baseline to encode yet. **Do not copy jitterflow's `p95<10000ms` number verbatim** —
run this script against WarmHawk's own representative hardware first, record the real p95/p99,
and set the threshold to that measured number (with a small safety margin), before this becomes a
release gate. The script's `options.thresholds` currently sets both scenarios' `http_req_duration`
thresholds to a deliberately absurd `p(95)<999999` (real, syntactically valid k6 threshold syntax
— it will never actually fail — not the old literal `'p(95)<TODO_MS'` string, which isn't valid
k6 syntax at all and would have thrown before the test ever ran). `http_req_failed: ['rate<0.01']`
is the one threshold that is **not** a placeholder — "under 1% hard failures" is a reasonable
floor regardless of hardware, not a performance guess, so it doesn't need the calibration caveat
above.

## Load-shape sizing: the arithmetic behind the numbers

Neither scenario picks a VU count or a request rate out of thin air — both are derived from a
number this repo already has:

**`webhook_ingest_sustained`** (write-heavy) uses the dispatcher's own 8-minute cadence floor
(`apps/worker/src/computeNextSlotSeconds.ts`'s `CADENCE_FLOOR_MS`) as a proxy for a sustained
ingest rate, on the assumption that in steady state, new leads arrive roughly as often as mailboxes
become eligible to send again:

```
N_MAILBOXES (assumed)     = 400   (midpoint of the 300-500 mailbox range this product targets)
CADENCE_FLOOR_SECONDS     = 480   (8 minutes, ported verbatim from computeNextSlotSeconds.ts)
sustained rate            = 400 / 480 ≈ 0.83 req/s
```

That's rounded up to an integer (`1 req/s`) since k6's `ramping-arrival-rate` executor requires an
integer `target`. A `BURST_MULTIPLIER` of `3` (not a measured number — an assumption that real
traffic clusters, e.g. several campaigns launching at once) scales that to a `3 req/s` burst stage,
so the scenario exercises both the calm average and a plausible spike, not only one flat rate.

The script's own comments also flag a real consequence of this arithmetic worth knowing before a
real run: `RATE_LIMIT_WEBHOOK_INGEST` (`constants.ts`) caps this route at `30 req/60s = 0.5 req/s`
per source IP, which the ~0.83 req/s sustained figure above already exceeds if every request comes
from one load-generator IP — expect a meaningful share of `429`s even at "steady state," not just
during the burst stage. The script's checks already treat `429` as an accepted, expected outcome.

**`queue_overview_polling`** (read-heavy) is sized off dashboard usage, not mailbox count — an
assumed ~5 concurrent operator/dashboard sessions each polling every ~5s ⇒ `5 / 5 ≈ 1 req/s`, run
as a `constant-arrival-rate` scenario for the whole ~4m20s the ingest scenario runs.

Both executors are `*-arrival-rate`, not `ramping-vus`: the numbers above are request rates, and
`ramping-vus`' target is a concurrent-VU count whose resulting req/s depends on per-request
latency this repo has never measured — arrival-rate executors let k6 auto-scale VUs to hit the
req/s the arithmetic above actually calls for, which is the only honest thing to commit to before
a real latency baseline exists.

## Auth: `JWT_TOKEN` for the queue-inspector scenario

`GET /queue/overview` is gated by `requireAuth` (`apps/api/src/lib/requireAuth.ts`) — a `Bearer`
JWT, same shape as what `POST /auth/login` (`apps/api/src/routes/auth.ts`) returns. Supply a real
token minted against a real test instance via `--env JWT_TOKEN=<token>`; the script never mints or
fetches one itself (no live auth call from inside k6). Without it, every request in that scenario
gets a `401`, which the script logs a `setup()`-time warning about and treats as an expected,
non-failing outcome only in that no-token case.

## Running it (once a target instance exists)

```bash
k6 run --env API_BASE_URL=https://staging.yourcompany.com \
  --env CAMPAIGN_ID=<a real test campaign id> \
  --env JWT_TOKEN=<a real bearer token from POST /auth/login> \
  tests/load/dispatch-load-test.js
```

## Why it isn't wired into CI yet

Wiring this into `.github/workflows/ci.yml` as a release-gate job is a follow-up step that
depends on (a) a real staging/scratch instance to point it at, and (b) the threshold-calibration
pass above having actually happened. Both are pre-go-live checklist items, not part of this
foundation build.
