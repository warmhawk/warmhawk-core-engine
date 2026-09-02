// WarmHawk — BullMQ dispatcher load test (k6). See tests/load/README.md before running this for
// real — thresholds below are deliberately TODO placeholders, not a real number, per the V12
// calibration rule (this project has no real measured baseline yet; measure WarmHawk's own).
//
// Two scenarios run concurrently, approximating the two traffic shapes a live multi-hundred-
// mailbox deployment actually produces:
//   1. webhook_ingest_sustained — write-heavy: POST /v1/leads/webhook (lead ingest).
//   2. queue_overview_polling   — read-heavy:  GET /v1/queue/status (ops/dashboard polling),
//      requires a real bearer JWT minted against a real test instance (JWT_TOKEN env var).
//
// Style note: this repo's own tests/load/README.md says CI wiring is a later step, so this script
// is fully standalone — no shared k6 helper library to import (this repo is public, so it must
// not depend on any private, internally-owned helper lib anyway). The baseThresholds()/
// mergeThresholds()/standardHandleSummary() helpers below are hand-rolled here for that reason.
import http from 'k6/http';
import { check } from 'k6';

// ---------------------------------------------------------------------------------------------
// Load-shape sizing arithmetic (traffic-pattern 1: write-heavy lead ingest)
// ---------------------------------------------------------------------------------------------
// "Multi-hundred-mailbox volume" per the task brief means the mailbox pool this dispatcher must
// keep saturated, not the ingest webhook's own natural arrival rate (a CRM/lead-source push can
// burst independently of send cadence) — but lacking any other real-world ingest-rate data, the
// send cadence floor is the only concrete number this repo has, so it's used here as the best
// available proxy for a sustained baseline load, with an explicit burst multiplier layered on top
// to approximate the un-evenness real traffic has that a perfectly smooth rate wouldn't:
//
//   N_MAILBOXES              = 400   (assumed representative midpoint of the 300-500 mailbox
//                                      range this product is sized for; see apps/worker's
//                                      enqueuer.ts weighted-rotation design)
//   CADENCE_FLOOR_SECONDS     = 480   (8 minutes; apps/worker/src/computeNextSlotSeconds.ts's
//                                      CADENCE_FLOOR_MS, verbatim)
//   sustained ingest rate     = N_MAILBOXES / CADENCE_FLOOR_SECONDS
//                             = 400 / 480 ≈ 0.83 req/s
//
// That's the steady-state assumption: if the lead pipeline keeps pace with sends, one new lead
// event arrives roughly as often as one mailbox becomes eligible to send again. Real traffic
// isn't that smooth — multiple campaigns can launch at once, a CRM can flush a backlog, etc. — so
// this script also ramps to a BURST_MULTIPLIER-scaled peak to exercise that case, rather than
// only ever testing the calm average.
//
// Worth flagging even though it's out of scope to fix here: RATE_LIMIT_WEBHOOK_INGEST in this
// repo's constants.ts caps this route at 30 req/60s = 0.5 req/s per source IP (see
// apps/api/src/routes/webhookLeads.ts). The sustained rate computed above (~0.83 req/s) already
// exceeds that limit if every request comes from one load-generator IP, so expect a real, non-
// trivial share of 429s at "steady state" volume, not just during the burst stage — which is
// exactly why the checks below treat 429 as an accepted, expected outcome rather than a failure.
const N_MAILBOXES = 400;
const CADENCE_FLOOR_SECONDS = 480;
const INGEST_SUSTAINED_RPS = N_MAILBOXES / CADENCE_FLOOR_SECONDS; // ≈ 0.83 req/s (exact math, kept for the comment above)
const BURST_MULTIPLIER = 3; // simultaneous campaign launches / backlog catch-up, not a measured number
const INGEST_BURST_RPS = INGEST_SUSTAINED_RPS * BURST_MULTIPLIER; // ≈ 2.5 req/s (exact math)

// k6's ramping-arrival-rate `stages[].target` is an integer request-rate (verified against a real
// k6 v2.2.0 binary: a fractional target fails at script-load time with "cannot unmarshal number
// ... into ... type int64"), so the exact req/s figures computed above are rounded up to the
// nearest whole request/sec here — ceil, not round, so the executor's actual target rate is never
// below what the arithmetic called for.
const INGEST_SUSTAINED_RPS_TARGET = Math.max(1, Math.ceil(INGEST_SUSTAINED_RPS)); // 1 req/s
const INGEST_BURST_RPS_TARGET = Math.max(1, Math.ceil(INGEST_BURST_RPS)); // 3 req/s

// ---------------------------------------------------------------------------------------------
// Load-shape sizing (traffic-pattern 2: read-heavy queue-inspector polling)
// ---------------------------------------------------------------------------------------------
// This models dashboard/ops polling, not mailbox volume — sizing it off the mailbox count would
// misrepresent what actually drives this endpoint's load (people watching a dashboard, not
// mailboxes). Assumption: up to ~5 concurrent operator sessions (dashboard tabs / team members)
// each polling GET /v1/queue/status roughly every 5s ⇒ 5 sessions / 5s ≈ 1 req/s.
const DASHBOARD_POLL_RPS = 1;

// Executor choice: ramping-arrival-rate (not ramping-vus) for the ingest scenario, because the
// number above the task actually wants sized is a REQUEST RATE (req/s derived from a cadence
// floor), not a VU count — ramping-vus' target is concurrent virtual users, whose resulting req/s
// depends on each request's latency, which this repo has never measured. ramping-arrival-rate
// (and constant-arrival-rate for the polling scenario) lets k6 auto-scale VUs under the hood to
// hit the req/s figures the arithmetic above actually produced, which is the honest thing this
// script can commit to before a real latency baseline exists.
const TOTAL_TEST_DURATION = '4m20s'; // 30s + 2m + 30s + 1m + 20s, matches the ingest stages below

export const options = {
  scenarios: {
    webhook_ingest_sustained: {
      executor: 'ramping-arrival-rate',
      exec: 'ingestLead',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 10,
      maxVUs: 50,
      stages: [
        { duration: '30s', target: INGEST_SUSTAINED_RPS_TARGET }, // ramp to steady state
        { duration: '2m', target: INGEST_SUSTAINED_RPS_TARGET }, // hold steady state
        { duration: '30s', target: INGEST_BURST_RPS_TARGET }, // ramp to burst (concurrent campaign launches)
        { duration: '1m', target: INGEST_BURST_RPS_TARGET }, // hold burst
        { duration: '20s', target: 0 }, // ramp down
      ],
    },
    queue_overview_polling: {
      executor: 'constant-arrival-rate',
      exec: 'pollQueueOverview',
      rate: DASHBOARD_POLL_RPS,
      timeUnit: '1s',
      duration: TOTAL_TEST_DURATION,
      preAllocatedVUs: 5,
      maxVUs: 20,
    },
  },
  thresholds: {
    // TODO(pre-launch): replace with a real measured p95 baseline before this gates a release.
    // 999999 is a deliberately absurd, obviously-fake-but-syntactically-valid number (it would
    // never actually fail) — a placeholder to keep, not the old literal 'p(95)<TODO_MS' string,
    // which isn't valid k6 threshold syntax and would throw before the test even ran. Scoped per
    // scenario since the write-heavy ingest path and the read-heavy queue-overview path have no
    // reason to share one real latency target once a real number replaces this.
    'http_req_duration{scenario:webhook_ingest_sustained}': ['p(95)<999999'],
    // TODO(pre-launch): replace with a real measured p95 baseline before this gates a release.
    'http_req_duration{scenario:queue_overview_polling}': ['p(95)<999999'],
    // NOT a placeholder — "less than 1% hard failures" is a reasonable non-aspirational default
    // regardless of hardware (it's a floor on outright breakage, not a performance guess), so
    // this one doesn't get the TODO treatment. Kept from the original skeleton unchanged.
    http_req_failed: ['rate<0.01'],
  },
};

const API_BASE_URL = __ENV.API_BASE_URL || 'http://localhost:4600';
const CAMPAIGN_ID = __ENV.CAMPAIGN_ID || 'TODO_SET_A_REAL_TEST_CAMPAIGN_ID';
const JWT_TOKEN = __ENV.JWT_TOKEN || '';

// Per-VU random token (module init code runs once per VU in k6), so emails stay unique both
// within a single run (combined with __VU/__ITER) and across repeated runs against the same
// long-lived DB (Math.random() differs run to run — __VU/__ITER alone reset to the same values
// every run and would collide with a prior run's rows under the campaignId+email unique
// constraint, understating real load by falling into the duplicate-skip path instead of the real
// insert path).
//
// Domain note: the previous skeleton used `@example.com`, which is on this repo's own
// BLOCKED_EMAIL_DOMAINS list (apps/api/src/lib/leadIngest.ts) — every single request it sent
// would have been rejected with 422 "blocked_domain" before ever reaching the suppression/
// duplicate/create logic this test is supposed to exercise. Using a non-blocked domain here fixes
// that silently-broken-load-test bug.
const VU_RANDOM_SUFFIX = Math.random().toString(36).slice(2, 8);

export function setup() {
  if (CAMPAIGN_ID === 'TODO_SET_A_REAL_TEST_CAMPAIGN_ID') {
    console.warn(
      'CAMPAIGN_ID not set — pass --env CAMPAIGN_ID=<a real test campaign id> for a meaningful run.',
    );
  }
  if (!JWT_TOKEN) {
    console.warn(
      'JWT_TOKEN not set — the queue_overview_polling scenario will get 401s on every request. ' +
        'Pass --env JWT_TOKEN=<a real token minted against a real test instance>.',
    );
  }
}

// Traffic pattern 1 (write-heavy): POST /v1/leads/webhook.
export function ingestLead() {
  const email = `load-test-${VU_RANDOM_SUFFIX}-${__VU}-${__ITER}@loadtest.k6.local`;
  const res = http.post(
    `${API_BASE_URL}/v1/leads/webhook`,
    JSON.stringify({
      campaignId: CAMPAIGN_ID,
      email,
      firstName: 'Load',
      lastName: 'Test',
    }),
    { headers: { 'content-type': 'application/json' } },
  );
  check(res, {
    'status is 201, 200 or 429 (rate-limited is expected under load)': (r) =>
      [200, 201, 429].includes(r.status),
  });
}

// Traffic pattern 2 (read-heavy): GET /v1/queue/status — requires a Bearer JWT (requireAuth in
// apps/api/src/lib/requireAuth.ts; token shape/claims minted by signAuthToken in
// apps/api/src/routes/auth.ts's POST /auth/login).
export function pollQueueOverview() {
  const res = http.get(`${API_BASE_URL}/v1/queue/status`, {
    headers: JWT_TOKEN ? { authorization: `Bearer ${JWT_TOKEN}` } : {},
  });
  check(res, {
    'status is 200 or 429 (rate-limited is expected under load)': (r) =>
      [200, 429].includes(r.status),
  });
  if (!JWT_TOKEN) {
    // Only meaningful in a JWT_TOKEN-less parse/smoke run (e.g. this script's own verification
    // step) — a real run always supplies JWT_TOKEN, so this should never fire outside that case.
    check(res, {
      'status is 401 (expected: no JWT_TOKEN supplied)': (r) => r.status === 401,
    });
  }
}

// Compatibility shim: k6 CLI flags like --vus/--iterations/--duration/--stages override
// `options.scenarios` entirely and fall back to a single implicit "default" executor that
// requires a `default` export (verified against a real k6 v2.2.0 binary — omitting this makes
// `k6 run --vus 1 --iterations 1 ...` fail with "function 'default' not found in exports", even
// though the documented `k6 run --env API_BASE_URL=...` invocation below never hits this path
// since it doesn't pass those flags and uses the real `scenarios` config instead). Exists purely
// so ad-hoc single-VU smoke/parse checks keep working; a real run should never pass --vus/
// --iterations, since that bypasses the sizing arithmetic entirely.
export default function () {
  ingestLead();
}

// handleSummary — writes summary.json to the CWD so a future CI step can upload it as an
// artifact. Hand-rolled rather than importing a shared helper, per the note at the top of this
// file (this script is fully standalone).
export function handleSummary(data) {
  const m = data.metrics;
  const pct = (name, p) => m[name]?.values?.[`p(${p})`];
  const fmtMs = (v) => (typeof v === 'number' ? `${v.toFixed(1)}ms` : 'n/a');
  const fmtPct = (v) => (typeof v === 'number' ? `${(v * 100).toFixed(2)}%` : 'n/a');

  const lines = [
    '',
    'WarmHawk dispatcher load test summary',
    `  webhook_ingest_sustained  p95=${fmtMs(pct('http_req_duration{scenario:webhook_ingest_sustained}', 95))}`,
    `  queue_overview_polling    p95=${fmtMs(pct('http_req_duration{scenario:queue_overview_polling}', 95))}`,
    `  http_req_duration (all)   p95=${fmtMs(pct('http_req_duration', 95))}  p99=${fmtMs(pct('http_req_duration', 99))}`,
    `  http_req_failed           rate=${fmtPct(m.http_req_failed?.values?.rate)}`,
    `  checks                    rate=${fmtPct(m.checks?.values?.rate)}`,
    `  iterations                ${m.iterations?.values?.count ?? 'n/a'}`,
    '',
  ];

  return {
    stdout: lines.join('\n'),
    'summary.json': JSON.stringify(data, null, 2),
  };
}
