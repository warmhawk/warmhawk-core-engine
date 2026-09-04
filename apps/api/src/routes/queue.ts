/**
 * Live queue inspector — `GET /v1/queue/status` (spec path; this file previously shipped it as
 * `/overview` before the API-surface correction pass) plus `POST /v1/queue/pause`, the global
 * pause/resume toggle the spec's Guardrails/Live-Queue sections both require. The dashboard's
 * Queue page and Overview stat tiles both call these (the V11/V12 "live queue inspector,
 * throttling controls" feature — Tier 1/2 only, gated client-side via
 * `TIER_FEATURES.liveQueueInspector`, same as every other tier-gated dashboard feature).
 *
 * `POST /pause` calls BullMQ's own `Queue.pause()`/`.resume()` directly — this is a real,
 * Redis-backed global pause (BullMQ workers check the paused flag before picking up the next
 * waiting job), not a soft/cosmetic toggle. `apps/worker` needs no code change to honor it; that's
 * exactly how BullMQ's pause mechanism is designed to work.
 *
 * Reads the SAME BullMQ dispatch queue `apps/worker/src/queue.ts` writes to. The queue name and
 * cadence/jitter constants are duplicated here as small local constants rather than imported,
 * since `apps/api` and `apps/worker` are independently deployable apps with no shared package
 * between them (same judgment call as the `tier-config` cross-repo mirror, just cross-app instead
 * of cross-repo). If a third consumer ever needs these, factor them into a real shared package
 * instead of a third copy — until then, keep this file's constants byte-identical to
 * `apps/worker/src/queue.ts`'s `DISPATCH_QUEUE_NAME` and
 * `apps/worker/src/computeNextSlotSeconds.ts`'s `CADENCE_FLOOR_MS`/jitter band.
 */
import type { FastifyInstance } from 'fastify';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { prisma } from '@warmhawk/db';
import { requireAuth } from '../lib/requireAuth';

// MUST match apps/worker/src/queue.ts's DISPATCH_QUEUE_NAME.
const DISPATCH_QUEUE_NAME = 'warmhawk-dispatch';
// MUST match apps/worker/src/queue.ts's DAILY_RESET_JOB_NAME — the repeatable system cron job that
// shares this same queue with real per-lead dispatch jobs. It carries no leadId/mailboxId, so it
// must never reach the dashboard's job-summary list (it would otherwise render as a phantom
// "unknown / unknown / unknown" row). Add any other system/internal job name here too.
const SYSTEM_JOB_NAMES = new Set(['daily-reset']);
// MUST match apps/worker/src/computeNextSlotSeconds.ts's CADENCE_FLOOR_MS (8-minute floor).
const CADENCE_FLOOR_SECONDS = 8 * 60;
// The jitter band's width (computeNextSlotSeconds.ts jitters 240-480s plus ±90s noise on top of
// the cadence floor) — reported as a single representative figure for the dashboard's "±Ns"
// throttling display, not a precise per-send guarantee.
const JITTER_BAND_SECONDS = 240;

const JOB_STATES = ['waiting', 'active', 'delayed', 'completed', 'failed'] as const;
type DispatchJobState = (typeof JOB_STATES)[number];
const MAX_LISTED_JOBS = 50;

let sharedQueue: Queue | null = null;

/**
 * Builds a `redis://` connection string with the password properly percent-encoded.
 * MUST match `apps/worker/src/queue.ts`'s copy of this same helper (same duplication rationale
 * as this file's other constants above — no shared package between the two independently
 * deployable apps).
 *
 * Bug fix (2026-09-04): `REDIS_PASSWORD` is generated via `openssl rand -base64 32`, whose
 * alphabet includes `/` and `+`. Interpolating a password containing `/` directly into
 * `redis://:PASSWORD@host:port` (as `docker-compose.yml`'s plain shell substitution does when
 * building the `REDIS_URL` env var) produces a string `new URL()` throws `Invalid URL` on —
 * confirmed live, crash-looping `apps/worker` on every boot. `encodeURIComponent()` guarantees a
 * syntactically valid URL for ANY password. `ioredis`'s own URL parser already calls
 * `decodeURIComponent()` on the parsed password, so this round-trips correctly.
 */
export function buildRedisUrl(host: string, port: number | string, password: string): string {
  return `redis://:${encodeURIComponent(password)}@${host}:${port}`;
}

/** Lazily-constructed, process-lifetime BullMQ queue handle — read-only from this app's side
 *  (never `.add()`s a job; only `apps/worker`'s enqueuer does that). */
function dispatchQueue(): Queue {
  if (!sharedQueue) {
    const password = process.env.REDIS_PASSWORD;
    const url = password
      ? buildRedisUrl(process.env.REDIS_HOST || 'redis', process.env.REDIS_PORT || 6379, password)
      : process.env.REDIS_URL || 'redis://localhost:6379';
    const connection = new IORedis(url, {
      maxRetriesPerRequest: null,
    });
    sharedQueue = new Queue(DISPATCH_QUEUE_NAME, { connection });
  }
  return sharedQueue;
}

export async function queueRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/status', async () => {
    const queue = dispatchQueue();

    const [rawCounts, isPaused] = await Promise.all([
      queue.getJobCounts(...JOB_STATES),
      queue.isPaused(),
    ]);
    const counts = Object.fromEntries(
      JOB_STATES.map((state) => [state, rawCounts[state] ?? 0]),
    ) as Record<DispatchJobState, number>;

    const rawJobs = await queue.getJobs(['waiting', 'active', 'delayed'], 0, MAX_LISTED_JOBS - 1);
    // Exclude system/internal jobs (the repeatable `daily-reset` cron) from the dashboard's job
    // list — they carry no leadId/mailboxId and would otherwise render as a phantom
    // "unknown / unknown / unknown" row. Filtered here, at summary-building time, not in the UI.
    const jobs = rawJobs.filter((job) => !SYSTEM_JOB_NAMES.has(job.name));

    const leadIds = jobs.map((job) => job.data?.leadId).filter((id): id is string => Boolean(id));
    const mailboxIds = jobs
      .map((job) => job.data?.mailboxId)
      .filter((id): id is string => Boolean(id));

    const [leads, mailboxes] = await Promise.all([
      leadIds.length
        ? prisma.lead.findMany({ where: { id: { in: leadIds } }, include: { campaign: true } })
        : Promise.resolve([]),
      mailboxIds.length
        ? prisma.mailbox.findMany({ where: { id: { in: mailboxIds } } })
        : Promise.resolve([]),
    ]);
    const leadById = new Map(leads.map((lead) => [lead.id, lead]));
    const mailboxById = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox]));

    const jobSummaries = await Promise.all(
      jobs.map(async (job) => {
        const state = (await job.getState()) as DispatchJobState;
        const lead = leadById.get(job.data?.leadId);
        const mailbox = mailboxById.get(job.data?.mailboxId);
        const scheduledForMs = job.timestamp + (job.opts?.delay ?? 0);
        return {
          id: job.id ?? `${job.data?.leadId}:${job.data?.mailboxId}`,
          state,
          mailboxEmail: mailbox?.email ?? 'unknown',
          leadEmail: lead?.email ?? 'unknown',
          campaignName: lead?.campaign?.name ?? 'unknown',
          scheduledFor: new Date(scheduledForMs).toISOString(),
          attemptsMade: job.attemptsMade ?? 0,
        };
      }),
    );

    return {
      counts,
      isPaused,
      jobs: jobSummaries,
      throttling: {
        cadenceFloorSeconds: CADENCE_FLOOR_SECONDS,
        jitterSeconds: JITTER_BAND_SECONDS,
      },
    };
  });

  /** Global pause/resume toggle (Guardrails/Live-Queue). `{ paused: true }` (or an empty body —
   *  "pause" is the default action, matching the endpoint's own name) stops the worker from
   *  picking up new waiting jobs; `{ paused: false }` resumes. Real BullMQ state, not cosmetic —
   *  see the file header for why `apps/worker` needs no matching code change. */
  app.post<{ Body: { paused?: boolean } }>('/pause', async (request) => {
    const queue = dispatchQueue();
    const paused = request.body?.paused ?? true;
    if (paused) {
      await queue.pause();
    } else {
      await queue.resume();
    }
    return { isPaused: paused };
  });
}
