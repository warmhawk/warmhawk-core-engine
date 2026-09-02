/**
 * Integration test for the reconciliation cron — requires a real Postgres + Redis
 * (docker-compose.test.yml), per the Testing Strategy's Redis Durability row: "kill the Redis
 * container mid-burst in a test harness, restart it, confirm no in-flight send is silently
 * lost." This file covers the reconciliation logic itself (Postgres says QUEUED with an overdue
 * slot, BullMQ has no matching job -> gets re-enqueued); the full container-kill drill is a
 * release-gated manual/CI step documented in docs/backup-and-restore.md's sibling reliability
 * checklist, not re-run on every PR.
 *
 * NOT run by `npm test` (unit config) — wired into `npm run test:integration`
 * (vitest.integration.config.ts), which points DATABASE_URL/REDIS_URL at docker-compose.test.yml.
 * Skipped automatically if those env vars aren't set, so `npm test` stays fast and mock-free-DB
 * unit tests never accidentally require a live database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '@warmhawk/db';
import { reconcileStuckLeads, RECONCILE_OVERDUE_GRACE_MINUTES } from '../reconcile';
import { DISPATCH_QUEUE_NAME } from '../queue';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

describeIntegration('reconcileStuckLeads (integration, real Postgres + Redis)', () => {
  let redis: IORedis;
  let queue: Queue;
  let campaignId: string;

  beforeAll(async () => {
    redis = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    queue = new Queue(DISPATCH_QUEUE_NAME, { connection: redis });

    const campaign = await prisma.campaign.create({
      data: { name: 'Reconcile Test Campaign', status: 'ACTIVE', aiPromptTemplate: '' },
    });
    campaignId = campaign.id;
  });

  afterAll(async () => {
    await queue.close();
    await redis.quit();
    await prisma.campaign.delete({ where: { id: campaignId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.lead.deleteMany({ where: { campaignId } });
  });

  it('re-enqueues a lead stuck QUEUED past the grace period with no matching BullMQ job', async () => {
    const overdueSlot = new Date(Date.now() - (RECONCILE_OVERDUE_GRACE_MINUTES + 5) * 60 * 1000);
    const fakeJobId = `stuck-lead-id:mbx_fake:${overdueSlot.getTime()}`;

    const lead = await prisma.lead.create({
      data: {
        campaignId,
        email: 'stuck@example.com',
        status: 'QUEUED',
        queuedJobId: fakeJobId,
        queuedSlotAt: overdueSlot,
      },
    });

    const result = await reconcileStuckLeads(queue);
    expect(result.requeued).toBeGreaterThanOrEqual(1);

    const updated = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(updated.queuedJobId).not.toBe(fakeJobId);

    const job = await queue.getJob(updated.queuedJobId!);
    expect(job).not.toBeNull();
  });

  it('does not touch a lead whose BullMQ job still genuinely exists', async () => {
    const overdueSlot = new Date(Date.now() - (RECONCILE_OVERDUE_GRACE_MINUTES + 5) * 60 * 1000);
    const jobId = `real-job-lead:mbx_real:${overdueSlot.getTime()}`;

    await queue.add(
      'dispatch',
      { leadId: 'real-job-lead', mailboxId: 'mbx_real' },
      { jobId, delay: 1000 },
    );

    const lead = await prisma.lead.create({
      data: {
        campaignId,
        email: 'not-stuck@example.com',
        status: 'QUEUED',
        queuedJobId: jobId,
        queuedSlotAt: overdueSlot,
      },
    });

    await reconcileStuckLeads(queue);

    const updated = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(updated.queuedJobId).toBe(jobId); // unchanged — the job was real, nothing to fix
  });

  it('does not touch a lead whose slot has not yet passed the grace period', async () => {
    const recentSlot = new Date(Date.now() - 2 * 60 * 1000); // only 2 minutes overdue
    const jobId = `not-overdue-lead:mbx_x:${recentSlot.getTime()}`;

    const lead = await prisma.lead.create({
      data: {
        campaignId,
        email: 'not-overdue@example.com',
        status: 'QUEUED',
        queuedJobId: jobId,
        queuedSlotAt: recentSlot,
      },
    });

    await reconcileStuckLeads(queue);

    const updated = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(updated.queuedJobId).toBe(jobId); // untouched — not yet past the grace window
  });
});
