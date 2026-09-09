/**
 * Integration test for `GET/POST/DELETE /v1/oauth/client-config` against a REAL Postgres
 * (docker-compose.test.yml) — the DB-backed piece of the mailbox-connect friction-reduction work
 * (2026-09-09, Item 3): lets an owner save their own Google/Microsoft OAuth client id/secret
 * in-app instead of editing `.env` + restarting. Also proves end to end (not just CRUD) that
 * `GET /v1/oauth/:provider/authorize` actually picks up a DB-saved client config over blank env
 * vars — see `resolveGoogleOAuthCredentials`/`resolveMicrosoftOAuthCredentials` in
 * googleOAuth.ts/microsoftOAuth.ts. Mirrors oauthCallback.integration.test.ts's setup.
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

const TEST_GOOGLE_REDIRECT_URI = 'https://instance.example.test/v1/oauth/google/callback';
const TEST_MICROSOFT_REDIRECT_URI = 'https://instance.example.test/v1/oauth/microsoft/callback';

describeIntegration('oauth client-config routes (integration, real Postgres)', () => {
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
      data: { domainName: `oauth-client-config-test-${Date.now()}.example.com` },
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

  beforeEach(async () => {
    // Force "fresh install, only the redirect URI is set" — the state Item 3's wizard is meant
    // to be used from (redirect URI is infra-set at install time; client id/secret start blank).
    for (const key of OAUTH_ENV_KEYS) {
      savedOAuthEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.GOOGLE_OAUTH_REDIRECT_URI = TEST_GOOGLE_REDIRECT_URI;
    process.env.MICROSOFT_OAUTH_REDIRECT_URI = TEST_MICROSOFT_REDIRECT_URI;
    await prisma.oAuthClientConfig.deleteMany();
  });

  afterEach(async () => {
    for (const key of OAUTH_ENV_KEYS) {
      if (savedOAuthEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedOAuthEnv[key];
    }
    await prisma.oAuthClientConfig.deleteMany();
  });

  it('GET / requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/oauth/client-config' });
    expect(response.statusCode).toBe(401);
  });

  it('GET / reports both providers unconfigured, redirect URIs still shown, on a fresh install', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/oauth/client-config',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual([
      {
        provider: 'GOOGLE',
        source: null,
        configured: false,
        clientId: null,
        maskedClientSecret: null,
        redirectUri: TEST_GOOGLE_REDIRECT_URI,
        updatedAt: null,
      },
      {
        provider: 'MICROSOFT',
        source: null,
        configured: false,
        clientId: null,
        maskedClientSecret: null,
        redirectUri: TEST_MICROSOFT_REDIRECT_URI,
        updatedAt: null,
      },
    ]);
  });

  it('POST / rejects a missing clientId/clientSecret', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/oauth/client-config',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { provider: 'GOOGLE', clientId: '', clientSecret: '' },
    });
    expect(response.statusCode).toBe(422);
  });

  it('POST / rejects when this instance has no redirect URI set for the provider yet', async () => {
    delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/oauth/client-config',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { provider: 'GOOGLE', clientId: 'client-123', clientSecret: 'secret-456' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain('GOOGLE_OAUTH_REDIRECT_URI');
  });

  it('saves, lists (masked), and deletes a Google client config end to end', async () => {
    const postResponse = await app.inject({
      method: 'POST',
      url: '/v1/oauth/client-config',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { provider: 'GOOGLE', clientId: 'real-google-client-id', clientSecret: 'real-google-client-secret' },
    });
    expect(postResponse.statusCode).toBe(201);
    const saved = postResponse.json();
    expect(saved.provider).toBe('GOOGLE');
    expect(saved.source).toBe('db');
    expect(saved.configured).toBe(true);
    expect(saved.clientId).toBe('real-google-client-id');
    expect(saved.maskedClientSecret).not.toBe('real-google-client-secret');
    expect(saved.maskedClientSecret).toMatch(/cret$/); // last 4 chars visible, rest masked

    const getResponse = await app.inject({
      method: 'GET',
      url: '/v1/oauth/client-config',
      headers: { authorization: `Bearer ${authToken}` },
    });
    const googleEntry = getResponse.json().find((r: { provider: string }) => r.provider === 'GOOGLE');
    expect(googleEntry.source).toBe('db');
    expect(googleEntry.configured).toBe(true);
    expect(googleEntry.clientId).toBe('real-google-client-id');

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: '/v1/oauth/client-config/GOOGLE',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(deleteResponse.statusCode).toBe(204);

    const afterDelete = await app.inject({
      method: 'GET',
      url: '/v1/oauth/client-config',
      headers: { authorization: `Bearer ${authToken}` },
    });
    const googleAfterDelete = afterDelete.json().find((r: { provider: string }) => r.provider === 'GOOGLE');
    expect(googleAfterDelete.source).toBeNull();
    expect(googleAfterDelete.configured).toBe(false);
  });

  it('DELETE /:provider 404s when nothing is saved for that provider', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/oauth/client-config/MICROSOFT',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it('end to end: a DB-saved Google client config, with GOOGLE_OAUTH_CLIENT_ID/SECRET still blank, actually drives a real /authorize redirect instead of the not-configured dead end', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/oauth/client-config',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { provider: 'GOOGLE', clientId: 'wizard-client-id', clientSecret: 'wizard-client-secret' },
    });

    const mailbox = await prisma.mailbox.create({
      data: { email: `wizard-configured-${Date.now()}@example.com`, domainId },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/oauth/google/authorize?mailboxId=${mailbox.id}`,
    });

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.hostname).toBe('accounts.google.com');
    expect(location.searchParams.get('client_id')).toBe('wizard-client-id');
    expect(location.searchParams.get('redirect_uri')).toBe(TEST_GOOGLE_REDIRECT_URI);

    await prisma.mailbox.delete({ where: { id: mailbox.id } }).catch(() => null);
  });

  it('end to end: a DB-saved Microsoft client config actually drives a real /authorize redirect', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/oauth/client-config',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { provider: 'MICROSOFT', clientId: 'wizard-ms-client-id', clientSecret: 'wizard-ms-secret' },
    });

    const mailbox = await prisma.mailbox.create({
      data: { email: `wizard-ms-configured-${Date.now()}@example.com`, domainId },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/oauth/microsoft/authorize?mailboxId=${mailbox.id}`,
    });

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.hostname).toBe('login.microsoftonline.com');
    expect(location.searchParams.get('client_id')).toBe('wizard-ms-client-id');
    expect(location.searchParams.get('redirect_uri')).toBe(TEST_MICROSOFT_REDIRECT_URI);

    await prisma.mailbox.delete({ where: { id: mailbox.id } }).catch(() => null);
  });

  it('GET /v1/oauth/status reflects DB-backed configuration too', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/oauth/client-config',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { provider: 'GOOGLE', clientId: 'status-check-id', clientSecret: 'status-check-secret' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/oauth/status',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ google: true, microsoft: false });
  });
});
