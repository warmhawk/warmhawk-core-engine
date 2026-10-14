/**
 * Integration test for `/v1/queue` (`GET /status`, `POST /pause`) against REAL Postgres + Redis
 * (docker-compose.test.yml). Mirrors `reconcile.integration.test.ts`'s Redis/BullMQ setup style.
 *
 * IMPORTANT — this Redis instance is shared with an already-running `warmhawk-core-engine-worker`
 * container processing the same `warmhawk-dispatch` queue this file inspects:
 *   - The status-check job is added with a long `delay` so it lands in the `delayed` state, never
 *     `waiting` — the live worker will not pick it up before this test removes it again.
 *   - The pause/resume test wraps the pause half in try/finally AND resumes again defensively in
 *     `afterAll`, so the shared queue is never left paused even if an assertion throws mid-test.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

// MUST match apps/api/src/routes/queue.ts's own DISPATCH_QUEUE_NAME constant (duplicated there
// too, deliberately — see that file's header comment on why it isn't a shared import).
const DISPATCH_QUEUE_NAME = 'warmhawk-dispatch';

describeIntegration('queue routes (integration, real Postgres + Redis)', () => {
  let app: FastifyInstance;
  let authToken: string;
  let redis: IORedis;
  let queue: Queue;

  let domainId: string;
  let mailboxId: string;
  let campaignId: string;
  let leadId: string;
  let leadEmail: string;
  let mailboxEmail: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-not-a-real-secret-value';
    app = await createApp();
    await app.ready();

    const jwt = await import('jsonwebtoken');
    authToken = jwt.default.sign(
      { sub: 'test-user', email: 'test@example.org', role: 'ADMIN' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' },
    );

    redis = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    queue = new Queue(DISPATCH_QUEUE_NAME, { connection: redis });

    const domain = await prisma.domain.create({
      data: { domainName: `queue-test-${Date.now()}.example.com` },
    });
    domainId = domain.id;

    mailboxEmail = `queue-sender-${Date.now()}@example.com`;
    const mailbox = await prisma.mailbox.create({ data: { email: mailboxEmail, domainId } });
    mailboxId = mailbox.id;

    const campaign = await prisma.campaign.create({
      data: { name: 'Queue Status Test Campaign', status: 'ACTIVE', aiPromptTemplate: '' },
    });
    campaignId = campaign.id;

    leadEmail = `queue-lead-${Date.now()}@example.com`;
    const lead = await prisma.lead.create({
      data: { campaignId, email: leadEmail, status: 'QUEUED' },
    });
    leadId = lead.id;
  });

  afterAll(async () => {
    // Safety net: never leave the shared dispatch queue paused, whatever happened above.
    await queue.resume().catch(() => undefined);
    await queue.close();
    await redis.quit();

    await prisma.lead.deleteMany({ where: { campaignId } });
    await prisma.campaign.deleteMany({ where: { id: campaignId } });
    await prisma.mailbox.deleteMany({ where: { id: mailboxId } });
    await prisma.domain.deleteMany({ where: { id: domainId } });
    await app.close();
    await prisma.$disconnect();
  });

  it('reports job counts, throttling config, and a delayed job enriched with lead/mailbox/campaign names', async () => {
    const jobId = `${leadId}:${mailboxId}:${Date.now()}`;
    // 10 minute delay — long enough that the real, already-running worker never picks this up
    // before the `finally` block below removes it.
    await queue.add('dispatch', { leadId, mailboxId }, { jobId, delay: 10 * 60 * 1000 });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/queue/status',
        headers: { authorization: `Bearer ${authToken}` },
      });
      expect(response.statusCode).toBe(200);
      const json = response.json();

      expect(json.counts).toHaveProperty('delayed');
      expect(json.throttling).toEqual({
        cadenceFloorSeconds: 480,
        jitterSeconds: 240,
        minGapSeconds: 630,
        maxGapSeconds: 1050,
      });

      const found = json.jobs.find((j: { id: string }) => j.id === jobId);
      expect(found).toBeTruthy();
      expect(found.state).toBe('delayed');
      expect(found.leadEmail).toBe(leadEmail);
      expect(found.mailboxEmail).toBe(mailboxEmail);
      expect(found.campaignName).toBe('Queue Status Test Campaign');
      // What the panel's email preview needs: whose email, which campaign, which step goes next.
      expect(found).toMatchObject({ leadId, campaignId, step: 0 });
    } finally {
      const job = await queue.getJob(jobId);
      await job?.remove();
    }
  });

  /**
   * Regression test for the phantom "unknown / unknown / unknown" row: the system `daily-reset`
   * job (apps/worker/src/index.ts's repeatable cron, name `DAILY_RESET_JOB_NAME` = 'daily-reset')
   * shares this same `warmhawk-dispatch` queue with real per-lead dispatch jobs, carries no
   * leadId/mailboxId, and must never reach GET /status's `jobs` list — queue.ts's `SYSTEM_JOB_NAMES`
   * filter is what's under test here. Adds a one-off job named 'daily-reset' (doesn't need to be
   * the actual repeatable registration — job.name is all the filter keys off of) alongside a real
   * dispatch job, both delayed long enough that the live worker never picks either up first.
   */
  it('excludes the system daily-reset job from the job-summary list, but keeps a real dispatch job alongside it', async () => {
    // BullMQ rejects custom job IDs containing ":" ("Custom Id cannot contain :") — unlike the
    // jobId format used in the test above (which BullMQ itself never validates against that rule
    // for an auto-added job in the normal dispatch path, but a literal custom id here does hit
    // the check), so these use "-" as the separator instead.
    const dispatchJobId = `${leadId}-${mailboxId}-daily-reset-regression-${Date.now()}`;
    const dailyResetJobId = `daily-reset-regression-${Date.now()}`;
    await queue.add(
      'dispatch',
      { leadId, mailboxId },
      { jobId: dispatchJobId, delay: 10 * 60 * 1000 },
    );
    await queue.add('daily-reset', {}, { jobId: dailyResetJobId, delay: 10 * 60 * 1000 });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/queue/status',
        headers: { authorization: `Bearer ${authToken}` },
      });
      expect(response.statusCode).toBe(200);
      const json = response.json();

      const realJob = json.jobs.find((j: { id: string }) => j.id === dispatchJobId);
      expect(realJob).toBeTruthy();
      expect(realJob.leadEmail).toBe(leadEmail);

      const phantomJob = json.jobs.find((j: { id: string }) => j.id === dailyResetJobId);
      expect(phantomJob).toBeUndefined();
      // The specific regression: no row anywhere in the list renders as unknown/unknown/unknown.
      expect(
        json.jobs.some(
          (j: { leadEmail: string; mailboxEmail: string; campaignName: string }) =>
            j.leadEmail === 'unknown' &&
            j.mailboxEmail === 'unknown' &&
            j.campaignName === 'unknown',
        ),
      ).toBe(false);
    } finally {
      await (await queue.getJob(dispatchJobId))?.remove();
      await (await queue.getJob(dailyResetJobId))?.remove();
    }
  });

  it('reports sends per UTC day for the last 6 days and today, counting only sends that left', async () => {
    const getSent = async (): Promise<{ day: string; count: number }[]> => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/queue/status',
        headers: { authorization: `Bearer ${authToken}` },
      });
      expect(response.statusCode).toBe(200);
      return response.json().sentByDay;
    };
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    // Other tests share this database, so compare against a before count rather than absolutes.
    const before = await getSent();
    const created = await Promise.all(
      [
        { status: 'SENT', at: now },
        { status: 'REPLIED', at: now },
        { status: 'FAILED', at: now },
        { status: 'OPENED', at: now - 3 * DAY },
        { status: 'SENT', at: now - 8 * DAY },
      ].map(({ status, at }) =>
        prisma.executionLog.create({
          data: {
            campaignId,
            leadId,
            mailboxId,
            status: status as 'SENT',
            createdAt: new Date(at),
          },
        }),
      ),
    );

    try {
      const after = await getSent();
      expect(after).toHaveLength(7);
      const day = (offset: number) => new Date(now - offset * DAY).toISOString().slice(0, 10);
      expect(after.map((d) => d.day)).toEqual([6, 5, 4, 3, 2, 1, 0].map(day));
      const gained = after.map((d, i) => d.count - before[i]!.count);
      expect(gained).toEqual([0, 0, 0, 1, 0, 0, 2]);
    } finally {
      await prisma.executionLog.deleteMany({ where: { id: { in: created.map((c) => c.id) } } });
    }
  });

  it("reports each mailbox's campaigns and two days either side of today", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    // Graduated a day ago: the ramp gives 5, 5, 6, 8, 9 across the five days.
    await prisma.mailbox.update({
      where: { id: mailboxId },
      data: { warmupGraduatedAt: new Date(now - DAY) },
    });
    const archived = await prisma.campaign.create({
      data: { name: 'Queue Old Campaign', status: 'ARCHIVED', aiPromptTemplate: '' },
    });
    await prisma.campaignMailbox.createMany({
      data: [
        { campaignId, mailboxId },
        { campaignId: archived.id, mailboxId },
      ],
    });
    const logs = await Promise.all(
      [
        { status: 'SENT', at: now },
        { status: 'FAILED', at: now },
        { status: 'REPLIED', at: now - DAY },
      ].map(({ status, at }) =>
        prisma.executionLog.create({
          data: {
            campaignId,
            leadId,
            mailboxId,
            status: status as 'SENT',
            createdAt: new Date(at),
          },
        }),
      ),
    );
    const warmups = await Promise.all(
      ['PENDING', 'FAILED'].map((placement) =>
        prisma.warmupMessage.create({
          data: {
            senderMailboxId: mailboxId,
            recipientEmail: 'partner@example.com',
            subject: 'hi',
            placement: placement as 'PENDING',
            sentAt: new Date(now),
          },
        }),
      ),
    );
    const jobId = `${leadId}-${mailboxId}-activity-${now}`;
    await queue.add('dispatch', { leadId, mailboxId }, { jobId, delay: DAY });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/queue/status',
        headers: { authorization: `Bearer ${authToken}` },
      });
      expect(response.statusCode).toBe(200);
      const mine = response.json().mailboxes.find((m: { id: string }) => m.id === mailboxId);
      expect(mine.campaigns).toEqual([
        { id: campaignId, name: 'Queue Status Test Campaign', status: 'ACTIVE' },
      ]);
      const day = (offset: number) => new Date(now + offset * DAY).toISOString().slice(0, 10);
      expect(mine.days).toEqual([
        { day: day(-2), sent: 0, warmup: 0, queued: 0, cap: 5 },
        { day: day(-1), sent: 1, warmup: 0, queued: 0, cap: 5 },
        { day: day(0), sent: 1, warmup: 1, queued: 0, cap: 6 },
        { day: day(1), sent: 0, warmup: 0, queued: 1, cap: 8 },
        { day: day(2), sent: 0, warmup: 0, queued: 0, cap: 9 },
      ]);
    } finally {
      await (await queue.getJob(jobId))?.remove();
      await prisma.warmupMessage.deleteMany({ where: { id: { in: warmups.map((w) => w.id) } } });
      await prisma.executionLog.deleteMany({ where: { id: { in: logs.map((l) => l.id) } } });
      await prisma.campaignMailbox.deleteMany({ where: { mailboxId } });
      await prisma.campaign.delete({ where: { id: archived.id } });
      await prisma.mailbox.update({ where: { id: mailboxId }, data: { warmupGraduatedAt: null } });
    }
  });

  it('lists pending jobs for one mailbox or one day, soonest first, with the match total', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const stamp = `${now}`;
    const added = [
      { id: `jobs-later-${stamp}`, mailbox: mailboxId, delay: 2 * DAY },
      { id: `jobs-soon-${stamp}`, mailbox: mailboxId, delay: DAY },
      { id: `jobs-other-${stamp}`, mailbox: 'some-other-mailbox', delay: DAY },
    ];
    for (const job of added) {
      await queue.add(
        'dispatch',
        { leadId, mailboxId: job.mailbox },
        { jobId: job.id, delay: job.delay },
      );
    }
    const get = async (query: string) => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/queue/jobs?${query}`,
        headers: { authorization: `Bearer ${authToken}` },
      });
      expect(response.statusCode).toBe(200);
      return response.json() as { total: number; jobs: { id: string; leadEmail: string }[] };
    };

    try {
      const mine = await get(`mailboxId=${mailboxId}`);
      expect(mine.total).toBe(2);
      expect(mine.jobs.map((j) => j.id)).toEqual([`jobs-soon-${stamp}`, `jobs-later-${stamp}`]);
      expect(mine.jobs[0]!.leadEmail).toBe(leadEmail);

      const tomorrow = new Date(now + DAY).toISOString().slice(0, 10);
      const due = await get(`day=${tomorrow}`);
      const ids = due.jobs.map((j) => j.id);
      expect(ids).toContain(`jobs-soon-${stamp}`);
      expect(ids).toContain(`jobs-other-${stamp}`);
      expect(ids).not.toContain(`jobs-later-${stamp}`);

      const both = await get(`mailboxId=${mailboxId}&day=${tomorrow}`);
      expect(both.jobs.map((j) => j.id)).toEqual([`jobs-soon-${stamp}`]);
    } finally {
      for (const job of added) await (await queue.getJob(job.id))?.remove();
    }
  });

  it('pauses and resumes the dispatch queue for real (BullMQ-backed, not cosmetic)', async () => {
    try {
      const pauseResponse = await app.inject({
        method: 'POST',
        url: '/v1/queue/pause',
        headers: { authorization: `Bearer ${authToken}` },
        payload: { paused: true },
      });
      expect(pauseResponse.statusCode).toBe(200);
      expect(pauseResponse.json()).toEqual({ isPaused: true });
      expect(await queue.isPaused()).toBe(true);
    } finally {
      const resumeResponse = await app.inject({
        method: 'POST',
        url: '/v1/queue/pause',
        headers: { authorization: `Bearer ${authToken}` },
        payload: { paused: false },
      });
      expect(resumeResponse.statusCode).toBe(200);
      expect(resumeResponse.json()).toEqual({ isPaused: false });
    }
    expect(await queue.isPaused()).toBe(false);
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/queue/status' });
    expect(response.statusCode).toBe(401);
  });
});
