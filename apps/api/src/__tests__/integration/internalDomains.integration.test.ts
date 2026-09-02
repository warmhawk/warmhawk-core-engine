/**
 * Integration test for `/internal/domains` (`GET /active`, `POST /check-blocklist`) against a
 * REAL Postgres (docker-compose.test.yml). `POST /check-blocklist` runs real DNS lookups
 * (`lib/dnsChecks.ts#checkBlocklists`, live network — no mocking, per this repo's testing
 * convention) against a fixture domain name that resolves to NXDOMAIN, which is fast (no
 * resolvable A record short-circuits three of the four DNSBL zones).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;
const CALLBACK_SECRET = process.env.NEXTJS_CALLBACK_SECRET || 'test-only-callback-secret';

describeIntegration('/internal/domains routes (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let domainId: string;
  let domainName: string;

  beforeAll(async () => {
    process.env.NEXTJS_CALLBACK_SECRET = CALLBACK_SECRET;
    app = await createApp();
    await app.ready();

    domainName = `internal-domains-test-${Date.now()}.example.com`;
    const domain = await prisma.domain.create({ data: { domainName } });
    domainId = domain.id;
  });

  afterAll(async () => {
    await prisma.domain.deleteMany({ where: { id: domainId } });
    await app.close();
    await prisma.$disconnect();
  });

  it('lists active domain names', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/internal/domains/active',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
    });
    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.domains).toContainEqual({ domainName });
  });

  it('rejects a request with no callback secret', async () => {
    const response = await app.inject({ method: 'GET', url: '/internal/domains/active' });
    expect(response.statusCode).toBe(401);
  });

  it(
    're-checks blocklist status for an existing domain, validates the body, and 404s an unknown domain',
    async () => {
      const success = await app.inject({
        method: 'POST',
        url: '/internal/domains/check-blocklist',
        headers: { 'x-callback-secret': CALLBACK_SECRET },
        payload: { domainName },
      });
      expect(success.statusCode).toBe(200);
      const json = success.json();
      expect(json.id).toBe(domainId);
      expect(json.blocklistStatus).toBeTruthy();
      expect(json.lastBlocklistCheckAt).not.toBeNull();
      // Scoped to blocklist only — SPF/DKIM/DMARC untouched by this route (still PENDING defaults).
      expect(json.spfStatus).toBe('PENDING');

      const missingField = await app.inject({
        method: 'POST',
        url: '/internal/domains/check-blocklist',
        headers: { 'x-callback-secret': CALLBACK_SECRET },
        payload: {},
      });
      expect(missingField.statusCode).toBe(422);

      const notFound = await app.inject({
        method: 'POST',
        url: '/internal/domains/check-blocklist',
        headers: { 'x-callback-secret': CALLBACK_SECRET },
        payload: { domainName: `does-not-exist-${Date.now()}.example.com` },
      });
      expect(notFound.statusCode).toBe(404);
    },
    20_000,
  );
});
