/**
 * Integration test for `POST /internal/domains/notify-changes` against a REAL Postgres
 * (docker-compose.test.yml). Split out of `internalDomains.integration.test.ts` rather than added
 * there, since `lib/alertWebhook.ts#postDomainChangeAlert` is mocked module-wide for this file
 * (asserting how many times it fires, not exercising a real webhook POST) — mixing that mock into
 * the existing file would also silently mock it for that file's own (unrelated) tests.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@warmhawk/db';

vi.mock('../../lib/alertWebhook', () => ({
  postDomainChangeAlert: vi.fn().mockResolvedValue(undefined),
}));

// Imported after the mock above so `internalDomains.ts`'s own import of `alertWebhook.ts`
// resolves to the mock (vi.mock is hoisted above imports by Vitest, but importing the mocked
// module itself here, for assertions, reads more clearly placed after the mock call).
import { createApp } from '../../app';
import * as alertWebhook from '../../lib/alertWebhook';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;
const CALLBACK_SECRET = process.env.NEXTJS_CALLBACK_SECRET || 'test-only-callback-secret';

describeIntegration('POST /internal/domains/notify-changes (integration, real Postgres)', () => {
  let app: FastifyInstance;
  const domainIds: string[] = [];

  beforeAll(async () => {
    process.env.NEXTJS_CALLBACK_SECRET = CALLBACK_SECRET;
    app = await createApp();
    await app.ready();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await prisma.domainCheckHistory.deleteMany({ where: { domainId: { in: domainIds } } });
    await prisma.domain.deleteMany({ where: { id: { in: domainIds } } });
    await app.close();
    await prisma.$disconnect();
  });

  async function makeDomain(): Promise<string> {
    const domain = await prisma.domain.create({
      data: { domainName: `notify-changes-test-${Date.now()}-${Math.random()}.example.com` },
    });
    domainIds.push(domain.id);
    return domain.id;
  }

  it('rejects a request with no callback secret', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/domains/notify-changes',
      payload: { domainId: 'does-not-matter' },
    });
    expect(response.statusCode).toBe(401);
    expect(alertWebhook.postDomainChangeAlert).not.toHaveBeenCalled();
  });

  it('rejects a request with the wrong callback secret', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/domains/notify-changes',
      headers: { 'x-callback-secret': 'wrong-secret' },
      payload: { domainId: 'does-not-matter' },
    });
    expect(response.statusCode).toBe(401);
    expect(alertWebhook.postDomainChangeAlert).not.toHaveBeenCalled();
  });

  it('422s when domainId is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/domains/notify-changes',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: {},
    });
    expect(response.statusCode).toBe(422);
  });

  it('404s for an unknown domainId', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/domains/notify-changes',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: { domainId: 'not-a-real-domain-id' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('no-ops cleanly (does not error, fires no alerts) with zero history rows', async () => {
    const domainId = await makeDomain();

    const response = await app.inject({
      method: 'POST',
      url: '/internal/domains/notify-changes',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: { domainId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ domainId, notified: 0 });
    expect(alertWebhook.postDomainChangeAlert).not.toHaveBeenCalled();
  });

  it('no-ops cleanly with exactly one history row', async () => {
    const domainId = await makeDomain();
    await prisma.domainCheckHistory.create({
      data: { domainId, spfStatus: 'PENDING', dkimStatus: 'PENDING', dmarcStatus: 'PENDING' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/domains/notify-changes',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: { domainId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ domainId, notified: 0 });
    expect(alertWebhook.postDomainChangeAlert).not.toHaveBeenCalled();
  });

  it('fires one alert per changed field between the two most recent history rows', async () => {
    const domainId = await makeDomain();

    // Older (second-most-recent) snapshot — everything PENDING/null.
    await prisma.domainCheckHistory.create({
      data: {
        domainId,
        spfStatus: 'PENDING',
        dkimStatus: 'PENDING',
        dmarcStatus: 'PENDING',
        blocklistStatus: undefined,
        checkedAt: new Date(Date.now() - 60_000),
      },
    });
    // Newer (most-recent) snapshot — spf + dmarc changed, dkim unchanged, blocklistStatus changed.
    await prisma.domainCheckHistory.create({
      data: {
        domainId,
        spfStatus: 'PASS',
        dkimStatus: 'PENDING',
        dmarcStatus: 'FAIL',
        blocklistStatus: { spamhausZen: 'PASS' },
        checkedAt: new Date(),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/domains/notify-changes',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: { domainId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ domainId, notified: 3 });
    expect(alertWebhook.postDomainChangeAlert).toHaveBeenCalledTimes(3);

    const calledFields = vi
      .mocked(alertWebhook.postDomainChangeAlert)
      .mock.calls.map(([change]) => change.field)
      .sort();
    expect(calledFields).toEqual(['blocklistStatus', 'dmarcStatus', 'spfStatus']);
  });

  it('fires zero alerts when the two most recent history rows are identical', async () => {
    const domainId = await makeDomain();
    const shared = {
      domainId,
      spfStatus: 'PASS' as const,
      dkimStatus: 'PASS' as const,
      dmarcStatus: 'PASS' as const,
    };
    await prisma.domainCheckHistory.create({ data: { ...shared, checkedAt: new Date(Date.now() - 60_000) } });
    await prisma.domainCheckHistory.create({ data: { ...shared, checkedAt: new Date() } });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/domains/notify-changes',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: { domainId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ domainId, notified: 0 });
    expect(alertWebhook.postDomainChangeAlert).not.toHaveBeenCalled();
  });
});
