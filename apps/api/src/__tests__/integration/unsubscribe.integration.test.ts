/**
 * Integration test for the built-in unsubscribe page (`GET`/`POST /unsubscribe/:token`) against a
 * REAL Postgres (docker-compose.test.yml). No auth header anywhere: the signed token is the whole
 * request.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';
import { signUnsubscribeToken } from '../../lib/unsubscribeToken';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

describeIntegration('unsubscribe page (integration, real Postgres)', () => {
  let app: FastifyInstance;
  const campaignIds: string[] = [];
  const emails: string[] = [];
  const stamp = Date.now();

  async function createLead(
    campaignId: string,
    email: string,
    status: 'UNTOUCHED' | 'CONTACTED' | 'QUEUED',
  ) {
    if (!emails.includes(email)) emails.push(email);
    return prisma.lead.create({
      data: {
        campaignId,
        email,
        status,
        ...(status === 'QUEUED' ? { nextRetryAt: new Date(Date.now() + 60_000) } : {}),
      },
    });
  }

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-not-a-real-secret-value';
    app = await createApp();
    await app.ready();

    for (const name of ['Unsubscribe Test A', 'Unsubscribe Test B']) {
      const campaign = await prisma.campaign.create({ data: { name, aiPromptTemplate: '' } });
      campaignIds.push(campaign.id);
    }
  });

  afterAll(async () => {
    await prisma.lead.deleteMany({ where: { campaignId: { in: campaignIds } } });
    await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
    await prisma.suppressionEntry.deleteMany({ where: { email: { in: emails } } });
    await app.close();
    await prisma.$disconnect();
  });

  it('GET shows the address and a button, and changes nothing', async () => {
    const email = `unsub-get-${stamp}@acme.example`;
    const lead = await createLead(campaignIds[0], email, 'CONTACTED');

    const response = await app.inject({
      method: 'GET',
      url: `/unsubscribe/${signUnsubscribeToken(lead.id)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-robots-tag']).toBe('noindex');
    expect(response.body).toContain(email);
    expect(response.body).toContain('<form method="post">');

    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe(
      'CONTACTED',
    );
    expect(await prisma.suppressionEntry.findUnique({ where: { email } })).toBeNull();
  });

  it('POST from the page button suppresses the address in every campaign it sits in', async () => {
    const email = `unsub-post-${stamp}@acme.example`;
    const contacted = await createLead(campaignIds[0], email, 'CONTACTED');
    const waiting = await createLead(campaignIds[1], email, 'QUEUED');
    const token = signUnsubscribeToken(contacted.id);

    const response = await app.inject({
      method: 'POST',
      url: `/unsubscribe/${token}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('You are unsubscribed');
    expect(response.body).toContain(email);

    const entry = await prisma.suppressionEntry.findUniqueOrThrow({ where: { email } });
    expect(entry.source).toBe('unsubscribe_link');

    const [first, second] = await Promise.all([
      prisma.lead.findUniqueOrThrow({ where: { id: contacted.id } }),
      prisma.lead.findUniqueOrThrow({ where: { id: waiting.id } }),
    ]);
    expect(first.status).toBe('SUPPRESSED');
    expect(second.status).toBe('SUPPRESSED');
    expect(second.nextRetryAt).toBeNull();

    // The link keeps working: a second click and a later visit both say it's done.
    const again = await app.inject({ method: 'POST', url: `/unsubscribe/${token}` });
    expect(again.statusCode).toBe(200);
    const revisit = await app.inject({ method: 'GET', url: `/unsubscribe/${token}` });
    expect(revisit.body).toContain('You are unsubscribed');
    expect(revisit.body).not.toContain('<form');
    expect(await prisma.suppressionEntry.count({ where: { email } })).toBe(1);
  });

  it.each([
    ['form-encoded', 'application/x-www-form-urlencoded', 'List-Unsubscribe=One-Click'],
    [
      'multipart',
      'multipart/form-data; boundary=x',
      '--x\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--x--\r\n',
    ],
  ])("takes a mailbox provider's one-click POST (%s)", async (label, contentType, payload) => {
    const email = `unsub-oneclick-${label}-${stamp}@acme.example`;
    const lead = await createLead(campaignIds[0], email, 'CONTACTED');

    const response = await app.inject({
      method: 'POST',
      url: `/unsubscribe/${signUnsubscribeToken(lead.id)}`,
      headers: { 'content-type': contentType },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe(
      'SUPPRESSED',
    );
    expect(await prisma.suppressionEntry.findUnique({ where: { email } })).toBeTruthy();
  });

  it('404s a forged or malformed token on both methods, and suppresses nothing', async () => {
    const email = `unsub-forged-${stamp}@acme.example`;
    const lead = await createLead(campaignIds[0], email, 'CONTACTED');
    const forged = `${lead.id}.AAAAAAAAAAAAAAAAAAAAAA`;

    for (const url of [
      `/unsubscribe/${forged}`,
      '/unsubscribe/not-a-token',
      `/unsubscribe/${lead.id}`,
    ]) {
      for (const method of ['GET', 'POST'] as const) {
        const response = await app.inject({ method, url });
        expect(response.statusCode).toBe(404);
        expect(response.body).not.toContain(email);
      }
    }

    // A real signature for a lead that no longer exists.
    const gone = await app.inject({
      method: 'GET',
      url: `/unsubscribe/${signUnsubscribeToken('clead-that-was-deleted')}`,
    });
    expect(gone.statusCode).toBe(404);

    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe(
      'CONTACTED',
    );
    expect(await prisma.suppressionEntry.findUnique({ where: { email } })).toBeNull();
  });

  it('treats an erased lead as already unsubscribed, without showing or storing its placeholder', async () => {
    const placeholder = `erased-${stamp}@erased.invalid`;
    const lead = await createLead(campaignIds[0], placeholder, 'CONTACTED');
    await prisma.lead.update({ where: { id: lead.id }, data: { piiErasedAt: new Date() } });
    const token = signUnsubscribeToken(lead.id);

    for (const method of ['GET', 'POST'] as const) {
      const response = await app.inject({ method, url: `/unsubscribe/${token}` });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('You are unsubscribed');
      expect(response.body).not.toContain(placeholder);
    }
    expect(await prisma.suppressionEntry.findUnique({ where: { email: placeholder } })).toBeNull();
  });
});
