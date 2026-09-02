/**
 * Integration test for `/v1/replies` (`GET /`, `PATCH /:id`) against a REAL Postgres
 * (docker-compose.test.yml). Mirrors `seedPlacement.integration.test.ts`'s fixture style (real
 * Prisma writes for domain/mailbox/campaign/lead, JWT-signed `app.inject()` calls).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

describeIntegration('replies routes (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let authToken: string;

  let domainId: string;
  let domainName: string;
  let mailboxId: string;
  let campaignId: string;
  let leadId: string;
  let replyInterestedId: string;
  let replyUnclassifiedId: string;

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

    domainName = `replies-test-${Date.now()}.example.com`;
    const domain = await prisma.domain.create({ data: { domainName } });
    domainId = domain.id;

    const mailbox = await prisma.mailbox.create({
      data: { email: `replies-sender-${Date.now()}@example.com`, domainId },
    });
    mailboxId = mailbox.id;

    const campaign = await prisma.campaign.create({
      data: { name: 'Replies Test Campaign', status: 'ACTIVE', aiPromptTemplate: '' },
    });
    campaignId = campaign.id;

    const lead = await prisma.lead.create({
      data: { campaignId, email: `replies-lead-${Date.now()}@example.com`, status: 'REPLIED' },
    });
    leadId = lead.id;

    const interested = await prisma.reply.create({
      data: {
        leadId,
        campaignId,
        mailboxId,
        rawContent: 'Sure, tell me more!',
        classification: 'INTERESTED',
        repliedAt: new Date(),
      },
    });
    replyInterestedId = interested.id;

    const unclassified = await prisma.reply.create({
      data: {
        leadId,
        campaignId,
        mailboxId,
        rawContent: 'huh?',
        repliedAt: new Date(),
      },
    });
    replyUnclassifiedId = unclassified.id;
  });

  afterAll(async () => {
    await prisma.reply.deleteMany({ where: { campaignId } });
    await prisma.lead.deleteMany({ where: { campaignId } });
    await prisma.campaign.deleteMany({ where: { id: campaignId } });
    await prisma.mailbox.deleteMany({ where: { id: mailboxId } });
    await prisma.domain.deleteMany({ where: { id: domainId } });
    await app.close();
    await prisma.$disconnect();
  });

  it('lists replies, filterable by campaignId and classification', async () => {
    const byCampaign = await app.inject({
      method: 'GET',
      url: `/v1/replies?campaignId=${campaignId}`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(byCampaign.statusCode).toBe(200);
    const allJson = byCampaign.json();
    expect(allJson).toHaveLength(2);
    expect(allJson[0].mailbox.domain.domainName).toBe(domainName);

    const byClassification = await app.inject({
      method: 'GET',
      url: `/v1/replies?campaignId=${campaignId}&classification=INTERESTED`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    const filteredJson = byClassification.json();
    expect(filteredJson).toHaveLength(1);
    expect(filteredJson[0].id).toBe(replyInterestedId);
  });

  it('updates a reply classification via PATCH, requires the field, and 404s an unknown id', async () => {
    const success = await app.inject({
      method: 'PATCH',
      url: `/v1/replies/${replyUnclassifiedId}`,
      headers: { authorization: `Bearer ${authToken}` },
      payload: { classification: 'NOT_INTERESTED' },
    });
    expect(success.statusCode).toBe(200);
    const json = success.json();
    expect(json.classification).toBe('NOT_INTERESTED');
    expect(json.classifiedAt).not.toBeNull();

    const missingField = await app.inject({
      method: 'PATCH',
      url: `/v1/replies/${replyUnclassifiedId}`,
      headers: { authorization: `Bearer ${authToken}` },
      payload: {},
    });
    expect(missingField.statusCode).toBe(422);

    const notFound = await app.inject({
      method: 'PATCH',
      url: '/v1/replies/does-not-exist',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { classification: 'OPT_OUT' },
    });
    expect(notFound.statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/replies' });
    expect(response.statusCode).toBe(401);
  });
});
