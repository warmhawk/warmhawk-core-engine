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
      expect(json.throttling).toEqual({ cadenceFloorSeconds: 480, jitterSeconds: 240 });

      const found = json.jobs.find((j: { id: string }) => j.id === jobId);
      expect(found).toBeTruthy();
      expect(found.state).toBe('delayed');
      expect(found.leadEmail).toBe(leadEmail);
      expect(found.mailboxEmail).toBe(mailboxEmail);
      expect(found.campaignName).toBe('Queue Status Test Campaign');
    } finally {
      const job = await queue.getJob(jobId);
      await job?.remove();
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
