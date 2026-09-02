/**
 * Integration test for `/v1/campaigns` (list w/ aggregates, `GET /:id`, `POST /`, `PATCH /:id`,
 * `POST /:id/launch`, `POST /:id/pause`, `DELETE /:id`) against a REAL Postgres
 * (docker-compose.test.yml). Mirrors `seedPlacement.integration.test.ts`'s fixture style.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

describeIntegration('campaigns routes (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let authToken: string;

  let domainId: string;
  let mailboxId: string;
  const createdCampaignIds: string[] = [];

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

    const domain = await prisma.domain.create({
      data: { domainName: `campaigns-test-${Date.now()}.example.com` },
    });
    domainId = domain.id;

    const mailbox = await prisma.mailbox.create({
      data: { email: `campaigns-sender-${Date.now()}@example.com`, domainId },
    });
    mailboxId = mailbox.id;
  });

  afterAll(async () => {
    await prisma.executionLog.deleteMany({ where: { campaignId: { in: createdCampaignIds } } });
    await prisma.campaign.deleteMany({ where: { id: { in: createdCampaignIds } } });
    await prisma.mailbox.deleteMany({ where: { id: mailboxId } });
    await prisma.domain.deleteMany({ where: { id: domainId } });
    await app.close();
    await prisma.$disconnect();
  });

  it('creates a campaign with valid spintax content-quality metadata, and rejects a missing name / malformed spintax', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        name: 'Integration Test Campaign',
        aiPromptTemplate: '',
        template: 'Hi {there|friend}, quick question.',
      },
    });
    expect(created.statusCode).toBe(201);
    const json = created.json();
    createdCampaignIds.push(json.id);
    expect(json.contentQuality.spintaxGroupCount).toBe(1);
    expect(json.contentQuality.spamScore).toBeTruthy();

    const missingName = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { aiPromptTemplate: '' },
    });
    expect(missingName.statusCode).toBe(422);

    const badSpintax = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: 'Bad Spintax Campaign', aiPromptTemplate: '', template: '{unclosed|group' },
    });
    expect(badSpintax.statusCode).toBe(422);
  });

  it('lists campaigns with real send/reply/domain aggregates for one with actual activity', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Aggregates Test Campaign', status: 'ACTIVE', aiPromptTemplate: '' },
    });
    createdCampaignIds.push(campaign.id);

    const lead = await prisma.lead.create({
      data: { campaignId: campaign.id, email: `agg-lead-${Date.now()}@example.com`, status: 'CONTACTED' },
    });
    await prisma.executionLog.create({
      data: { campaignId: campaign.id, leadId: lead.id, mailboxId, status: 'SENT' },
    });
    await prisma.reply.create({
      data: {
        leadId: lead.id,
        campaignId: campaign.id,
        mailboxId,
        rawContent: 'thanks!',
        repliedAt: new Date(),
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/campaigns',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(response.statusCode).toBe(200);
    const found = response.json().find((c: { id: string }) => c.id === campaign.id);
    expect(found).toBeTruthy();
    expect(found.leadsCount).toBe(1);
    expect(found.repliesCount).toBe(1);
    expect(found.sentCount).toBe(1);
    expect(found.domainsCount).toBe(1);
    expect(found.lastActivityAt).not.toBeNull();
  });

  it('fetches a campaign by id and 404s an unknown id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/campaigns/${createdCampaignIds[0]}`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe(createdCampaignIds[0]);

    const notFound = await app.inject({
      method: 'GET',
      url: '/v1/campaigns/does-not-exist',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(notFound.statusCode).toBe(404);
  });

  it('patches a campaign template and re-evaluates content quality, and 404s an unknown id', async () => {
    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/campaigns/${createdCampaignIds[0]}`,
      headers: { authorization: `Bearer ${authToken}` },
      payload: { template: 'Updated {copy|text} here' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().contentQuality.spintaxGroupCount).toBe(1);

    const notFound = await app.inject({
      method: 'PATCH',
      url: '/v1/campaigns/does-not-exist',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: 'x' },
    });
    expect(notFound.statusCode).toBe(404);
  });

  it('refuses to launch without an unsubscribe template, then launches once one is set; pause works and 404s unknown', async () => {
    const id = createdCampaignIds[0];

    const refused = await app.inject({
      method: 'POST',
      url: `/v1/campaigns/${id}/launch`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(refused.statusCode).toBe(422);

    await prisma.campaign.update({
      where: { id },
      data: { unsubscribeUrlTemplate: 'https://example.org/unsub?email={{email}}' },
    });

    const launched = await app.inject({
      method: 'POST',
      url: `/v1/campaigns/${id}/launch`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(launched.statusCode).toBe(200);
    expect(launched.json().status).toBe('ACTIVE');

    const paused = await app.inject({
      method: 'POST',
      url: `/v1/campaigns/${id}/pause`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().status).toBe('PAUSED');

    const notFound = await app.inject({
      method: 'POST',
      url: '/v1/campaigns/does-not-exist/pause',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(notFound.statusCode).toBe(404);
  });

  it('refuses to launch a campaign paused for an elevated bounce rate', async () => {
    const campaign = await prisma.campaign.create({
      data: {
        name: 'Bounce-Paused Campaign',
        aiPromptTemplate: '',
        unsubscribeUrlTemplate: 'https://example.org/unsub',
        pausedForBounceRate: true,
      },
    });
    createdCampaignIds.push(campaign.id);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/campaigns/${campaign.id}/launch`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(response.statusCode).toBe(422);
  });

  it('archives a campaign via DELETE (soft-delete) and 404s deleting it again', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'To Be Archived', aiPromptTemplate: '' },
    });
    createdCampaignIds.push(campaign.id);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/campaigns/${campaign.id}`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(deleted.statusCode).toBe(204);

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.status).toBe('ARCHIVED');

    const again = await app.inject({
      method: 'DELETE',
      url: '/v1/campaigns/does-not-exist',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(again.statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/campaigns' });
    expect(response.statusCode).toBe(401);
  });
});
