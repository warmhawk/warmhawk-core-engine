/**
 * Integration test for `/v1/domains` (`GET /`, `POST /`, `PATCH /:id`, `POST /:domain/check`)
 * against a REAL Postgres (docker-compose.test.yml). `GET /:id/placement-sample` is already
 * covered by `seedPlacement.integration.test.ts` — not duplicated here.
 *
 * `POST /:domain/check` runs real DNS lookups (`lib/dnsChecks.ts`, live network, no mocking) for a
 * fixture domain that doesn't actually exist — every lookup resolves NXDOMAIN quickly, so this
 * stays well under the suite's 30s test timeout, but is given a longer per-test timeout as a
 * safety margin against slower resolver round-trips.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

describeIntegration('domains routes (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let authToken: string;
  const createdDomainIds: string[] = [];

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
  });

  afterAll(async () => {
    await prisma.mailbox.deleteMany({ where: { domainId: { in: createdDomainIds } } });
    await prisma.domain.deleteMany({ where: { id: { in: createdDomainIds } } });
    await app.close();
    await prisma.$disconnect();
  });

  it('creates a domain (lowercased) and rejects a missing domainName', async () => {
    const domainName = `Domains-Test-${Date.now()}.Example.com`;
    const created = await app.inject({
      method: 'POST',
      url: '/v1/domains',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { domainName },
    });
    expect(created.statusCode).toBe(201);
    const json = created.json();
    createdDomainIds.push(json.id);
    expect(json.domainName).toBe(domainName.toLowerCase());
    expect(json.spfStatus).toBe('PENDING');

    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/domains',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {},
    });
    expect(rejected.statusCode).toBe(422);
  });

  it('lists domains including a mailbox count for one just created', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/domains',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(response.statusCode).toBe(200);
    const found = response.json().find((d: { id: string }) => d.id === createdDomainIds[0]);
    expect(found).toBeTruthy();
    expect(found._count.mailboxes).toBe(0);
  });

  it('patches a domain redirectUrl and 404s an unknown id', async () => {
    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/domains/${createdDomainIds[0]}`,
      headers: { authorization: `Bearer ${authToken}` },
      payload: { redirectUrl: 'https://example.org/landing' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().redirectUrl).toBe('https://example.org/landing');

    const notFound = await app.inject({
      method: 'PATCH',
      url: '/v1/domains/does-not-exist',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { redirectUrl: 'https://example.org/x' },
    });
    expect(notFound.statusCode).toBe(404);
  });

  it(
    'runs a live SPF/DKIM/DMARC + blocklist check by domain name, and 404s an unknown domain name',
    async () => {
      const domainName = `domains-check-test-${Date.now()}.example.com`;
      const domain = await prisma.domain.create({ data: { domainName } });
      createdDomainIds.push(domain.id);

      const response = await app.inject({
        method: 'POST',
        url: `/v1/domains/${domainName}/check`,
        headers: { authorization: `Bearer ${authToken}` },
      });
      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(['PASS', 'FAIL']).toContain(json.spfStatus);
      // 🔑 DKIM is the one check with no verdict to give here. Selectors cannot be enumerated
      // from DNS, so with none supplied `checkDkim` guesses nine common names, and a miss means
      // "we did not find one" — not "this domain has no DKIM". That is PENDING, and for a
      // synthetic domain that never resolves it is PENDING every time. Allowing only PASS/FAIL
      // encoded the very bug lib/dnsChecks.ts was changed to fix: reporting an absence nobody
      // can prove as a failure against the domain.
      expect(json.dkimStatus).toBe('PENDING');
      expect(['PASS', 'FAIL']).toContain(json.dmarcStatus);
      expect(json.blocklistStatus).toBeTruthy();
      expect(json.lastBlocklistCheckAt).not.toBeNull();

      const notFound = await app.inject({
        method: 'POST',
        url: `/v1/domains/does-not-exist-${Date.now()}.example.com/check`,
        headers: { authorization: `Bearer ${authToken}` },
      });
      expect(notFound.statusCode).toBe(404);
    },
    20_000,
  );

  it(
    'writes a DomainCheckHistory row with the PRE-update values on each check, and exposes them via check-history',
    async () => {
      const domainName = `domains-check-history-test-${Date.now()}.example.com`;
      const domain = await prisma.domain.create({ data: { domainName } });
      createdDomainIds.push(domain.id);

      // Fresh domain starts PENDING/PENDING/PENDING with no blocklistStatus — the first check's
      // history row must capture exactly that pre-update snapshot, not the freshly-computed result.
      const first = await app.inject({
        method: 'POST',
        url: `/v1/domains/${domainName}/check`,
        headers: { authorization: `Bearer ${authToken}` },
      });
      expect(first.statusCode).toBe(200);
      const firstResult = first.json();

      const afterFirst = await prisma.domainCheckHistory.findMany({
        where: { domainId: domain.id },
        orderBy: { checkedAt: 'desc' },
      });
      expect(afterFirst).toHaveLength(1);
      expect(afterFirst[0].spfStatus).toBe('PENDING');
      expect(afterFirst[0].dkimStatus).toBe('PENDING');
      expect(afterFirst[0].dmarcStatus).toBe('PENDING');
      expect(afterFirst[0].blocklistStatus).toBeNull();

      // Second check: the history row it writes must capture what the FIRST check just wrote
      // (the domain's state right before this second update), not the second check's own result.
      const second = await app.inject({
        method: 'POST',
        url: `/v1/domains/${domainName}/check`,
        headers: { authorization: `Bearer ${authToken}` },
      });
      expect(second.statusCode).toBe(200);

      const afterSecond = await prisma.domainCheckHistory.findMany({
        where: { domainId: domain.id },
        orderBy: { checkedAt: 'desc' },
      });
      expect(afterSecond).toHaveLength(2);
      const [mostRecent] = afterSecond;
      expect(mostRecent.spfStatus).toBe(firstResult.spfStatus);
      expect(mostRecent.dkimStatus).toBe(firstResult.dkimStatus);
      expect(mostRecent.dmarcStatus).toBe(firstResult.dmarcStatus);
      expect(mostRecent.blocklistStatus).toEqual(firstResult.blocklistStatus);

      // GET check-history — same auth gate, default limit, and an explicit limit=1.
      const unauthed = await app.inject({
        method: 'GET',
        url: `/v1/domains/${domainName}/check-history`,
      });
      expect(unauthed.statusCode).toBe(401);

      const historyResponse = await app.inject({
        method: 'GET',
        url: `/v1/domains/${domainName}/check-history`,
        headers: { authorization: `Bearer ${authToken}` },
      });
      expect(historyResponse.statusCode).toBe(200);
      const historyJson = historyResponse.json();
      expect(historyJson.domainName).toBe(domainName);
      expect(historyJson.history).toHaveLength(2);
      expect(historyJson.history[0].checkedAt >= historyJson.history[1].checkedAt).toBe(true);

      const limited = await app.inject({
        method: 'GET',
        url: `/v1/domains/${domainName}/check-history?limit=1`,
        headers: { authorization: `Bearer ${authToken}` },
      });
      expect(limited.statusCode).toBe(200);
      expect(limited.json().history).toHaveLength(1);
      expect(limited.json().history[0].id).toBe(historyJson.history[0].id);

      const notFound = await app.inject({
        method: 'GET',
        url: `/v1/domains/does-not-exist-${Date.now()}.example.com/check-history`,
        headers: { authorization: `Bearer ${authToken}` },
      });
      expect(notFound.statusCode).toBe(404);
    },
    20_000,
  );

  it('returns persisted LookalikeCandidate rows for a domain (Item 6) and requires auth', async () => {
    const domainName = `domains-lookalikes-test-${Date.now()}.example.com`;
    const domain = await prisma.domain.create({ data: { domainName } });
    createdDomainIds.push(domain.id);
    await prisma.lookalikeCandidate.create({
      data: { domainId: domain.id, candidateDomain: `exmaple-${Date.now()}.com` },
    });

    const unauthed = await app.inject({
      method: 'GET',
      url: `/v1/domains/${domainName}/lookalikes`,
    });
    expect(unauthed.statusCode).toBe(401);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/domains/${domainName}/lookalikes`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.domainName).toBe(domainName);
    expect(json.lookalikes).toHaveLength(1);
    expect(json.lookalikes[0]).toEqual(
      expect.objectContaining({ candidateDomain: expect.any(String), registered: false }),
    );

    const notFound = await app.inject({
      method: 'GET',
      url: `/v1/domains/does-not-exist-${Date.now()}.example.com/lookalikes`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(notFound.statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/domains' });
    expect(response.statusCode).toBe(401);
  });

  it('deletes a domain with no mailboxes, and 404s an unknown id', async () => {
    const domain = await prisma.domain.create({ data: { domainName: `domains-delete-test-${Date.now()}.example.com` } });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/domains/${domain.id}`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(deleted.statusCode).toBe(204);
    expect(await prisma.domain.findUnique({ where: { id: domain.id } })).toBeNull();

    const notFound = await app.inject({
      method: 'DELETE',
      url: '/v1/domains/does-not-exist',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(notFound.statusCode).toBe(404);
  });

  it('refuses to delete a domain that still has mailboxes attached', async () => {
    const domain = await prisma.domain.create({ data: { domainName: `domains-delete-guard-test-${Date.now()}.example.com` } });
    createdDomainIds.push(domain.id);
    await prisma.mailbox.create({ data: { email: `guard-${Date.now()}@example.com`, domainId: domain.id } });

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/domains/${domain.id}`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/mailbox/i);
    expect(await prisma.domain.findUnique({ where: { id: domain.id } })).not.toBeNull();
  });

  it('requires authentication for delete', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/v1/domains/does-not-matter' });
    expect(response.statusCode).toBe(401);
  });
});
