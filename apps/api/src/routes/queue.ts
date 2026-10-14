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
import { Queue, type Job } from 'bullmq';
import { prisma } from '@warmhawk/db';
import { requireAuth } from '../lib/requireAuth';
import { campaignCapToday } from '../lib/warmup/policy';

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
// The real gap between two sends from one mailbox, with no send window: the floor, plus
// 240-480s of jitter, plus ±90s of noise — all from computeNextSlotSeconds.ts. The jitter only
// ever adds, so the shortest gap is 630s, not the floor.
const MIN_GAP_SECONDS = CADENCE_FLOOR_SECONDS + 240 - 90;
const MAX_GAP_SECONDS = CADENCE_FLOOR_SECONDS + 480 + 90;

const JOB_STATES = ['waiting', 'active', 'delayed', 'completed', 'failed'] as const;
type DispatchJobState = (typeof JOB_STATES)[number];
const MAX_LISTED_JOBS = 50;
// Days of send history the Live Queue chart shows before today.
const SENT_HISTORY_DAYS = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sends per UTC day for the SENT_HISTORY_DAYS days before today plus today, oldest first, every
 * day present even at 0. A send's execution log starts SENT and may move on to OPENED, REPLIED or
 * BOUNCED, so all four count (the worker's rollingSends.ts uses the same set); FAILED never left.
 * `createdAt` is a UTC timestamp without a zone, so its date part is the UTC day.
 */
export async function sentByDay(now: Date): Promise<{ day: string; count: number }[]> {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Array.from({ length: SENT_HISTORY_DAYS + 1 }, (_, i) =>
    new Date(today - (SENT_HISTORY_DAYS - i) * DAY_MS).toISOString().slice(0, 10),
  );
  const rows = await prisma.$queryRaw<{ day: string; count: number }[]>`
    SELECT to_char("createdAt", 'YYYY-MM-DD') AS day, count(*)::int AS count
    FROM "execution_logs"
    WHERE "status" IN ('SENT', 'OPENED', 'REPLIED', 'BOUNCED')
      AND "createdAt" >= ${new Date(today - SENT_HISTORY_DAYS * DAY_MS)}
    GROUP BY 1`;
  const byDay = new Map(rows.map((row) => [row.day, row.count]));
  return days.map((day) => ({ day, count: byDay.get(day) ?? 0 }));
}

// Days either side of today the Live Queue's per-mailbox table shows.
const MAILBOX_DAYS_EACH_SIDE = 2;
// Campaigns listed live ones first; archived ones aren't listed.
const CAMPAIGN_STATUS_ORDER = ['ACTIVE', 'PAUSED', 'DRAFT', 'COMPLETED'];

export interface MailboxDay {
  day: string;
  /** Campaign emails that left (same statuses as sentByDay). */
  sent: number;
  /** Warmup emails that left — they don't count against the campaign cap. */
  warmup: number;
  /** Dispatch jobs due that day; overdue ones count toward today. */
  queued: number;
  /** Campaign cap for that day, including the post-graduation ramp. */
  cap: number;
}

export interface MailboxActivity {
  id: string;
  campaigns: { id: string; name: string; status: string }[];
  days: MailboxDay[];
}

/**
 * Per mailbox: its campaigns, and the MAILBOX_DAYS_EACH_SIDE UTC days either side of today with
 * sends, warmup sends, queued jobs and that day's cap. Past caps apply today's dailyCap to the
 * ramp — cap edits aren't kept, so a day before an edit shows the new cap.
 */
export async function mailboxActivity(
  now: Date,
  dueJobs: { mailboxId: string; dueAtMs: number }[],
): Promise<MailboxActivity[]> {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const offsets = Array.from(
    { length: MAILBOX_DAYS_EACH_SIDE * 2 + 1 },
    (_, i) => i - MAILBOX_DAYS_EACH_SIDE,
  );
  const days = offsets.map((o) => new Date(today + o * DAY_MS).toISOString().slice(0, 10));
  const since = new Date(today - MAILBOX_DAYS_EACH_SIDE * DAY_MS);

  type Row = { mailboxId: string; day: string; count: number };
  const [mailboxes, sentRows, warmupRows] = await Promise.all([
    prisma.mailbox.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        dailyCap: true,
        warmupGraduatedAt: true,
        campaignLinks: { select: { campaign: { select: { id: true, name: true, status: true } } } },
      },
    }),
    prisma.$queryRaw<Row[]>`
      SELECT "mailboxId", to_char("createdAt", 'YYYY-MM-DD') AS day, count(*)::int AS count
      FROM "execution_logs"
      WHERE "status" IN ('SENT', 'OPENED', 'REPLIED', 'BOUNCED')
        AND "mailboxId" IS NOT NULL AND "createdAt" >= ${since}
      GROUP BY 1, 2`,
    prisma.$queryRaw<Row[]>`
      SELECT "senderMailboxId" AS "mailboxId", to_char("sentAt", 'YYYY-MM-DD') AS day,
        count(*)::int AS count
      FROM "warmup_messages"
      WHERE "placement" <> 'FAILED' AND "sentAt" >= ${since}
      GROUP BY 1, 2`,
  ]);

  const key = (mailboxId: string, day: string) => `${mailboxId}|${day}`;
  const sent = new Map(sentRows.map((r) => [key(r.mailboxId, r.day), r.count]));
  const warmup = new Map(warmupRows.map((r) => [key(r.mailboxId, r.day), r.count]));
  const queued = new Map<string, number>();
  for (const job of dueJobs) {
    const day = new Date(Math.max(job.dueAtMs, today)).toISOString().slice(0, 10);
    queued.set(key(job.mailboxId, day), (queued.get(key(job.mailboxId, day)) ?? 0) + 1);
  }

  return mailboxes.map((m) => ({
    id: m.id,
    campaigns: m.campaignLinks
      .map((link) => link.campaign)
      .filter((c) => CAMPAIGN_STATUS_ORDER.includes(c.status))
      .sort(
        (a, b) =>
          CAMPAIGN_STATUS_ORDER.indexOf(a.status) - CAMPAIGN_STATUS_ORDER.indexOf(b.status) ||
          a.name.localeCompare(b.name),
      ),
    days: days.map((day, i) => ({
      day,
      sent: sent.get(key(m.id, day)) ?? 0,
      warmup: warmup.get(key(m.id, day)) ?? 0,
      queued: offsets[i]! < 0 ? 0 : (queued.get(key(m.id, day)) ?? 0),
      cap: campaignCapToday(
        m.dailyCap,
        m.warmupGraduatedAt,
        new Date(now.getTime() + offsets[i]! * DAY_MS),
      ),
    })),
  }));
}

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

/** When a dispatch job is due: added at `timestamp`, held back by `delay`. */
function dueAtMs(job: Job): number {
  return job.timestamp + (job.opts?.delay ?? 0);
}

/** A due time's UTC day; overdue jobs are still due, so they count toward today (as on /jobs). */
function dueDay(dueAt: number, today: number): string {
  return new Date(Math.max(dueAt, today)).toISOString().slice(0, 10);
}

/**
 * Every pending job counted by the UTC day it's due, soonest day first, only days with jobs. The
 * listed `jobs` stop at MAX_LISTED_JOBS, so the Live Queue chart needs these to show real totals.
 */
export function queuedByDay(now: Date, dueAts: number[]): { day: string; count: number }[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const counts = new Map<string, number>();
  for (const dueAt of dueAts) {
    const day = dueDay(dueAt, today);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, count }));
}

/**
 * The dashboard's view of dispatch jobs: lead, mailbox and campaign names instead of ids. System
 * jobs (the repeatable `daily-reset` cron) carry no leadId/mailboxId and would render as a phantom
 * "unknown / unknown / unknown" row, so callers filter them out with SYSTEM_JOB_NAMES first.
 */
async function summarizeJobs(jobs: Job[]) {
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

  return Promise.all(
    jobs.map(async (job) => {
      const state = (await job.getState()) as DispatchJobState;
      const lead = leadById.get(job.data?.leadId);
      const mailbox = mailboxById.get(job.data?.mailboxId);
      return {
        id: job.id ?? `${job.data?.leadId}:${job.data?.mailboxId}`,
        state,
        mailboxEmail: mailbox?.email ?? 'unknown',
        leadEmail: lead?.email ?? 'unknown',
        campaignName: lead?.campaign?.name ?? 'unknown',
        scheduledFor: new Date(dueAtMs(job)).toISOString(),
        attemptsMade: job.attemptsMade ?? 0,
        // For the Live Queue panel's email preview. `step` is what this job sends: 0 = the first
        // email, N = follow-up N — the same `stepsSent` the processor reads.
        leadId: lead?.id ?? null,
        campaignId: lead?.campaignId ?? null,
        step: lead?.stepsSent ?? null,
      };
    }),
  );
}

export async function queueRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/status', async () => {
    const queue = dispatchQueue();

    const [rawCounts, isPaused, sent] = await Promise.all([
      queue.getJobCounts(...JOB_STATES),
      queue.isPaused(),
      sentByDay(new Date()),
    ]);
    const counts = Object.fromEntries(
      JOB_STATES.map((state) => [state, rawCounts[state] ?? 0]),
    ) as Record<DispatchJobState, number>;

    // Every pending job, for the per-day and per-mailbox queued counts; the list below shows the
    // soonest MAX_LISTED_JOBS.
    const now = new Date();
    const allJobs = await queue.getJobs(['waiting', 'active', 'delayed']);
    const dispatchJobs = allJobs
      .filter((job) => !SYSTEM_JOB_NAMES.has(job.name))
      .sort((a, b) => dueAtMs(a) - dueAtMs(b));
    const activity = await mailboxActivity(
      now,
      allJobs
        .filter((job) => job.data?.mailboxId)
        .map((job) => ({
          mailboxId: job.data.mailboxId as string,
          dueAtMs: dueAtMs(job),
        })),
    );

    const jobSummaries = await summarizeJobs(dispatchJobs.slice(0, MAX_LISTED_JOBS));

    return {
      counts,
      isPaused,
      jobs: jobSummaries,
      sentByDay: sent,
      queuedByDay: queuedByDay(now, dispatchJobs.map(dueAtMs)),
      mailboxes: activity,
      throttling: {
        cadenceFloorSeconds: CADENCE_FLOOR_SECONDS,
        jitterSeconds: JITTER_BAND_SECONDS,
        minGapSeconds: MIN_GAP_SECONDS,
        maxGapSeconds: MAX_GAP_SECONDS,
      },
    };
  });

  /**
   * Pending dispatch jobs for the Live Queue's side panel, soonest first, up to MAX_LISTED_JOBS
   * with the full match count in `total`. `mailboxId` narrows to one mailbox; `day` (UTC
   * "YYYY-MM-DD") to the jobs due that day, overdue ones counting toward today as on the chart.
   */
  app.get<{ Querystring: { mailboxId?: string; day?: string } }>('/jobs', async (request) => {
    const { mailboxId, day } = request.query;
    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const all = await dispatchQueue().getJobs(['waiting', 'active', 'delayed']);
    const matching = all
      .filter((job) => !SYSTEM_JOB_NAMES.has(job.name))
      .filter((job) => !mailboxId || job.data?.mailboxId === mailboxId)
      .filter((job) => !day || dueDay(dueAtMs(job), today) === day)
      .sort((a, b) => dueAtMs(a) - dueAtMs(b));
    return {
      total: matching.length,
      jobs: await summarizeJobs(matching.slice(0, MAX_LISTED_JOBS)),
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
