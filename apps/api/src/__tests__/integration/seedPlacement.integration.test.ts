/**
 * Seed-Inbox Placement Test (Guardrails, V12) — integration test for the aggregation endpoint,
 * `GET /domains/:id/placement-sample`, against a REAL Postgres (docker-compose.test.yml), per the
 * task requirement: "Unit tests for the folder-classification logic and the aggregation
 * endpoint." Mirrors `leadsImport.integration.test.ts`'s setup (real Prisma writes, JWT-signed
 * `app.inject()` calls, self-skips without DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';
import { encryptSeedImapConfig } from '../../lib/seedAccounts';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

describeIntegration('GET /domains/:id/placement-sample (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let authToken: string;

  let domainId: string;
  let mailboxId: string;
  let campaignId: string;
  let seedAccountId: string;
  let otherDomainId: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-not-a-real-secret-value';
    process.env.MAILBOX_CREDENTIAL_KEY =
      process.env.MAILBOX_CREDENTIAL_KEY || Buffer.from('b'.repeat(32)).toString('base64');
    app = await createApp();
    await app.ready();

    const jwt = await import('jsonwebtoken');
    authToken = jwt.default.sign(
      { sub: 'test-user', email: 'test@example.com', role: 'ADMIN' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' },
    );

    const domain = await prisma.domain.create({
      data: { domainName: `placement-sample-test-${Date.now()}.example.com` },
    });
    domainId = domain.id;

    const otherDomain = await prisma.domain.create({
      data: { domainName: `placement-sample-other-${Date.now()}.example.com` },
    });
    otherDomainId = otherDomain.id;

    const mailbox = await prisma.mailbox.create({
      data: { email: `sender-${Date.now()}@example.com`, domainId },
    });
    mailboxId = mailbox.id;

    const campaign = await prisma.campaign.create({
      data: { name: 'Placement Sample Test Campaign', status: 'ACTIVE', aiPromptTemplate: '' },
    });
    campaignId = campaign.id;

    const lead = await prisma.lead.create({
      data: { campaignId, email: `lead-${Date.now()}@example.com`, status: 'CONTACTED' },
    });

    // A real send this domain's mailbox made — the aggregation endpoint's join path.
    await prisma.executionLog.create({
      data: { campaignId, leadId: lead.id, mailboxId, status: 'SENT' },
    });

    const seedAccount = await prisma.seedAccount.create({
      data: {
        provider: 'GMAIL',
        emailAddress: `seed-${Date.now()}@example.com`,
        imapConfigEncrypted: encryptSeedImapConfig({
          host: 'imap.example.com',
          port: 993,
          username: 'seed',
          password: 'pw',
        }),
      },
    });
    seedAccountId = seedAccount.id;

    await prisma.seedPlacementResult.createMany({
      data: [
        { campaignId, seedAccountId, folder: 'INBOX' },
        { campaignId, seedAccountId, folder: 'SPAM' },
        { campaignId, seedAccountId, folder: 'PROMOTIONS' },
      ],
    });
  });

  afterAll(async () => {
    await prisma.seedPlacementResult.deleteMany({ where: { campaignId } }).catch(() => undefined);
    await prisma.seedAccount.delete({ where: { id: seedAccountId } }).catch(() => undefined);
    await prisma.executionLog.deleteMany({ where: { campaignId } }).catch(() => undefined);
    await prisma.lead.deleteMany({ where: { campaignId } }).catch(() => undefined);
    await prisma.campaign.delete({ where: { id: campaignId } }).catch(() => undefined);
    await prisma.mailbox.delete({ where: { id: mailboxId } }).catch(() => undefined);
    await prisma.domain.delete({ where: { id: domainId } }).catch(() => undefined);
    await prisma.domain.delete({ where: { id: otherDomainId } }).catch(() => undefined);
    await app.close();
    await prisma.$disconnect();
  });

  it('aggregates placement-sample results for a domain, honestly labeled', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/domains/${domainId}/placement-sample`,
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();

    expect(json.domainId).toBe(domainId);
    expect(json.totalChecks).toBe(3);
    expect(json.byFolder).toEqual({ INBOX: 1, SPAM: 1, PROMOTIONS: 1, UNCLASSIFIED: 0 });
    expect(json.sampledSeedAccountCount).toBe(1);
    expect(json.inboxPlacementRate).toBeCloseTo(1 / 3);
    expect(json.label).toMatch(/placement sampling across 1 seed inbox/i);
    expect(json.label).toMatch(/not full inbox-placement testing/i);
    expect(json.results).toHaveLength(3);
  });

  it('returns all-zero aggregation for a domain with no sends yet, not an error', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/domains/${otherDomainId}/placement-sample`,
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.totalChecks).toBe(0);
    expect(json.sampledSeedAccountCount).toBe(0);
    expect(json.inboxPlacementRate).toBeNull();
    expect(json.results).toHaveLength(0);
  });

  it('404s for a domain that does not exist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/domains/does-not-exist/placement-sample',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/domains/${domainId}/placement-sample`,
    });
    expect(response.statusCode).toBe(401);
  });
});
