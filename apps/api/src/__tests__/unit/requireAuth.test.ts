/**
 * Regression guard for the operator-dashboard auth bridge (`lib/requireAuth.ts`):
 * the licensed dashboard has no per-human credential against this engine's own `User`
 * table, so it authenticates as a single shared `OPERATOR_SERVICE_TOKEN` instead of a signed JWT.
 * Exercised against a real `requireAuth`-guarded route (`GET /v1/replies`) via `app.inject()`
 * rather than calling the middleware in isolation, so this also proves the route is actually
 * wired to it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@warmhawk/db';
import { createApp } from '../../app';
import { signAuthToken } from '../../lib/jwt';

describe('requireAuth — operator service-token bridge', () => {
  let app: FastifyInstance;
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalServiceToken = process.env.OPERATOR_SERVICE_TOKEN;

  beforeEach(async () => {
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.OPERATOR_SERVICE_TOKEN = 'test-operator-service-token';
    vi.spyOn(prisma.reply, 'findMany').mockResolvedValue([] as never);
    app = await createApp();
  });

  afterEach(async () => {
    process.env.JWT_SECRET = originalJwtSecret;
    process.env.OPERATOR_SERVICE_TOKEN = originalServiceToken;
    vi.restoreAllMocks();
    await app.close();
  });

  it('rejects a request with no Authorization header', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/replies' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a request with a garbage Bearer token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/replies',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts a real dashboard-user JWT (existing Tier 0 login path, unaffected)', async () => {
    const token = signAuthToken({ sub: 'user-1', email: 'admin@example.com', role: 'ADMIN' });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/replies',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it('accepts the exact OPERATOR_SERVICE_TOKEN as a Bearer token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/replies',
      headers: { authorization: 'Bearer test-operator-service-token' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('regression: does not fall back to treating an unset OPERATOR_SERVICE_TOKEN as a wildcard match', async () => {
    delete process.env.OPERATOR_SERVICE_TOKEN;
    const response = await app.inject({
      method: 'GET',
      url: '/v1/replies',
      headers: { authorization: 'Bearer ' },
    });
    expect(response.statusCode).toBe(401);
  });
});
