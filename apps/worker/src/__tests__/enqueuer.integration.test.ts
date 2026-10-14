/**
 * Integration test for `runEnqueuerTick`'s send schedule (10-14-26) — requires a real Postgres +
 * Redis (docker-compose.test.yml), same pattern as `reconcile.integration.test.ts`. Covers what the
 * pure unit tests can't: one booked slot per mailbox across ticks (the over-queue fix), the send
 * window, a follow-up due outside the window, "max new leads per day", the rolling 24-hour limit,
 * and sending in each lead's time zone.
 *
 * Uses its own queue name so no running worker picks the jobs up.
 *
 * NOT run by `npm test` (unit config) — wired into `npm run test:integration`
 * (vitest.integration.config.ts). Skipped automatically if DATABASE_URL/REDIS_URL aren't set.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { prisma, localParts } from '@warmhawk/db';
import { runEnqueuerTick } from '../enqueuer';
import { mailboxReservationKey } from '../queue';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

const DOMAIN = 'enqueuer-test.example';
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const HOUR_MS = 60 * 60 * 1000;

/** A UTC schedule, every day, all day unless overridden. Tests that aren't about the window use no
 *  schedule at all, so they don't depend on how much of the UTC day is left. */
function utcSchedule(extra: Record<string, unknown> = {}) {
  return {
    sendTimezone: 'UTC',
    sendDays: ALL_DAYS,
    sendStartMinute: 0,
    sendEndMinute: 1440,
    ...extra,
  };
}

describeIntegration('runEnqueuerTick send schedule (integration, real Postgres + Redis)', () => {
  let redis: IORedis;
  let queue: Queue;
  let domainId: string;
  let mailboxIds: string[] = [];
  let campaignIds: string[] = [];

  beforeAll(async () => {
    redis = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    queue = new Queue('warmhawk-dispatch-enqueuer-it', { connection: redis });
    const domain = await prisma.domain.upsert({
      where: { domainName: DOMAIN },
      create: { domainName: DOMAIN, mailingAddress: '1 Test Street, Springfield' },
      update: {},
    });
    domainId = domain.id;
  });

  async function cleanUp() {
    await redis.del(...mailboxIds.map(mailboxReservationKey), 'enqueuer-it-placeholder');
    await prisma.executionLog.deleteMany({ where: { mailboxId: { in: mailboxIds } } });
    await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
    await prisma.mailbox.deleteMany({ where: { id: { in: mailboxIds } } });
    await queue.obliterate({ force: true });
    mailboxIds = [];
    campaignIds = [];
  }

  afterAll(async () => {
    await cleanUp();
    await prisma.domain.deleteMany({ where: { id: domainId } });
    await queue.close();
    await redis.quit();
    await prisma.$disconnect();
  });

  beforeEach(cleanUp);

  async function mailbox(name: string, dailyCap = 50) {
    const m = await prisma.mailbox.create({
      data: {
        domainId,
        email: `${name}-${Date.now()}@${DOMAIN}`,
        provider: 'SMTP_CUSTOM',
        status: 'ACTIVE',
        dailyCap,
      },
    });
    mailboxIds.push(m.id);
    return m;
  }

  async function campaign(senders: string[], data: Record<string, unknown> = {}) {
    const c = await prisma.campaign.create({
      data: { name: 'Enqueuer IT', status: 'ACTIVE', aiPromptTemplate: '', ...data },
    });
    campaignIds.push(c.id);
    for (const mailboxId of senders) {
      await prisma.campaignMailbox.create({ data: { campaignId: c.id, mailboxId } });
    }
    return c;
  }

  async function leads(campaignId: string, count: number, data: Record<string, unknown> = {}) {
    for (let i = 0; i < count; i += 1) {
      await prisma.lead.create({
        data: { campaignId, email: `lead${i}-${Date.now()}@lead.example`, ...data },
      });
    }
  }

  const queued = (campaignId: string) =>
    prisma.lead.findMany({ where: { campaignId, queuedJobId: { not: null } } });

  it('books one slot per mailbox, and none more until that slot comes round', async () => {
    const a = await mailbox('a');
    const b = await mailbox('b');
    const c = await campaign([a.id, b.id]);
    await leads(c.id, 20);
    const now = new Date();

    expect(await runEnqueuerTick(queue, redis, now)).toBe(2);
    // Before the fix every tick booked each mailbox's whole remaining limit.
    expect(await runEnqueuerTick(queue, redis, new Date(now.getTime() + 60_000))).toBe(0);
    const booked = await queued(c.id);
    expect(booked).toHaveLength(2);
    expect(new Set(booked.map((l) => l.queuedJobId!.split(':')[1]))).toEqual(new Set([a.id, b.id]));

    // Once a's slot has come round, it takes the next lead — at least 8 minutes after that slot.
    const slotA = Number(await redis.get(mailboxReservationKey(a.id)));
    const later = new Date(Math.max(slotA, Number(await redis.get(mailboxReservationKey(b.id)))));
    expect(await runEnqueuerTick(queue, redis, later)).toBe(2);
    const newSlotA = Number(await redis.get(mailboxReservationKey(a.id)));
    expect(newSlotA - slotA).toBeGreaterThanOrEqual(8 * 60_000);
  });

  it('queues nothing while the window is closed', async () => {
    const m = await mailbox('closed');
    const today = localParts('UTC', new Date()).weekday;
    const c = await campaign(
      [m.id],
      utcSchedule({ sendDays: ALL_DAYS.filter((d) => d !== today) }),
    );
    await leads(c.id, 3);

    expect(await runEnqueuerTick(queue, redis)).toBe(0);
    expect(await queued(c.id)).toHaveLength(0);
  });

  it('never books a slot past the window close', async () => {
    const m = await mailbox('closing');
    const c = await campaign([m.id], utcSchedule({ sendEndMinute: 600 }));
    await leads(c.id, 3);
    // Two minutes before a 10:00 UTC close: no slot (the shortest is ~2.5 min) fits.
    const now = new Date();
    const nearClose = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 58),
    );

    expect(await runEnqueuerTick(queue, redis, nearClose)).toBe(0);
  });

  it('spreads the limit over the window instead of sending every few minutes', async () => {
    const m = await mailbox('spread', 10);
    const c = await campaign([m.id], utcSchedule());
    await leads(c.id, 3);
    // A send an hour ago: 10 a day over the rest of the day is far more than the 8-minute floor.
    await prisma.executionLog.create({
      data: { mailboxId: m.id, status: 'SENT', createdAt: new Date(Date.now() - HOUR_MS) },
    });
    await prisma.mailbox.update({
      where: { id: m.id },
      data: { lastSentAt: new Date(Date.now() - 60_000) },
    });
    const now = new Date();
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const minutesLeft = (midnight - now.getTime()) / 60_000;
    // Skip near midnight UTC, where the window has too little left to tell a spread from the floor.
    if (minutesLeft < 3 * 60) return;

    expect(await runEnqueuerTick(queue, redis, now)).toBe(1);
    const slot = Number(await redis.get(mailboxReservationKey(m.id)));
    // At most 10 sends left (9 when the hour-old send falls in today), so at least this gap.
    const expectedGap = (midnight - now.getTime()) / 10;
    expect(slot - (now.getTime() - 60_000)).toBeGreaterThanOrEqual(expectedGap * 0.8 - 1000);
  });

  it('holds a follow-up due outside the window, and sends it once the window allows', async () => {
    const m = await mailbox('followup');
    const now = new Date();
    const today = localParts('UTC', now).weekday;
    const c = await campaign(
      [m.id],
      utcSchedule({ sendDays: ALL_DAYS.filter((d) => d !== today) }),
    );
    await leads(c.id, 1, {
      status: 'CONTACTED',
      mailboxId: m.id,
      stepsSent: 1,
      lastStepAt: new Date(now.getTime() - 3 * 24 * HOUR_MS),
      nextStepAt: new Date(now.getTime() - HOUR_MS),
    });

    expect(await runEnqueuerTick(queue, redis, now)).toBe(0);
    await prisma.campaign.update({ where: { id: c.id }, data: { sendTimezone: null } });
    expect(await runEnqueuerTick(queue, redis, now)).toBe(1);
    const [lead] = await queued(c.id);
    expect(lead.status).toBe('CONTACTED');
  });

  it('stops first emails at "max new leads per day", counting the last 24 hours', async () => {
    const mailboxes = await Promise.all(['n1', 'n2', 'n3', 'n4'].map((n) => mailbox(n)));
    const c = await campaign(
      mailboxes.map((m) => m.id),
      { maxNewLeadsPerDay: 3 },
    );
    await leads(c.id, 1, {
      email: 'already@lead.example',
      status: 'CONTACTED',
      stepsSent: 1,
      lastStepAt: new Date(Date.now() - 2 * HOUR_MS),
      nextStepAt: new Date(Date.now() + 2 * 24 * HOUR_MS),
    });
    await leads(c.id, 10);

    // 3 a day, 1 sent already today: 2 more, though 4 mailboxes are free.
    expect(await runEnqueuerTick(queue, redis)).toBe(2);
    expect(await prisma.lead.count({ where: { campaignId: c.id, status: 'QUEUED' } })).toBe(2);
  });

  it('counts the daily limit over a rolling 24 hours, not since midnight', async () => {
    const m = await mailbox('rolling', 2);
    const c = await campaign([m.id]);
    await leads(c.id, 2);
    // Two sends 20 hours ago: under a midnight reset these could be "yesterday".
    for (let i = 0; i < 2; i += 1) {
      await prisma.executionLog.create({
        data: { mailboxId: m.id, status: 'SENT', createdAt: new Date(Date.now() - 20 * HOUR_MS) },
      });
    }

    expect(await runEnqueuerTick(queue, redis)).toBe(0);
    // Five hours on, both have rolled out of the 24 hours.
    expect(await runEnqueuerTick(queue, redis, new Date(Date.now() + 5 * HOUR_MS))).toBe(1);
  });

  it("sends in each lead's time zone when the campaign asks for it", async () => {
    const m1 = await mailbox('tz1');
    const m2 = await mailbox('tz2');
    const now = new Date();
    const utcHour = localParts('UTC', now).minute / 60;
    // Too close to a midnight close for any slot to fit.
    if (utcHour > 23.5) return;
    // A window of the current UTC hour, give or take one: open in UTC, closed 10+ hours away.
    const start = Math.max(0, Math.floor(utcHour) - 1) * 60;
    const end = Math.min(24, Math.floor(utcHour) + 2) * 60;
    const c = await campaign(
      [m1.id, m2.id],
      utcSchedule({ sendStartMinute: start, sendEndMinute: end, useLeadTimezone: true }),
    );
    const farZone = utcHour < 12 ? 'Pacific/Honolulu' : 'Asia/Tokyo';
    await leads(c.id, 1, { email: 'far@lead.example', customFields: { Timezone: farZone } });
    await leads(c.id, 1, { email: 'near@lead.example', customFields: { Country: 'Iceland' } });

    expect(await runEnqueuerTick(queue, redis, now)).toBe(1);
    const [lead] = await queued(c.id);
    expect(lead.email).toBe('near@lead.example');
  });
});
