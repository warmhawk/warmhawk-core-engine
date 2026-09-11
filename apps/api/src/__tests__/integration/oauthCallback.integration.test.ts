/**
 * Integration test for `GET /v1/oauth/:provider/authorize` against a REAL Postgres
 * (docker-compose.test.yml). Covers the real bug found 2026-09-09 driving Journey D against real
 * stage: with no GOOGLE_OAUTH_CLIENT_ID/MICROSOFT_OAUTH_CLIENT_ID configured (the default on every
 * fresh install — see `.env/.env.example`), this route used to let the exception escape as a raw,
 * unbranded 500 JSON body instead of the friendly `redirectWithError()` every other failure path
 * in `oauthCallback.ts` already gets. Mirrors `mailboxes.integration.test.ts`'s setup.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

const OAUTH_ENV_KEYS = [
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_REDIRECT_URI',
  'MICROSOFT_OAUTH_CLIENT_ID',
  'MICROSOFT_OAUTH_CLIENT_SECRET',
  'MICROSOFT_OAUTH_REDIRECT_URI',
] as const;

describeIntegration('oauth authorize route (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let domainId: string;
  let authToken: string;
  const savedOAuthEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-not-a-real-secret-value';
    process.env.MAILBOX_CREDENTIAL_KEY =
      process.env.MAILBOX_CREDENTIAL_KEY || Buffer.from('m'.repeat(32)).toString('base64');
    app = await createApp();
    await app.ready();

    const domain = await prisma.domain.create({
      data: { domainName: `oauth-authorize-test-${Date.now()}.example.com` },
    });
    domainId = domain.id;

    const jwt = await import('jsonwebtoken');
    authToken = jwt.default.sign(
      { sub: 'test-user', email: 'test@example.org', role: 'ADMIN' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' },
    );
  });

  afterAll(async () => {
    await prisma.domain.deleteMany({ where: { id: domainId } });
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(() => {
    // This instance's own test env may or may not have real OAuth client values — force the
    // "fresh install, nothing configured yet" state deterministically either way, then restore
    // whatever was there afterward.
    for (const key of OAUTH_ENV_KEYS) {
      savedOAuthEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of OAUTH_ENV_KEYS) {
      if (savedOAuthEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedOAuthEnv[key];
    }
  });

  it('redirects with a friendly oauth_error instead of a raw 500 when Google is unconfigured, and cleans up the mailbox row', async () => {
    const mailbox = await prisma.mailbox.create({
      data: { email: `unconfigured-google-${Date.now()}@example.com`, domainId },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/oauth/google/authorize?mailboxId=${mailbox.id}`,
    });

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string, 'http://localhost');
    expect(location.pathname).toBe('/dashboard/mailboxes');
    expect(location.searchParams.get('oauth_error')).toBe('google_not_configured');

    const stillExists = await prisma.mailbox.findUnique({ where: { id: mailbox.id } });
    expect(stillExists).toBeNull();
  });

  it('redirects with a friendly oauth_error instead of a raw 500 when Microsoft is unconfigured, and cleans up the mailbox row', async () => {
    const mailbox = await prisma.mailbox.create({
      data: { email: `unconfigured-microsoft-${Date.now()}@example.com`, domainId },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/oauth/microsoft/authorize?mailboxId=${mailbox.id}`,
    });

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string, 'http://localhost');
    expect(location.pathname).toBe('/dashboard/mailboxes');
    expect(location.searchParams.get('oauth_error')).toBe('microsoft_not_configured');

    const stillExists = await prisma.mailbox.findUnique({ where: { id: mailbox.id } });
    expect(stillExists).toBeNull();
  });

  it('GET /status requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/oauth/status' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /status reports both providers unconfigured on a fresh install', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/oauth/status',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ google: false, microsoft: false });
  });

  it('GET /status reports a provider configured once its env vars are set', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost:4600/v1/oauth/google/callback';

    const response = await app.inject({
      method: 'GET',
      url: '/v1/oauth/status',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ google: true, microsoft: false });
  });
});
