/**
 * Integration test for `GET /v1/instance-settings` + `PUT /v1/instance-settings` against a REAL
 * Postgres (docker-compose.test.yml). Mirrors `leadsImport.integration.test.ts`'s setup (real
 * Prisma writes, JWT-signed `app.inject()` calls, self-skips without DATABASE_URL).
 *
 * `InstanceSettings` is a singleton row (id = "default") shared with the rest of this dev stack —
 * the shared Postgres already had zero rows in this table before this file ran (confirmed via a
 * manual count), so this suite creates the row itself and deletes it again in `afterAll` to leave
 * the table back the way it found it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

describeIntegration('instance-settings routes (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let authToken: string;

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

    // Defensive: make sure no prior run left the singleton row behind before we assert its
    // "not configured yet" default.
    await prisma.instanceSettings.deleteMany({ where: { id: 'default' } });
  });

  afterAll(async () => {
    await prisma.instanceSettings.deleteMany({ where: { id: 'default' } });
    await app.close();
    await prisma.$disconnect();
  });

  it('returns a synthetic default (null address) when no row has been configured yet', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/instance-settings',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json).toEqual({ id: 'default', physicalMailingAddress: null });
  });

  it('sets the physical mailing address via PUT and rejects an empty value', async () => {
    const putResponse = await app.inject({
      method: 'PUT',
      url: '/v1/instance-settings',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { physicalMailingAddress: '123 Main St, Springfield, USA' },
    });

    expect(putResponse.statusCode).toBe(200);
    expect(putResponse.json().physicalMailingAddress).toBe('123 Main St, Springfield, USA');

    const getResponse = await app.inject({
      method: 'GET',
      url: '/v1/instance-settings',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(getResponse.json().physicalMailingAddress).toBe('123 Main St, Springfield, USA');

    const rejected = await app.inject({
      method: 'PUT',
      url: '/v1/instance-settings',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { physicalMailingAddress: '   ' },
    });
    expect(rejected.statusCode).toBe(422);
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/instance-settings' });
    expect(response.statusCode).toBe(401);
  });
});
