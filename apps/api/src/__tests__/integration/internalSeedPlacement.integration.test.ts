/**
 * Integration test for the seed placement check (`lib/seedPlacementPoller.ts`) and its
 * `POST /internal/seed-placement/poll` route against a REAL Postgres (docker-compose.test.yml).
 * The IMAP side is a fake `InboxReader` — the real reader is covered by `warmupMail.e2e.test.ts`
 * against GreenMail — so these tests pin down which rows get checked and what they become.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';
import { encryptSeedImapConfig } from '../../lib/seedAccounts';
import { checkSampledPlacements } from '../../lib/seedPlacementPoller';
import type { InboxReader, WarmupTarget } from '../../lib/warmup/placement';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;
const CALLBACK_SECRET = process.env.NEXTJS_CALLBACK_SECRET || 'test-only-callback-secret';
const MIN = 60_000;

describeIntegration('seed placement check (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let domainId: string;
  let mailboxId: string;
  let campaignId: string;
  let seedAccountId: string;
  const now = new Date();

  function fakeReader(
    found: Record<string, { inSpam: boolean; promotions?: boolean } | null>,
  ): InboxReader {
    const uids = new Map<number, boolean>();
    let next = 1;
    return {
      find: async (target: WarmupTarget) => {
        const hit = found[target.messageId ?? ''];
        if (!hit) return null;
        const uid = next++;
        uids.set(uid, hit.promotions ?? false);
        return { uid, folder: hit.inSpam ? 'Junk' : 'INBOX', inSpam: hit.inSpam };
      },
      inPromotions: async ({ uid }: { uid: number }) => uids.get(uid) ?? false,
      markRead: async () => undefined,
      rescue: async () => undefined,
      close: async () => undefined,
    } as unknown as InboxReader;
  }

  async function pending(messageId: string, minutesAgo: number) {
    return prisma.seedPlacementResult.create({
      data: {
        campaignId,
        seedAccountId,
        mailboxId,
        messageId,
        sentAt: new Date(now.getTime() - minutesAgo * MIN),
        checkedAt: null,
      },
    });
  }

  beforeAll(async () => {
    process.env.NEXTJS_CALLBACK_SECRET = CALLBACK_SECRET;
    process.env.MAILBOX_CREDENTIAL_KEY =
      process.env.MAILBOX_CREDENTIAL_KEY || Buffer.from('b'.repeat(32)).toString('base64');
    app = await createApp();
    await app.ready();

    const domain = await prisma.domain.create({
      data: { domainName: `seed-poll-test-${Date.now()}.example.com` },
    });
    domainId = domain.id;
    const mailbox = await prisma.mailbox.create({
      data: { email: `seed-poll-sender-${Date.now()}@example.com`, domainId },
    });
    mailboxId = mailbox.id;
    const campaign = await prisma.campaign.create({
      data: { name: 'Seed Placement Poll Test Campaign', status: 'ACTIVE', aiPromptTemplate: '' },
    });
    campaignId = campaign.id;
    const seed = await prisma.seedAccount.create({
      data: {
        provider: 'GMAIL',
        emailAddress: `seed-poll-${Date.now()}@example.com`,
        imapConfigEncrypted: encryptSeedImapConfig({
          host: '127.0.0.1',
          port: 1,
          username: 'seed',
          password: 'pw',
        }),
      },
    });
    seedAccountId = seed.id;
  });

  beforeEach(async () => {
    await prisma.seedPlacementResult.deleteMany({ where: { campaignId } });
  });

  afterAll(async () => {
    await prisma.seedPlacementResult.deleteMany({ where: { campaignId } });
    await prisma.seedAccount.deleteMany({ where: { id: seedAccountId } });
    await prisma.campaign.deleteMany({ where: { id: campaignId } });
    await prisma.mailbox.deleteMany({ where: { id: mailboxId } });
    await prisma.domain.deleteMany({ where: { id: domainId } });
    await app.close();
    await prisma.$disconnect();
  });

  it('records INBOX / SPAM for copies it finds, and leaves fresh or unfound-yet copies pending', async () => {
    const inbox = await pending('<inbox@x>', 10);
    const spam = await pending('<spam@x>', 10);
    const tooFresh = await pending('<fresh@x>', 1);
    const notYet = await pending('<late@x>', 30);

    const summary = await checkSampledPlacements({
      now: () => now,
      openReader: async () =>
        fakeReader({ '<inbox@x>': { inSpam: false }, '<spam@x>': { inSpam: true }, '<fresh@x>': { inSpam: false } }),
    });

    expect(summary).toEqual({ seedChecked: 2, seedDropped: 0 });
    const rows = new Map(
      (await prisma.seedPlacementResult.findMany({ where: { campaignId } })).map((r) => [r.id, r]),
    );
    expect(rows.get(inbox.id)).toMatchObject({ folder: 'INBOX', checkedAt: now });
    expect(rows.get(spam.id)).toMatchObject({ folder: 'SPAM', checkedAt: now });
    expect(rows.get(tooFresh.id)?.checkedAt).toBeNull();
    expect(rows.get(notYet.id)?.checkedAt).toBeNull();
  });

  it('records PROMOTIONS for an INBOX copy under the Gmail Promotions tab', async () => {
    const promo = await pending('<promo@x>', 10);
    const primary = await pending('<primary@x>', 10);

    const summary = await checkSampledPlacements({
      now: () => now,
      openReader: async () =>
        fakeReader({
          '<promo@x>': { inSpam: false, promotions: true },
          '<primary@x>': { inSpam: false },
        }),
    });

    expect(summary).toEqual({ seedChecked: 2, seedDropped: 0 });
    const rows = new Map(
      (await prisma.seedPlacementResult.findMany({ where: { campaignId } })).map((r) => [r.id, r]),
    );
    expect(rows.get(promo.id)).toMatchObject({ folder: 'PROMOTIONS', checkedAt: now });
    expect(rows.get(primary.id)).toMatchObject({ folder: 'INBOX', checkedAt: now });
  });

  it('marks a copy UNCLASSIFIED once it has been missing for 2 hours', async () => {
    const lost = await pending('<lost@x>', 125);
    const summary = await checkSampledPlacements({ now: () => now, openReader: async () => fakeReader({}) });
    expect(summary.seedChecked).toBe(1);
    expect(await prisma.seedPlacementResult.findUnique({ where: { id: lost.id } })).toMatchObject({
      folder: 'UNCLASSIFIED',
      checkedAt: now,
    });
  });

  it('never counts an unreadable seed inbox — keeps the copy pending, then drops it after 6 hours', async () => {
    const recent = await pending('<recent@x>', 30);
    const old = await pending('<old@x>', 7 * 60);
    const summary = await checkSampledPlacements({
      now: () => now,
      openReader: async () => {
        throw new Error('IMAP login failed');
      },
    });
    expect(summary).toEqual({ seedChecked: 0, seedDropped: 1 });
    expect((await prisma.seedPlacementResult.findUnique({ where: { id: recent.id } }))?.checkedAt).toBeNull();
    expect(await prisma.seedPlacementResult.findUnique({ where: { id: old.id } })).toBeNull();
  });

  it('ignores legacy rows that have no sending mailbox', async () => {
    const legacy = await prisma.seedPlacementResult.create({
      data: { campaignId, seedAccountId, folder: 'SPAM', checkedAt: null },
    });
    const summary = await checkSampledPlacements({ now: () => now, openReader: async () => fakeReader({}) });
    expect(summary.seedChecked).toBe(0);
    expect((await prisma.seedPlacementResult.findUnique({ where: { id: legacy.id } }))?.checkedAt).toBeNull();
  });

  it('POST /poll runs the check and accepts the old { lookbackHours } body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/seed-placement/poll',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: { lookbackHours: 24 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ seedChecked: expect.any(Number), seedDropped: expect.any(Number) });
  }, 20_000);

  it('rejects a request with no callback secret', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/seed-placement/poll',
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });
});
