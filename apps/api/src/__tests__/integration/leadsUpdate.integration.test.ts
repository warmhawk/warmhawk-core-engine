/**
 * Integration test for `PATCH /leads/:id` against a REAL Postgres — the dashboard's Edit lead
 * action. Skipped automatically when DATABASE_URL isn't set, like the other integration files.
 * Fixtures use `@example.org` because `example.com` is on `BLOCKED_EMAIL_DOMAINS`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

describeIntegration('PATCH /leads/:id (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let campaignId: string;
  let authToken: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-not-a-real-secret-value';
    app = await createApp();
    await app.ready();

    const campaign = await prisma.campaign.create({
      data: { name: 'Lead Edit Test Campaign', status: 'DRAFT', aiPromptTemplate: '' },
    });
    campaignId = campaign.id;

    const jwt = await import('jsonwebtoken');
    authToken = jwt.default.sign(
      { sub: 'test-user', email: 'test@example.org', role: 'ADMIN' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' },
    );
  });

  afterAll(async () => {
    await prisma.campaign.delete({ where: { id: campaignId } }).catch(() => undefined);
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.lead.deleteMany({ where: { campaignId } });
    await prisma.suppressionEntry.deleteMany({ where: { email: 'blocked@example.org' } });
  });

  function patch(id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'PATCH',
      url: `/v1/leads/${id}`,
      headers: { authorization: `Bearer ${authToken}` },
      payload,
    });
  }

  it('fixes a broken address and merge fields, keeping the lead and its place in the send order', async () => {
    const lead = await prisma.lead.create({
      data: {
        campaignId,
        email: '%20info@example.org',
        company: 'Acme',
        customFields: { body: 'old body', followup1: 'old follow-up' },
        status: 'UNTOUCHED',
      },
    });

    const response = await patch(lead.id, {
      email: 'Info@Example.org ',
      firstName: 'Ana',
      customFields: { body: 'new body', followup1: 'old follow-up' },
    });

    expect(response.statusCode).toBe(200);
    const updated = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(updated.email).toBe('info@example.org');
    expect(updated.firstName).toBe('Ana');
    expect(updated.company).toBe('Acme');
    expect(updated.customFields).toEqual({ body: 'new body', followup1: 'old follow-up' });
    expect(updated.createdAt).toEqual(lead.createdAt);
  });

  it('rejects an invalid address with 422', async () => {
    const lead = await prisma.lead.create({
      data: { campaignId, email: 'ok@example.org', status: 'UNTOUCHED' },
    });
    const response = await patch(lead.id, { email: 'not an email' });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('invalid_email');
  });

  it('rejects an address already in this campaign or on the suppression list with 409', async () => {
    await prisma.lead.create({
      data: { campaignId, email: 'taken@example.org', status: 'UNTOUCHED' },
    });
    await prisma.suppressionEntry.create({
      data: { email: 'blocked@example.org', reason: 'test fixture', source: 'manual' },
    });
    const lead = await prisma.lead.create({
      data: { campaignId, email: 'me@example.org', status: 'UNTOUCHED' },
    });

    expect((await patch(lead.id, { email: 'taken@example.org' })).statusCode).toBe(409);
    expect((await patch(lead.id, { email: 'blocked@example.org' })).statusCode).toBe(409);
    const unchanged = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(unchanged.email).toBe('me@example.org');
  });

  it('refuses to edit a lead that has already been emailed', async () => {
    const lead = await prisma.lead.create({
      data: { campaignId, email: 'sent@example.org', status: 'CONTACTED' },
    });
    const response = await patch(lead.id, { firstName: 'Late' });
    expect(response.statusCode).toBe(409);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).firstName).toBeNull();
  });

  it('returns 404 for an unknown lead', async () => {
    expect((await patch('does-not-exist', { firstName: 'X' })).statusCode).toBe(404);
  });
});
