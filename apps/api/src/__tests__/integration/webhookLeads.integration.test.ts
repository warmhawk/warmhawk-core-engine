/**
 * Integration test for `POST /v1/leads/webhook` against a REAL Postgres (docker-compose.test.yml).
 * This route is deliberately UNAUTHENTICATED (webhook ingest — an external form/CRM posts here
 * directly, with no way to obtain this engine's dashboard JWT or the internal callback secret;
 * confirmed by reading `routes/webhookLeads.ts`, which registers no `requireAuth`/
 * `requireCallbackSecret` preHandler at all), so this file explicitly asserts requests succeed
 * with zero auth headers rather than assuming a 401.
 *
 * Fixture domain note (same as `leadsImport.integration.test.ts`): uses `@example.org`, not
 * `@example.com` — `example.com` is on `leadIngest.ts`'s `BLOCKED_EMAIL_DOMAINS` list.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

describeIntegration('POST /leads/webhook (integration, real Postgres, no auth)', () => {
  let app: FastifyInstance;
  let campaignId: string;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();

    const campaign = await prisma.campaign.create({
      data: { name: 'Webhook Ingest Test Campaign', status: 'ACTIVE', aiPromptTemplate: '' },
    });
    campaignId = campaign.id;
  });

  afterAll(async () => {
    await prisma.lead.deleteMany({ where: { campaignId } });
    await prisma.suppressionEntry.deleteMany({ where: { email: 'webhook-suppressed@example.org' } });
    await prisma.campaign.deleteMany({ where: { id: campaignId } });
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.lead.deleteMany({ where: { campaignId } });
  });

  it('ingests a valid lead with no Authorization header at all', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/leads/webhook',
      payload: { campaignId, email: 'webhook-lead@example.org', firstName: 'Web', company: 'Hook Inc' },
    });

    expect(response.statusCode).toBe(201);
    const json = response.json();
    expect(json.status).toBe('queued');
    expect(json.leadId).toBeTruthy();

    const lead = await prisma.lead.findUnique({ where: { id: json.leadId } });
    expect(lead?.email).toBe('webhook-lead@example.org');
    expect(lead?.status).toBe('UNTOUCHED');
  });

  it('skips a suppressed email without creating a lead', async () => {
    await prisma.suppressionEntry.create({
      data: { email: 'webhook-suppressed@example.org', reason: 'test fixture', source: 'manual' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/leads/webhook',
      payload: { campaignId, email: 'webhook-suppressed@example.org' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'skipped', reason: 'suppressed' });
    const lead = await prisma.lead.findFirst({
      where: { campaignId, email: 'webhook-suppressed@example.org' },
    });
    expect(lead).toBeNull();
  });

  it('skips a duplicate lead already present for the same campaign', async () => {
    await prisma.lead.create({
      data: { campaignId, email: 'webhook-dup@example.org', status: 'UNTOUCHED' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/leads/webhook',
      payload: { campaignId, email: 'webhook-dup@example.org' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'skipped', reason: 'duplicate' });
  });

  it('rejects an invalid email with a 422 and a machine-readable reason', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/leads/webhook',
      payload: { campaignId, email: 'not-an-email' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ status: 'rejected', reason: 'invalid_email' });
  });

  it('rejects a payload missing campaignId', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/leads/webhook',
      payload: { email: 'no-campaign@example.org' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ status: 'rejected', reason: 'missing_campaign_id' });
  });
});
