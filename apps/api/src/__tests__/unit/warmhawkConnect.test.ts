/**
 * WarmHawk Connect (09-27-26) — the install side of the one-click Google/Microsoft connect:
 * `PUT /v1/instance-settings/connect-license`, `/v1/oauth/status`, `/v1/oauth/:provider/authorize`
 * in Connect mode, and `/v1/oauth/:provider/connect-callback`. Prisma is spied on the shared
 * singleton, and the relay, Google and Microsoft are a stubbed global `fetch` — never live.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@warmhawk/db';
import { createApp } from '../../app';
import { encrypt, decrypt, loadEncryptionKey } from '../../lib/encryption';
import { signAuthToken } from '../../lib/jwt';
import { signOAuthState, verifyOAuthState } from '../../lib/oauthState';
import { clearConnectConfigCache } from '../../lib/connectRelay';

const KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const RELAY = 'https://relay.test';
const GOOGLE_CLIENT_ID = 'google-connect-client.apps.googleusercontent.com';
const MICROSOFT_CLIENT_ID = '11111111-2222-3333-4444-555555555555';

function key() {
  return loadEncryptionKey(KEY_B64);
}

function jwtWith(claims: Record<string, unknown>): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** Routes the stubbed fetch by URL prefix; records every call. */
function stubFetch(routes: Record<string, Route>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const match = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((prefix) => url.startsWith(prefix));
    if (!match) throw new Error(`unexpected fetch ${url}`);
    return routes[match]!(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const configRoute: Route = () =>
  jsonResponse({
    google: { clientId: GOOGLE_CLIENT_ID },
    microsoft: { clientId: MICROSOFT_CLIENT_ID },
  });

describe('WarmHawk Connect (install side)', () => {
  let app: FastifyInstance;
  const saved = { ...process.env };

  beforeEach(async () => {
    process.env.MAILBOX_CREDENTIAL_KEY = KEY_B64;
    process.env.JWT_SECRET = 'test-only-not-a-real-secret-value';
    process.env.OPERATOR_SERVICE_TOKEN = 'operator-token';
    process.env.WARMHAWK_DOMAIN = 'warmhawk.acme.example';
    process.env.DASHBOARD_APP_URL = 'https://dash.acme.example';
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    delete process.env.MICROSOFT_OAUTH_CLIENT_ID;
    delete process.env.MICROSOFT_OAUTH_CLIENT_SECRET;
    clearConnectConfigCache();
    vi.spyOn(prisma.oAuthClientConfig, 'findUnique').mockResolvedValue(null);
    app = await createApp();
  });

  afterEach(async () => {
    process.env = { ...saved };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await app.close();
  });

  function withStoredLicense() {
    return vi.spyOn(prisma.instanceSettings, 'findUnique').mockResolvedValue({
      connectLicenseEncrypted: encrypt('license-token', key()),
      connectRelayBaseUrl: RELAY,
    } as never);
  }

  function withMailbox(email = 'sales@acme.example', senderName: string | null = null) {
    return vi.spyOn(prisma.mailbox, 'findUnique').mockResolvedValue({ email, senderName } as never);
  }

  function errorParams(location: string | undefined) {
    const url = new URL(location ?? 'http://x/');
    return {
      path: url.pathname,
      error: url.searchParams.get('oauth_error'),
      detail: url.searchParams.get('oauth_detail'),
      connected: url.searchParams.get('connected'),
    };
  }

  // -------------------------------------------------------------------------------------------
  describe('PUT /v1/instance-settings/connect-license', () => {
    it('stores the license encrypted when the operator service token sends it', async () => {
      const upsert = vi.spyOn(prisma.instanceSettings, 'upsert').mockResolvedValue({} as never);
      const response = await app.inject({
        method: 'PUT',
        url: '/v1/instance-settings/connect-license',
        headers: { authorization: 'Bearer operator-token' },
        payload: { licenseToken: 'license-token', relayBaseUrl: 'https://warmhawk.com/' },
      });
      expect(response.statusCode).toBe(204);
      const args = upsert.mock.calls[0]![0] as {
        update: { connectLicenseEncrypted: string; connectRelayBaseUrl: string };
      };
      expect(args.update.connectRelayBaseUrl).toBe('https://warmhawk.com');
      expect(args.update.connectLicenseEncrypted).not.toContain('license-token');
      expect(decrypt(args.update.connectLicenseEncrypted, key())).toBe('license-token');
    });

    it('refuses a dashboard user JWT', async () => {
      const token = signAuthToken({ sub: 'user-1', email: 'owner@acme.example', role: 'ADMIN' });
      const response = await app.inject({
        method: 'PUT',
        url: '/v1/instance-settings/connect-license',
        headers: { authorization: `Bearer ${token}` },
        payload: { licenseToken: 'license-token', relayBaseUrl: 'https://warmhawk.com' },
      });
      expect(response.statusCode).toBe(403);
    });

    it.each(['http://warmhawk.com', 'https://warmhawk.com/api', 'not a url', ''])(
      'rejects relayBaseUrl %j',
      async (relayBaseUrl) => {
        const response = await app.inject({
          method: 'PUT',
          url: '/v1/instance-settings/connect-license',
          headers: { authorization: 'Bearer operator-token' },
          payload: { licenseToken: 'license-token', relayBaseUrl },
        });
        expect(response.statusCode).toBe(422);
      },
    );

    it('never returns the license from GET /v1/instance-settings', async () => {
      const findUnique = vi
        .spyOn(prisma.instanceSettings, 'findUnique')
        .mockResolvedValue({ id: 'default', physicalMailingAddress: '1 Main St' } as never);
      await app.inject({
        method: 'GET',
        url: '/v1/instance-settings',
        headers: { authorization: 'Bearer operator-token' },
      });
      const { select } = findUnique.mock.calls[0]![0] as { select: Record<string, boolean> };
      expect(select).toEqual({ id: true, physicalMailingAddress: true, updatedAt: true });
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('GET /v1/oauth/status', () => {
    it('reports BYO when the instance has its own Google app', async () => {
      process.env.GOOGLE_OAUTH_CLIENT_ID = 'own-id';
      process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'own-secret';
      vi.spyOn(prisma.instanceSettings, 'findUnique').mockResolvedValue(null);
      const response = await app.inject({
        method: 'GET',
        url: '/v1/oauth/status',
        headers: { authorization: 'Bearer operator-token' },
      });
      expect(response.json()).toEqual({
        google: true,
        microsoft: false,
        via: { google: 'BYO', microsoft: null },
        connectClientIds: { google: null, microsoft: null },
        connectAdminConsentUrl: null,
      });
    });

    it('reports Connect with the public client ids once a license is stored', async () => {
      withStoredLicense();
      stubFetch({
        [`${RELAY}/api/connect/config`]: () =>
          jsonResponse({ google: { clientId: GOOGLE_CLIENT_ID }, microsoft: null }),
      });
      const response = await app.inject({
        method: 'GET',
        url: '/v1/oauth/status',
        headers: { authorization: 'Bearer operator-token' },
      });
      expect(response.json()).toEqual({
        google: true,
        microsoft: false,
        via: { google: 'CONNECT', microsoft: null },
        connectClientIds: { google: GOOGLE_CLIENT_ID, microsoft: null },
        connectAdminConsentUrl: null,
      });
    });

    it('keeps Connect on while the relay config is unreachable', async () => {
      withStoredLicense();
      stubFetch({
        [`${RELAY}/api/connect/config`]: () => {
          throw new TypeError('fetch failed');
        },
      });
      const response = await app.inject({
        method: 'GET',
        url: '/v1/oauth/status',
        headers: { authorization: 'Bearer operator-token' },
      });
      expect(response.json().via).toEqual({ google: 'CONNECT', microsoft: 'CONNECT' });
      expect(response.json().connectAdminConsentUrl).toBe(
        `${RELAY}/connect/microsoft/admin-consent`,
      );
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('GET /v1/oauth/:provider/authorize in Connect mode', () => {
    it('asks the relay for a Google authorize URL and redirects the buyer there', async () => {
      withStoredLicense();
      withMailbox();
      const calls = stubFetch({
        [`${RELAY}/api/connect/config`]: configRoute,
        [`${RELAY}/api/connect/start`]: () =>
          jsonResponse({
            authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
            clientId: GOOGLE_CLIENT_ID,
          }),
      });
      const response = await app.inject({
        method: 'GET',
        url: '/v1/oauth/google/authorize?mailboxId=mb-1',
      });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('https://accounts.google.com/o/oauth2/v2/auth?x=1');

      const start = calls.find((c) => c.url === `${RELAY}/api/connect/start`)!;
      expect((start.init!.headers as Record<string, string>).authorization).toBe(
        'Bearer license-token',
      );
      const body = JSON.parse(String(start.init!.body));
      expect(body).toMatchObject({
        provider: 'google',
        returnUrl: 'https://warmhawk.acme.example/v1/oauth/google/connect-callback',
        loginHint: 'sales@acme.example',
      });
      expect(body.codeChallenge).toBeUndefined();
      expect(verifyOAuthState(body.installState)).toEqual({
        mailboxId: 'mb-1',
        provider: 'GOOGLE_WORKSPACE',
        via: 'connect',
      });
    });

    it('sends a PKCE challenge for Microsoft and keeps the verifier encrypted in the state', async () => {
      withStoredLicense();
      withMailbox();
      const calls = stubFetch({
        [`${RELAY}/api/connect/config`]: configRoute,
        [`${RELAY}/api/connect/start`]: () =>
          jsonResponse({
            authorizeUrl:
              'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?x=1',
            clientId: MICROSOFT_CLIENT_ID,
          }),
      });
      await app.inject({ method: 'GET', url: '/v1/oauth/microsoft/authorize?mailboxId=mb-1' });

      const body = JSON.parse(String(calls.find((c) => c.url.endsWith('/start'))!.init!.body));
      const state = verifyOAuthState(body.installState);
      expect(state.via).toBe('connect');
      const verifier = decrypt(state.pkv!, key());
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(body.installState).not.toContain(verifier);
      const { createHash } = await import('node:crypto');
      expect(body.codeChallenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    });

    it('explains a domain mismatch and removes the pending mailbox', async () => {
      withStoredLicense();
      withMailbox();
      const deleteMany = vi.spyOn(prisma.mailbox, 'deleteMany').mockResolvedValue({ count: 1 });
      stubFetch({
        [`${RELAY}/api/connect/config`]: configRoute,
        [`${RELAY}/api/connect/start`]: () =>
          jsonResponse({ error: 'domain_mismatch', boundDomain: 'old.acme.example' }, 403),
      });
      const response = await app.inject({
        method: 'GET',
        url: '/v1/oauth/google/authorize?mailboxId=mb-1',
      });
      const params = errorParams(response.headers.location);
      expect(params.error).toBe('license');
      expect(params.detail).toContain('old.acme.example');
      expect(deleteMany).toHaveBeenCalledWith({
        where: { id: 'mb-1', oauthRefreshTokenEncrypted: null, authPasswordEncrypted: null },
      });
    });

    it('says warmhawk.com is unreachable when the relay is down', async () => {
      withStoredLicense();
      withMailbox();
      vi.spyOn(prisma.mailbox, 'deleteMany').mockResolvedValue({ count: 1 });
      stubFetch({
        [`${RELAY}/api/connect/config`]: configRoute,
        [`${RELAY}/api/connect/start`]: () => {
          throw new TypeError('fetch failed');
        },
      });
      const response = await app.inject({
        method: 'GET',
        url: '/v1/oauth/google/authorize?mailboxId=mb-1',
      });
      expect(errorParams(response.headers.location).error).toBe('relay_unreachable');
    });

    it('explains an incomplete address instead of blaming Google', async () => {
      withStoredLicense();
      withMailbox('sales');
      vi.spyOn(prisma.mailbox, 'deleteMany').mockResolvedValue({ count: 1 });
      stubFetch({
        [`${RELAY}/api/connect/config`]: configRoute,
        [`${RELAY}/api/connect/start`]: () => jsonResponse({ error: 'invalid_request' }, 400),
      });
      const response = await app.inject({
        method: 'GET',
        url: '/v1/oauth/microsoft/authorize?mailboxId=mb-1',
      });
      const params = errorParams(response.headers.location);
      expect(params.error).toBe('invalid_address');
      expect(params.detail).toContain('"sales"');
      expect(params.detail).not.toMatch(/google/i);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('GET /v1/oauth/google/connect-callback', () => {
    const connectState = () =>
      signOAuthState({ mailboxId: 'mb-1', provider: 'GOOGLE_WORKSPACE', via: 'connect' });

    function relayTokenRoute(
      claims: Record<string, unknown>,
      scope = 'openid email https://mail.google.com/',
    ) {
      return () =>
        jsonResponse({
          access_token: 'ya29.access',
          expires_in: 3599,
          refresh_token: '1//refresh',
          id_token: jwtWith(claims),
          scope,
        });
    }

    it('stores the Connect mailbox when the signed-in account matches', async () => {
      withStoredLicense();
      withMailbox('Sales@Acme.example');
      const update = vi.spyOn(prisma.mailbox, 'update').mockResolvedValue({} as never);
      const calls = stubFetch({
        [`${RELAY}/api/connect/google/token`]: relayTokenRoute({
          email: 'sales@acme.example',
          email_verified: true,
          aud: GOOGLE_CLIENT_ID,
        }),
      });
      const response = await app.inject({
        method: 'GET',
        url: `/v1/oauth/google/connect-callback?code=4%2Fcode&state=${connectState()}`,
      });

      expect(errorParams(response.headers.location)).toMatchObject({
        path: '/dashboard/mailboxes',
        error: null,
        connected: 'mb-1',
      });
      expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ grant: 'code', code: '4/code' });
      const { data } = update.mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(data).toMatchObject({
        provider: 'GOOGLE_WORKSPACE',
        oauthVia: 'CONNECT',
        oauthClientId: GOOGLE_CLIENT_ID,
        smtpHost: 'smtp.gmail.com',
        imapHost: 'imap.gmail.com',
        authUsername: 'Sales@Acme.example',
      });
      expect(decrypt(data.oauthRefreshTokenEncrypted as string, key())).toBe('1//refresh');
      // No Gmail send-as route stubbed, so the name lookup failed — the connect still went through.
      expect(data).not.toHaveProperty('senderName');
    });

    const SEND_AS = 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs/';
    const matchingClaims = {
      email: 'sales@acme.example',
      email_verified: true,
      aud: GOOGLE_CLIENT_ID,
    };

    it("saves Gmail's send-as display name as the sender name", async () => {
      withStoredLicense();
      withMailbox('sales@acme.example');
      const update = vi.spyOn(prisma.mailbox, 'update').mockResolvedValue({} as never);
      const calls = stubFetch({
        [`${RELAY}/api/connect/google/token`]: relayTokenRoute(matchingClaims),
        [SEND_AS]: () =>
          jsonResponse({ sendAsEmail: 'sales@acme.example', displayName: ' Sam  Patel ' }),
      });
      await app.inject({
        method: 'GET',
        url: `/v1/oauth/google/connect-callback?code=c&state=${connectState()}`,
      });

      const sendAs = calls.find((c) => c.url.startsWith(SEND_AS))!;
      expect(sendAs.url).toBe(`${SEND_AS}sales%40acme.example`);
      expect(new Headers(sendAs.init!.headers).get('authorization')).toBe('Bearer ya29.access');
      const { data } = update.mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(data.senderName).toBe('Sam Patel');
    });

    it('never overwrites a sender name the owner already set', async () => {
      withStoredLicense();
      withMailbox('sales@acme.example', 'Sam from Acme');
      const update = vi.spyOn(prisma.mailbox, 'update').mockResolvedValue({} as never);
      stubFetch({
        [`${RELAY}/api/connect/google/token`]: relayTokenRoute(matchingClaims),
        [SEND_AS]: () => jsonResponse({ displayName: 'Samuel Patel' }),
      });
      await app.inject({
        method: 'GET',
        url: `/v1/oauth/google/connect-callback?code=c&state=${connectState()}`,
      });
      const { data } = update.mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(data).not.toHaveProperty('senderName');
    });

    it('leaves the name unset when Gmail has none, or only the address', async () => {
      for (const displayName of ['', 'sales@acme.example']) {
        withStoredLicense();
        withMailbox('sales@acme.example');
        const update = vi.spyOn(prisma.mailbox, 'update').mockResolvedValue({} as never);
        stubFetch({
          [`${RELAY}/api/connect/google/token`]: relayTokenRoute(matchingClaims),
          [SEND_AS]: () => jsonResponse({ displayName }),
        });
        const response = await app.inject({
          method: 'GET',
          url: `/v1/oauth/google/connect-callback?code=c&state=${connectState()}`,
        });
        expect(errorParams(response.headers.location).connected).toBe('mb-1');
        const { data } = update.mock.calls[0]![0] as { data: Record<string, unknown> };
        expect(data).not.toHaveProperty('senderName');
        vi.restoreAllMocks();
      }
    });

    it('rejects a different Google account, revokes its grant and removes the pending row', async () => {
      withStoredLicense();
      withMailbox();
      const update = vi.spyOn(prisma.mailbox, 'update');
      const deleteMany = vi.spyOn(prisma.mailbox, 'deleteMany').mockResolvedValue({ count: 1 });
      const calls = stubFetch({
        [`${RELAY}/api/connect/google/token`]: relayTokenRoute({
          email: 'someone@gmail.com',
          email_verified: true,
          aud: GOOGLE_CLIENT_ID,
        }),
        'https://oauth2.googleapis.com/revoke': () => new Response(null, { status: 200 }),
      });
      const response = await app.inject({
        method: 'GET',
        url: `/v1/oauth/google/connect-callback?code=c&state=${connectState()}`,
      });

      const params = errorParams(response.headers.location);
      expect(params.error).toBe('wrong_account');
      expect(params.detail).toContain('someone@gmail.com');
      expect(update).not.toHaveBeenCalled();
      expect(deleteMany).toHaveBeenCalled();
      const revoke = calls.find((c) => c.url === 'https://oauth2.googleapis.com/revoke')!;
      expect(String(revoke.init!.body)).toBe('token=1%2F%2Frefresh');
    });

    it('tells the buyer to tick the Gmail box when the relay reports scope_missing', async () => {
      withStoredLicense();
      withMailbox();
      vi.spyOn(prisma.mailbox, 'deleteMany').mockResolvedValue({ count: 1 });
      stubFetch({
        [`${RELAY}/api/connect/google/token`]: () => jsonResponse({ error: 'scope_missing' }, 400),
      });
      const response = await app.inject({
        method: 'GET',
        url: `/v1/oauth/google/connect-callback?code=c&state=${connectState()}`,
      });
      const params = errorParams(response.headers.location);
      expect(params.error).toBe('scope_missing');
      expect(params.detail).toMatch(/tick/i);
    });

    it.each([
      ['admin_policy_enforced', 'google_not_trusted'],
      ['access_denied', 'cancelled'],
    ])('maps Google error %s to %s', async (googleError, reason) => {
      const deleteMany = vi.spyOn(prisma.mailbox, 'deleteMany').mockResolvedValue({ count: 1 });
      const response = await app.inject({
        method: 'GET',
        url: `/v1/oauth/google/connect-callback?error=${googleError}&state=${connectState()}`,
      });
      expect(errorParams(response.headers.location).error).toBe(reason);
      expect(deleteMany).toHaveBeenCalled();
    });

    it('refuses a BYO state, and a Microsoft Connect state, on the Google Connect callback', async () => {
      for (const state of [
        signOAuthState({ mailboxId: 'mb-1', provider: 'GOOGLE_WORKSPACE' }),
        signOAuthState({ mailboxId: 'mb-1', provider: 'MICROSOFT_365', via: 'connect' }),
      ]) {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/oauth/google/connect-callback?code=c&state=${state}`,
        });
        expect(errorParams(response.headers.location).error).toBe('invalid_state');
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('GET /v1/oauth/microsoft/connect-callback', () => {
    const VERIFIER = 'v'.repeat(43);
    const connectState = () =>
      signOAuthState({
        mailboxId: 'mb-1',
        provider: 'MICROSOFT_365',
        via: 'connect',
        pkv: encrypt(VERIFIER, key()),
      });
    const tokenRoute: Route = () =>
      jsonResponse({
        access_token: 'graph-access',
        refresh_token: 'ms-refresh',
        expires_in: 3600,
        scope: 'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read',
      });

    it('redeems the code with the PKCE verifier and no secret, then checks the account', async () => {
      withStoredLicense();
      withMailbox('sales@acme.example');
      const update = vi.spyOn(prisma.mailbox, 'update').mockResolvedValue({} as never);
      const calls = stubFetch({
        [`${RELAY}/api/connect/config`]: configRoute,
        'https://login.microsoftonline.com/organizations/oauth2/v2.0/token': tokenRoute,
        'https://graph.microsoft.com/v1.0/me': () =>
          jsonResponse({
            mail: 'santhi@acme.example',
            userPrincipalName: 'santhi@acme.onmicrosoft.com',
            proxyAddresses: ['SMTP:santhi@acme.example', 'smtp:Sales@acme.example', 'X500:/o=x'],
            displayName: 'Santhi T.',
          }),
      });
      const response = await app.inject({
        method: 'GET',
        url: `/v1/oauth/microsoft/connect-callback?code=ms-code&state=${connectState()}`,
      });

      expect(errorParams(response.headers.location).connected).toBe('mb-1');
      const token = calls.find((c) => c.url.includes('/organizations/oauth2/v2.0/token'))!;
      const form = new URLSearchParams(String(token.init!.body));
      expect(form.get('client_id')).toBe(MICROSOFT_CLIENT_ID);
      expect(form.get('code_verifier')).toBe(VERIFIER);
      expect(form.get('redirect_uri')).toBe(`${RELAY}/connect/microsoft/callback`);
      expect(form.has('client_secret')).toBe(false);
      const { data } = update.mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(data).toMatchObject({
        provider: 'MICROSOFT_365',
        oauthVia: 'CONNECT',
        oauthClientId: MICROSOFT_CLIENT_ID,
      });
      expect(decrypt(data.oauthRefreshTokenEncrypted as string, key())).toBe('ms-refresh');
      expect(data).toMatchObject({ connectionError: null, connectionErrorAt: null });
      expect(data.senderName).toBe('Santhi T.');
      const me = calls.find((c) => c.url.startsWith('https://graph.microsoft.com/v1.0/me?'))!;
      expect(me.url).toContain('displayName');
    });

    it('refuses an account with no Exchange Online mailbox instead of showing it connected', async () => {
      withStoredLicense();
      withMailbox('sales@acme.example');
      const update = vi.spyOn(prisma.mailbox, 'update');
      const deleteMany = vi.spyOn(prisma.mailbox, 'deleteMany').mockResolvedValue({ count: 1 });
      stubFetch({
        [`${RELAY}/api/connect/config`]: configRoute,
        'https://login.microsoftonline.com/organizations/oauth2/v2.0/token': tokenRoute,
        'https://graph.microsoft.com/v1.0/me': () =>
          jsonResponse({ mail: null, userPrincipalName: 'sales@acme.example' }),
        'https://graph.microsoft.com/v1.0/me/mailboxSettings': () =>
          jsonResponse({ error: { code: 'MailboxNotEnabledForRESTAPI' } }, 404),
      });
      const response = await app.inject({
        method: 'GET',
        url: `/v1/oauth/microsoft/connect-callback?code=ms-code&state=${connectState()}`,
      });
      const params = errorParams(response.headers.location);
      expect(params.error).toBe('ms_no_mailbox');
      expect(params.detail).toMatch(/Exchange Online license/);
      expect(update).not.toHaveBeenCalled();
      expect(deleteMany).toHaveBeenCalled();
    });

    it('rejects an account that cannot send as the mailbox', async () => {
      withStoredLicense();
      withMailbox('sales@acme.example');
      const update = vi.spyOn(prisma.mailbox, 'update');
      vi.spyOn(prisma.mailbox, 'deleteMany').mockResolvedValue({ count: 1 });
      stubFetch({
        [`${RELAY}/api/connect/config`]: configRoute,
        'https://login.microsoftonline.com/organizations/oauth2/v2.0/token': tokenRoute,
        'https://graph.microsoft.com/v1.0/me': () =>
          jsonResponse({ mail: 'other@acme.example', userPrincipalName: 'other@acme.example' }),
      });
      const response = await app.inject({
        method: 'GET',
        url: `/v1/oauth/microsoft/connect-callback?code=ms-code&state=${connectState()}`,
      });
      const params = errorParams(response.headers.location);
      expect(params.error).toBe('wrong_account');
      expect(params.detail).toContain('other@acme.example');
      expect(update).not.toHaveBeenCalled();
    });

    it('shows the needs-admin state for AADSTS65001', async () => {
      vi.spyOn(prisma.mailbox, 'deleteMany').mockResolvedValue({ count: 1 });
      const description = encodeURIComponent(
        'AADSTS65001: The user or administrator has not consented.',
      );
      const response = await app.inject({
        method: 'GET',
        url: `/v1/oauth/microsoft/connect-callback?error=invalid_client&error_description=${description}&state=${connectState()}`,
      });
      expect(errorParams(response.headers.location).error).toBe('ms_admin_required');
    });

    it('treats a bare access_denied (the "Need admin approval" screen) as needs-admin', async () => {
      vi.spyOn(prisma.mailbox, 'deleteMany').mockResolvedValue({ count: 1 });
      const response = await app.inject({
        method: 'GET',
        url: `/v1/oauth/microsoft/connect-callback?error=access_denied&error_subcode=cancel&state=${connectState()}`,
      });
      const params = errorParams(response.headers.location);
      expect(params.error).toBe('ms_admin_required');
      expect(params.detail).toMatch(/Need admin approval/);
    });

    it('keeps a user declining consent (AADSTS65004) as a plain cancel', async () => {
      vi.spyOn(prisma.mailbox, 'deleteMany').mockResolvedValue({ count: 1 });
      const description = encodeURIComponent('AADSTS65004: User declined to consent.');
      const response = await app.inject({
        method: 'GET',
        url: `/v1/oauth/microsoft/connect-callback?error=access_denied&error_description=${description}&state=${connectState()}`,
      });
      expect(errorParams(response.headers.location).error).toBe('cancelled');
    });
  });
});
