/**
 * Integration test for `/v1/mailboxes` (`GET /`, `POST /`, `PATCH /:id`, `DELETE /:id`) against a
 * REAL Postgres (docker-compose.test.yml). Mirrors `seedPlacement.integration.test.ts`'s setup.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

describeIntegration('mailboxes routes (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let authToken: string;
  let domainId: string;
  const createdMailboxIds: string[] = [];

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-not-a-real-secret-value';
    process.env.MAILBOX_CREDENTIAL_KEY =
      process.env.MAILBOX_CREDENTIAL_KEY || Buffer.from('m'.repeat(32)).toString('base64');
    app = await createApp();
    await app.ready();

    const jwt = await import('jsonwebtoken');
    authToken = jwt.default.sign(
      { sub: 'test-user', email: 'test@example.org', role: 'ADMIN' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' },
    );

    const domain = await prisma.domain.create({
      data: { domainName: `mailboxes-test-${Date.now()}.example.com` },
    });
    domainId = domain.id;
  });

  afterAll(async () => {
    await prisma.mailbox.deleteMany({ where: { id: { in: createdMailboxIds } } });
    await prisma.domain.deleteMany({ where: { id: domainId } });
    await app.close();
    await prisma.$disconnect();
  });

  it('creates a mailbox, encrypts the password server-side, and never echoes credentials', async () => {
    const email = `Mailbox-${Date.now()}@Example.com`;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/mailboxes',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { email, domainId, authUsername: 'smtp-user', authPassword: 'super-secret-pw' },
    });

    expect(response.statusCode).toBe(201);
    const json = response.json();
    createdMailboxIds.push(json.id);
    expect(json.email).toBe(email.toLowerCase());
    expect(json).not.toHaveProperty('authPasswordEncrypted');
    expect(json).not.toHaveProperty('oauthRefreshTokenEncrypted');

    const stored = await prisma.mailbox.findUniqueOrThrow({ where: { id: json.id } });
    expect(stored.authPasswordEncrypted).toBeTruthy();
    expect(stored.authPasswordEncrypted).not.toBe('super-secret-pw');
  });

  it('rejects a create missing email or domainId', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/mailboxes',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { domainId },
    });
    expect(response.statusCode).toBe(422);
  });

  /**
   * Regression guard: `POST`/`PATCH` both explicitly strip `authPasswordEncrypted` and
   * `oauthRefreshTokenEncrypted` from their responses before this pass — `GET /` did not, and
   * returned every mailbox's encrypted-credential columns verbatim to any authenticated caller.
   * See this repo's bug-fix note in `routes/mailboxes.ts` for the fix applied alongside this test.
   */
  it('never leaks encrypted credential columns from the list endpoint', async () => {
    const email = `Leak-Check-${Date.now()}@example.com`;
    const created = await app.inject({
      method: 'POST',
      url: '/v1/mailboxes',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { email, domainId, authUsername: 'smtp-user', authPassword: 'another-secret-pw' },
    });
    createdMailboxIds.push(created.json().id);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/mailboxes',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(list.statusCode).toBe(200);
    const json = list.json() as Array<Record<string, unknown>>;
    const found = json.find((m) => m.id === created.json().id);
    expect(found).toBeTruthy();
    expect(found).not.toHaveProperty('authPasswordEncrypted');
    expect(found).not.toHaveProperty('oauthRefreshTokenEncrypted');
  });

  it('patches dailyCap and 404s an unknown id', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/mailboxes',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { email: `patch-${Date.now()}@example.com`, domainId },
    });
    const id = created.json().id;
    createdMailboxIds.push(id);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/mailboxes/${id}`,
      headers: { authorization: `Bearer ${authToken}` },
      payload: { dailyCap: 40 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().dailyCap).toBe(40);

    const notFound = await app.inject({
      method: 'PATCH',
      url: '/v1/mailboxes/does-not-exist',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { dailyCap: 1 },
    });
    expect(notFound.statusCode).toBe(404);
  });

  it('deletes a mailbox and 404s deleting it again', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/mailboxes',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { email: `delete-${Date.now()}@example.com`, domainId },
    });
    const id = created.json().id;

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/mailboxes/${id}`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(deleted.statusCode).toBe(204);

    const again = await app.inject({
      method: 'DELETE',
      url: `/v1/mailboxes/${id}`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(again.statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/mailboxes' });
    expect(response.statusCode).toBe(401);
  });
});
