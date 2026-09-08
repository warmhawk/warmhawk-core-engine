/**
 * Integration test for `POST /internal/domains/scan-lookalikes` (Item 6) against a REAL Postgres
 * (docker-compose.test.yml). Split out into its own file for the same reason
 * `internalDomainsNotifyChanges.integration.test.ts` is: `lib/alertWebhook.ts#postDomainChangeAlert`
 * and `lib/rdap.ts#checkRdapRegistration` are both module-mocked here (asserting call counts and
 * arguments, never touching the real network) — mixing those mocks into the existing
 * `internalDomains.integration.test.ts` file would also silently mock them for that file's own
 * (unrelated) tests.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@warmhawk/db';

vi.mock('../../lib/alertWebhook', () => ({
  postDomainChangeAlert: vi.fn().mockResolvedValue(undefined),
}));

const checkRdapRegistrationMock = vi.fn();
vi.mock('../../lib/rdap', () => ({
  checkRdapRegistration: (...args: unknown[]) => checkRdapRegistrationMock(...args),
}));

// Imported after the mocks above so `internalDomains.ts`'s own imports resolve to them — see the
// same ordering note in `internalDomainsNotifyChanges.integration.test.ts`.
import { createApp } from '../../app';
import * as alertWebhook from '../../lib/alertWebhook';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;
const CALLBACK_SECRET = process.env.NEXTJS_CALLBACK_SECRET || 'test-only-callback-secret';

describeIntegration('POST /internal/domains/scan-lookalikes (integration, real Postgres)', () => {
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
    await prisma.lookalikeCandidate.deleteMany({ where: { domainId: { in: domainIds } } });
    await prisma.domain.deleteMany({ where: { id: { in: domainIds } } });
    await app.close();
    await prisma.$disconnect();
  });

  async function makeDomain(domainName?: string): Promise<string> {
    const domain = await prisma.domain.create({
      data: { domainName: domainName ?? `scan-lookalikes-test-${Date.now()}-${Math.random()}.example.com` },
    });
    domainIds.push(domain.id);
    return domain.id;
  }

  it('rejects a request with no callback secret', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/domains/scan-lookalikes',
      payload: { domainId: 'does-not-matter' },
    });
    expect(response.statusCode).toBe(401);
    expect(checkRdapRegistrationMock).not.toHaveBeenCalled();
  });

  it('422s when domainId is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/domains/scan-lookalikes',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: {},
    });
    expect(response.statusCode).toBe(422);
  });

  it('404s for an unknown domainId', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/domains/scan-lookalikes',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: { domainId: 'not-a-real-domain-id' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('first run generates and persists candidates, then checks every one via RDAP', async () => {
    const domainId = await makeDomain('lookalike-first-run.example.com');
    checkRdapRegistrationMock.mockResolvedValue('unregistered');

    const response = await app.inject({
      method: 'POST',
      url: '/internal/domains/scan-lookalikes',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: { domainId },
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.domainId).toBe(domainId);
    expect(json.candidateCount).toBeGreaterThan(0);
    expect(json.checked).toBe(json.candidateCount);
    expect(json.newlyRegistered).toBe(0);

    const rows = await prisma.lookalikeCandidate.findMany({ where: { domainId } });
    expect(rows.length).toBe(json.candidateCount);
    expect(rows.every((row) => row.registered === false)).toBe(true);
    expect(alertWebhook.postDomainChangeAlert).not.toHaveBeenCalled();
  });

  it('does not regenerate the candidate list on a second run', async () => {
    const domainId = await makeDomain('lookalike-no-regenerate.example.com');
    checkRdapRegistrationMock.mockResolvedValue('unregistered');

    await app.inject({
      method: 'POST',
      url: '/internal/domains/scan-lookalikes',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: { domainId },
    });
    const firstCount = await prisma.lookalikeCandidate.count({ where: { domainId } });

    const second = await app.inject({
      method: 'POST',
      url: '/internal/domains/scan-lookalikes',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: { domainId },
    });
    const secondCount = await prisma.lookalikeCandidate.count({ where: { domainId } });

    expect(second.statusCode).toBe(200);
    expect(secondCount).toBe(firstCount);
  });

  it('flips a candidate to registered and fires one alert on the unregistered->registered transition', async () => {
    const domainId = await makeDomain('lookalike-newly-registered.example.com');
    checkRdapRegistrationMock.mockResolvedValue('unregistered');

    // First run: seeds candidates, all unregistered.
    await app.inject({
      method: 'POST',
      url: '/internal/domains/scan-lookalikes',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: { domainId },
    });
    vi.clearAllMocks();

    const target = await prisma.lookalikeCandidate.findFirst({ where: { domainId } });
    expect(target).toBeTruthy();

    // Second run: only the targeted candidate resolves "registered", everything else stays
    // "unregistered".
    checkRdapRegistrationMock.mockImplementation(async (candidateDomain: string) =>
      candidateDomain === target!.candidateDomain ? 'registered' : 'unregistered',
    );

    const response = await app.inject({
      method: 'POST',
      url: '/internal/domains/scan-lookalikes',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: { domainId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().newlyRegistered).toBe(1);
    expect(alertWebhook.postDomainChangeAlert).toHaveBeenCalledTimes(1);
    expect(alertWebhook.postDomainChangeAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: 'lookalike-newly-registered.example.com',
        field: 'lookalike_registered',
        before: 'unregistered',
        after: target!.candidateDomain,
      }),
    );

    const updated = await prisma.lookalikeCandidate.findUnique({ where: { id: target!.id } });
    expect(updated?.registered).toBe(true);
  });

  it('an "unknown" RDAP result bumps lastCheckedAt but never flips registered or alerts', async () => {
    const domainId = await makeDomain('lookalike-unknown-result.example.com');
    checkRdapRegistrationMock.mockResolvedValue('unregistered');

    await app.inject({
      method: 'POST',
      url: '/internal/domains/scan-lookalikes',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: { domainId },
    });
    vi.clearAllMocks();

    const target = await prisma.lookalikeCandidate.findFirst({ where: { domainId } });
    const beforeCheckedAt = target!.lastCheckedAt;

    checkRdapRegistrationMock.mockResolvedValue('unknown');
    await new Promise((resolve) => setTimeout(resolve, 5)); // ensure a distinguishable timestamp

    const response = await app.inject({
      method: 'POST',
      url: '/internal/domains/scan-lookalikes',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: { domainId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().newlyRegistered).toBe(0);
    expect(alertWebhook.postDomainChangeAlert).not.toHaveBeenCalled();

    const updated = await prisma.lookalikeCandidate.findUnique({ where: { id: target!.id } });
    expect(updated?.registered).toBe(false);
    expect(updated?.lastCheckedAt.getTime()).toBeGreaterThan(beforeCheckedAt.getTime());
  });

  it('skips a candidate already registered:true — RDAP is not even queried for it', async () => {
    const domainId = await makeDomain('lookalike-skip-registered.example.com');
    checkRdapRegistrationMock.mockResolvedValue('unregistered');

    await app.inject({
      method: 'POST',
      url: '/internal/domains/scan-lookalikes',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: { domainId },
    });

    const target = await prisma.lookalikeCandidate.findFirst({ where: { domainId } });
    await prisma.lookalikeCandidate.update({
      where: { id: target!.id },
      data: { registered: true },
    });
    vi.clearAllMocks();
    checkRdapRegistrationMock.mockResolvedValue('unregistered');

    const response = await app.inject({
      method: 'POST',
      url: '/internal/domains/scan-lookalikes',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: { domainId },
    });

    expect(response.statusCode).toBe(200);
    const calledCandidates = checkRdapRegistrationMock.mock.calls.map(([candidate]) => candidate);
    expect(calledCandidates).not.toContain(target!.candidateDomain);
  });
});
