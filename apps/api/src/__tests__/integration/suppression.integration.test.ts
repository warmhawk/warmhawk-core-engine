/**
 * Integration test for `/v1/suppression` (list, import, export, unblock) against a REAL Postgres
 * (docker-compose.test.yml). Every address carries a per-run tag so the list's other rows never
 * affect the counts asserted here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';
import { MAX_IMPORT } from '../../routes/suppression';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

describeIntegration('/v1/suppression routes (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let authToken: string;
  let campaignId: string;
  const tag = `supp-${Date.now()}`;
  const addr = (name: string) => `${name}-${tag}@example.org`;

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${authToken}` },
      payload: payload as object,
    });

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

    const campaign = await prisma.campaign.create({
      data: { name: `Suppression Test ${tag}`, status: 'ACTIVE', aiPromptTemplate: '' },
    });
    campaignId = campaign.id;
  });

  afterAll(async () => {
    await prisma.suppressionEntry.deleteMany({ where: { email: { contains: tag } } });
    await prisma.lead.deleteMany({ where: { campaignId } });
    await prisma.campaign.deleteMany({ where: { id: campaignId } });
    await app.close();
    await prisma.$disconnect();
  });

  it('requires auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/suppression' });
    expect(response.statusCode).toBe(401);
  });

  it('imports a list: normalizes, dedupes, counts bad lines, and stops leads already carrying an address', async () => {
    const lead = await prisma.lead.create({
      data: { campaignId, email: addr('in-campaign'), status: 'CONTACTED', nextStepAt: new Date() },
    });
    await prisma.suppressionEntry.create({
      data: { email: addr('already'), reason: 'clicked unsubscribe', source: 'unsubscribe_link' },
    });

    const response = await call('POST', '/v1/suppression/import', {
      emails: [
        `  ${addr('In-Campaign').toUpperCase()} `,
        addr('fresh'),
        addr('fresh'),
        addr('already'),
        'not an address',
        '',
      ],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ added: 2, alreadyBlocked: 1, invalid: 1 });

    const stopped = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(stopped.status).toBe('SUPPRESSED');
    expect(stopped.nextStepAt).toBeNull();

    const fresh = await prisma.suppressionEntry.findUniqueOrThrow({
      where: { email: addr('fresh') },
    });
    expect(fresh.source).toBe('import');
    // The earlier entry keeps how it got there.
    const already = await prisma.suppressionEntry.findUniqueOrThrow({
      where: { email: addr('already') },
    });
    expect(already.source).toBe('unsubscribe_link');
  });

  it('rejects an empty or oversized import', async () => {
    expect((await call('POST', '/v1/suppression/import', { emails: [] })).statusCode).toBe(422);
    expect((await call('POST', '/v1/suppression/import', {})).statusCode).toBe(422);
    const tooMany = Array.from({ length: MAX_IMPORT + 1 }, (_, i) => `x${i}@example.org`);
    expect((await call('POST', '/v1/suppression/import', { emails: tooMany })).statusCode).toBe(
      422,
    );
  });

  it('lists newest first, pages, and searches part of an address', async () => {
    const page = await call('GET', `/v1/suppression?q=${tag}&pageSize=2`);
    expect(page.statusCode).toBe(200);
    const json = page.json();
    expect(json.total).toBe(3);
    expect(json.pageSize).toBe(2);
    expect(json.entries).toHaveLength(2);
    const times = json.entries.map((e: { createdAt: string }) => Date.parse(e.createdAt));
    expect(times[0]).toBeGreaterThanOrEqual(times[1]);

    const search = await call('GET', `/v1/suppression?q=${encodeURIComponent(`FRESH-${tag}`)}`);
    expect(search.json().entries.map((e: { email: string }) => e.email)).toEqual([addr('fresh')]);

    expect((await call('GET', '/v1/suppression?page=0')).statusCode).toBe(400);
  });

  it('exports every entry', async () => {
    const response = await call('GET', '/v1/suppression/export');
    expect(response.statusCode).toBe(200);
    const emails = response.json().entries.map((e: { email: string }) => e.email);
    expect(emails).toEqual(
      expect.arrayContaining([addr('fresh'), addr('already'), addr('in-campaign')]),
    );
  });

  it('unblocks an address without restarting its lead, and 404s one that is not blocked', async () => {
    const response = await call('POST', '/v1/suppression/unblock', {
      email: ` ${addr('IN-CAMPAIGN')} `,
    });
    expect(response.statusCode).toBe(200);
    expect(
      await prisma.suppressionEntry.findUnique({ where: { email: addr('in-campaign') } }),
    ).toBeNull();
    const lead = await prisma.lead.findFirstOrThrow({
      where: { campaignId, email: addr('in-campaign') },
    });
    expect(lead.status).toBe('SUPPRESSED');

    expect(
      (await call('POST', '/v1/suppression/unblock', { email: addr('in-campaign') })).statusCode,
    ).toBe(404);
    expect((await call('POST', '/v1/suppression/unblock', {})).statusCode).toBe(422);
  });
});
