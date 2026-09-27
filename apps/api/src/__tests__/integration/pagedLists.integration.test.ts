/**
 * Integration test for the dashboard's paged lists against a REAL Postgres: `GET /v1/leads`,
 * `GET /v1/replies`, `GET /v1/warmup/:mailboxId/messages`, and the database-counted
 * `GET /v1/domains/:id/placement-sample`. Every query is scoped to this file's own campaign /
 * mailbox / domain so rows left by other suites never change the counts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

const HOUR = 3_600_000;

describeIntegration('paged dashboard lists (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let authToken: string;
  const stamp = Date.now();

  let domainId: string;
  let otherDomainId: string;
  let mailboxId: string;
  let otherMailboxId: string;
  let campaignId: string;
  let otherCampaignId: string;
  let seedAccountId: string;

  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${authToken}` } });

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

    domainId = (await prisma.domain.create({ data: { domainName: `paged-${stamp}.example.com` } })).id;
    otherDomainId = (await prisma.domain.create({ data: { domainName: `paged-other-${stamp}.example.com` } })).id;
    mailboxId = (await prisma.mailbox.create({ data: { email: `paged-${stamp}@example.com`, domainId } })).id;
    otherMailboxId = (
      await prisma.mailbox.create({ data: { email: `paged-other-${stamp}@example.com`, domainId: otherDomainId } })
    ).id;
    campaignId = (await prisma.campaign.create({ data: { name: `Paged A ${stamp}`, aiPromptTemplate: '' } })).id;
    otherCampaignId = (await prisma.campaign.create({ data: { name: `Paged B ${stamp}`, aiPromptTemplate: '' } })).id;
    seedAccountId = (
      await prisma.seedAccount.create({
        data: {
          emailAddress: `paged-seed-${stamp}@example.com`,
          provider: 'ZOHO',
          imapConfigEncrypted: 'not-read-by-this-test',
          isActive: false,
        },
      })
    ).id;

    // 30 leads in campaign A, created one minute apart: lead-00 oldest … lead-29 newest.
    // Every 10th is SUPPRESSED; lead-07 is the only one at "Acme Corp".
    const base = Date.now() - 60 * 60_000;
    await prisma.lead.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        campaignId,
        email: `lead-${String(i).padStart(2, '0')}-${stamp}@example.com`,
        firstName: `Lead${String(i).padStart(2, '0')}`,
        company: i === 7 ? 'Acme Corp' : `Company ${i}`,
        status: i % 10 === 0 ? ('SUPPRESSED' as const) : ('UNTOUCHED' as const),
        createdAt: new Date(base + i * 60_000),
      })),
    });
    await prisma.lead.create({ data: { campaignId: otherCampaignId, email: `other-${stamp}@example.com` } });

    // 12 replies on mailbox A (3 INTERESTED), 2 on mailbox B (other domain).
    const leadId = (await prisma.lead.findFirstOrThrow({ where: { campaignId } })).id;
    await prisma.reply.createMany({
      data: [
        ...Array.from({ length: 12 }, (_, i) => ({
          leadId,
          campaignId,
          mailboxId,
          rawContent: `reply ${i}`,
          classification: i < 3 ? ('INTERESTED' as const) : ('AUTO_REPLY' as const),
          repliedAt: new Date(base + i * 60_000),
        })),
        ...Array.from({ length: 2 }, (_, i) => ({
          leadId,
          campaignId,
          mailboxId: otherMailboxId,
          rawContent: `other ${i}`,
          repliedAt: new Date(base + i * 60_000),
        })),
      ],
    });

    // Warmup send log for mailbox A: 8 inbox (last 2 hours), 3 spam of which 2 were moved back,
    // 1 missing and 1 failed from 3 days ago, 2 inbox from 10 days ago.
    const now = Date.now();
    const msg = (placement: 'INBOX' | 'SPAM' | 'MISSING' | 'FAILED', agoMs: number, rescued = false) => ({
      senderMailboxId: mailboxId,
      recipientEmail: 'partner@example.com',
      subject: `${placement} ${agoMs}`,
      placement,
      rescued,
      sentAt: new Date(now - agoMs),
    });
    await prisma.warmupMessage.createMany({
      data: [
        ...Array.from({ length: 8 }, (_, i) => msg('INBOX', (i + 1) * 10 * 60_000)),
        msg('SPAM', 3 * HOUR, true),
        msg('SPAM', 4 * HOUR, true),
        msg('SPAM', 5 * HOUR),
        msg('MISSING', 72 * HOUR),
        msg('FAILED', 73 * HOUR),
        msg('INBOX', 240 * HOUR),
        msg('INBOX', 241 * HOUR),
      ],
    });

    // Placement sample for domain A: 3 INBOX + 2 SPAM checked, 1 pending (not counted); one on
    // domain B (not counted).
    const placement = (folder: 'INBOX' | 'SPAM', mb: string, checked = true) => ({
      seedAccountId,
      campaignId,
      mailboxId: mb,
      folder,
      sentAt: new Date(now - HOUR),
      checkedAt: checked ? new Date(now - HOUR + 60_000) : null,
    });
    await prisma.seedPlacementResult.createMany({
      data: [
        placement('INBOX', mailboxId),
        placement('INBOX', mailboxId),
        placement('INBOX', mailboxId),
        placement('SPAM', mailboxId),
        placement('SPAM', mailboxId),
        placement('INBOX', mailboxId, false),
        placement('SPAM', otherMailboxId),
      ],
    });
  });

  afterAll(async () => {
    await prisma.seedPlacementResult.deleteMany({ where: { seedAccountId } });
    await prisma.seedAccount.deleteMany({ where: { id: seedAccountId } });
    await prisma.reply.deleteMany({ where: { campaignId: { in: [campaignId, otherCampaignId] } } });
    await prisma.lead.deleteMany({ where: { campaignId: { in: [campaignId, otherCampaignId] } } });
    await prisma.campaign.deleteMany({ where: { id: { in: [campaignId, otherCampaignId] } } });
    await prisma.mailbox.deleteMany({ where: { id: { in: [mailboxId, otherMailboxId] } } });
    await prisma.domain.deleteMany({ where: { id: { in: [domainId, otherDomainId] } } });
    await app.close();
    await prisma.$disconnect();
  });

  describe('GET /v1/leads', () => {
    it('pages newest first and reports the filtered total and every status count', async () => {
      const res = await get(`/v1/leads?campaignId=${campaignId}&page=2&pageSize=10`);
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.total).toBe(30);
      expect(json.page).toBe(2);
      expect(json.pageSize).toBe(10);
      expect(json.leads).toHaveLength(10);
      expect(json.leads[0].firstName).toBe('Lead19');
      expect(json.leads[9].firstName).toBe('Lead10');
      expect(json.statusCounts).toMatchObject({ UNTOUCHED: 27, SUPPRESSED: 3, QUEUED: 0 });
    });

    it('returns the last partial page, and an empty page past the end', async () => {
      const last = (await get(`/v1/leads?campaignId=${campaignId}&page=4&pageSize=8`)).json();
      expect(last.leads.map((l: { firstName: string }) => l.firstName)).toEqual([
        'Lead05',
        'Lead04',
        'Lead03',
        'Lead02',
        'Lead01',
        'Lead00',
      ]);
      const past = (await get(`/v1/leads?campaignId=${campaignId}&page=9&pageSize=8`)).json();
      expect(past.leads).toEqual([]);
      expect(past.total).toBe(30);
    });

    it('filters by status and searches company case-insensitively in the database', async () => {
      const suppressed = (await get(`/v1/leads?campaignId=${campaignId}&page=1&status=SUPPRESSED`)).json();
      expect(suppressed.total).toBe(3);
      expect(suppressed.leads.every((l: { status: string }) => l.status === 'SUPPRESSED')).toBe(true);
      // Status chips count every lead, not just the filtered ones.
      expect(suppressed.statusCounts.UNTOUCHED).toBe(27);

      const search = (await get(`/v1/leads?campaignId=${campaignId}&page=1&q=aCmE`)).json();
      expect(search.total).toBe(1);
      expect(search.leads[0].firstName).toBe('Lead07');
    });

    it('sorts by status in pipeline order and by email ascending', async () => {
      const byStatus = (await get(`/v1/leads?campaignId=${campaignId}&page=1&pageSize=30&sort=status&dir=desc`)).json();
      expect(byStatus.leads.slice(0, 3).every((l: { status: string }) => l.status === 'SUPPRESSED')).toBe(true);
      const byEmail = (await get(`/v1/leads?campaignId=${campaignId}&page=1&pageSize=2&sort=email`)).json();
      expect(byEmail.leads.map((l: { firstName: string }) => l.firstName)).toEqual(['Lead00', 'Lead01']);
    });

    it('still returns every lead without paging params, for older dashboards', async () => {
      const json = (await get(`/v1/leads?campaignId=${campaignId}`)).json();
      expect(json.leads).toHaveLength(30);
      expect(json.total).toBe(30);
      expect(json.page).toBeUndefined();
    });

    it('rejects bad paging, status and sort values with 400', async () => {
      for (const qs of ['page=0', 'page=abc', 'pageSize=-1', 'page=1&status=NEW', 'page=1&sort=zip', 'page=1&dir=up']) {
        expect((await get(`/v1/leads?${qs}`)).statusCode).toBe(400);
      }
    });

    it('caps pageSize at 100', async () => {
      const json = (await get(`/v1/leads?campaignId=${campaignId}&page=1&pageSize=5000`)).json();
      expect(json.pageSize).toBe(100);
    });
  });

  describe('GET /v1/replies', () => {
    it('pages newest first with a total', async () => {
      const json = (await get(`/v1/replies?mailboxId=${mailboxId}&page=2&pageSize=5`)).json();
      expect(json.total).toBe(12);
      expect(json.replies).toHaveLength(5);
      expect(json.replies[0].rawContent).toBe('reply 6');
      expect(json.replies[0].mailbox.domain.domainName).toBe(`paged-${stamp}.example.com`);
    });

    it('filters by domain and classification', async () => {
      const byDomain = (await get(`/v1/replies?campaignId=${campaignId}&domainId=${otherDomainId}&page=1`)).json();
      expect(byDomain.total).toBe(2);
      const interested = (
        await get(`/v1/replies?campaignId=${campaignId}&domainId=${domainId}&classification=INTERESTED&page=1`)
      ).json();
      expect(interested.total).toBe(3);
    });

    it('keeps the plain array without paging params, and rejects a bad classification', async () => {
      const json = (await get(`/v1/replies?campaignId=${campaignId}`)).json();
      expect(Array.isArray(json)).toBe(true);
      expect(json).toHaveLength(14);
      expect((await get('/v1/replies?classification=MAYBE')).statusCode).toBe(400);
    });
  });

  describe('GET /v1/warmup/:mailboxId/messages', () => {
    const url = (qs: string) => `/v1/warmup/${mailboxId}/messages?${qs}`;

    it('pages the send log newest first', async () => {
      // The 8 recent inbox emails fill page 1; page 2 starts at the newest spam.
      const json = (await get(url('page=2&pageSize=8'))).json();
      expect(json.total).toBe(15);
      expect(json.messages).toHaveLength(7);
      expect(json.messages[0].placement).toBe('SPAM');
      expect(json.messages[0].rescued).toBe(true);
    });

    it('filters by result', async () => {
      const count = async (result: string) => (await get(url(`page=1&result=${result}`))).json().total;
      expect(await count('inbox')).toBe(10);
      expect(await count('spam')).toBe(3);
      expect(await count('moved')).toBe(2);
      expect(await count('missing')).toBe(1);
      expect(await count('failed')).toBe(1);
      expect(await count('pending')).toBe(0);
    });

    it('filters by period, and combines it with result', async () => {
      const count = async (qs: string) => (await get(url(`page=1&${qs}`))).json().total;
      expect(await count('period=24h')).toBe(11);
      expect(await count('period=7d')).toBe(13);
      expect(await count('period=30d')).toBe(15);
      expect(await count('period=all')).toBe(15);
      expect(await count('period=7d&result=inbox')).toBe(8);
    });

    it('keeps the last-50 default without paging params', async () => {
      const json = (await get(`/v1/warmup/${mailboxId}/messages`)).json();
      expect(json.pageSize).toBe(50);
      expect(json.messages).toHaveLength(15);
    });

    it('rejects bad filters with 400 and an unknown mailbox with 404', async () => {
      expect((await get(url('result=junk'))).statusCode).toBe(400);
      expect((await get(url('period=1y'))).statusCode).toBe(400);
      expect((await get(url('page=0'))).statusCode).toBe(400);
      expect((await get('/v1/warmup/nope/messages?page=1')).statusCode).toBe(404);
    });
  });

  describe('GET /v1/domains/:id/placement-sample', () => {
    it('counts checked copies for this domain in the database', async () => {
      const json = (await get(`/v1/domains/${domainId}/placement-sample`)).json();
      expect(json.totalChecks).toBe(5);
      expect(json.byFolder).toEqual({ INBOX: 3, SPAM: 2, PROMOTIONS: 0, UNCLASSIFIED: 0 });
      expect(json.inboxPlacementRate).toBeCloseTo(0.6);
      expect(json.sampledSeedAccountCount).toBe(1);
      expect(json.results).toHaveLength(5);
    });
  });

  it('requires authentication on every list', async () => {
    for (const url of ['/v1/leads?page=1', '/v1/replies?page=1', `/v1/warmup/${mailboxId}/messages`]) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
  });
});
