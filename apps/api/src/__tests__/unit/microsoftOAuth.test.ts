import { describe, it, expect, beforeEach, vi } from 'vitest';

// resolveMicrosoftOAuthCredentials() checks for an in-app-wizard-saved OAuthClientConfig row
// before falling back to env vars (friction-reduction, 2026-09-09) — mocked here so this stays a
// real unit test (no live DB), consistent with this repo's "mock/stub the actual provider call,
// don't make a real one" convention. Resolves null (no DB override) so every test below still
// exercises the env-var fallback path it was originally written for.
vi.mock('@warmhawk/db', () => ({
  prisma: { oAuthClientConfig: { findUnique: vi.fn().mockResolvedValue(null) } },
}));

import {
  buildMicrosoftAuthUrl,
  exchangeMicrosoftCode,
  mintMicrosoftAccessToken,
  MICROSOFT_OAUTH_SCOPES,
} from '../../lib/microsoftOAuth';

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe('Microsoft 365 OAuth (token exchange/refresh — HTTP boundary mocked, never live)', () => {
  beforeEach(() => {
    process.env.MICROSOFT_OAUTH_CLIENT_ID = 'test-client-id';
    process.env.MICROSOFT_OAUTH_CLIENT_SECRET = 'test-client-secret';
    process.env.MICROSOFT_OAUTH_REDIRECT_URI = 'https://app.example.com/oauth/microsoft/callback';
  });

  it('buildMicrosoftAuthUrl targets the mailbox tenant and includes required scopes and state', async () => {
    const url = await buildMicrosoftAuthUrl('state-123', 'sales@Contoso.com');
    expect(url).toContain('https://login.microsoftonline.com/contoso.com/oauth2/v2.0/authorize');
    expect(url).toContain('state=state-123');
    expect(new URL(url).searchParams.get('login_hint')).toBe('sales@Contoso.com');
    for (const scope of MICROSOFT_OAUTH_SCOPES) {
      expect(decodeURIComponent(url)).toContain(scope);
    }
  });

  it('exchangeMicrosoftCode returns refresh/access tokens on a successful mocked response', async () => {
    const fetchImpl = mockFetchOnce({
      refresh_token: 'rt_abc',
      access_token: 'at_abc',
      expires_in: 3600,
      scope: MICROSOFT_OAUTH_SCOPES.join(' '),
    });
    const result = await exchangeMicrosoftCode('auth-code-xyz', 'sales@contoso.com', fetchImpl);
    expect(result.refreshToken).toBe('rt_abc');
    expect(result.accessToken).toBe('at_abc');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://login.microsoftonline.com/contoso.com/oauth2/v2.0/token',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('exchangeMicrosoftCode throws when the token endpoint responds non-OK', async () => {
    const fetchImpl = mockFetchOnce({}, false, 400);
    await expect(exchangeMicrosoftCode('bad-code', 'sales@contoso.com', fetchImpl)).rejects.toThrow(
      /responded with 400/,
    );
  });

  it('exchangeMicrosoftCode throws when no refresh_token is returned (missing offline_access)', async () => {
    const fetchImpl = mockFetchOnce({ access_token: 'at_only' });
    await expect(exchangeMicrosoftCode('code', 'sales@contoso.com', fetchImpl)).rejects.toThrow(
      /did not return a refresh_token/,
    );
  });

  it('mintMicrosoftAccessToken refreshes and returns a new access token', async () => {
    const fetchImpl = mockFetchOnce({ access_token: 'fresh_at_123' });
    const token = await mintMicrosoftAccessToken('stored-refresh-token', 'sales@contoso.com', 'graph', fetchImpl);
    expect(token).toBe('fresh_at_123');
  });

  it('mintMicrosoftAccessToken asks for exactly one resource per token (Graph to send, IMAP to read)', async () => {
    const scopeOf = (fetchImpl: typeof fetch) =>
      new URLSearchParams(
        (vi.mocked(fetchImpl).mock.calls[0][1] as RequestInit).body as string,
      ).get('scope');

    const graphFetch = mockFetchOnce({ access_token: 'at' });
    await mintMicrosoftAccessToken('rt', 'sales@contoso.com', 'graph', graphFetch);
    expect(scopeOf(graphFetch)).toBe('offline_access https://graph.microsoft.com/Mail.Send');
    expect(vi.mocked(graphFetch).mock.calls[0][0]).toBe(
      'https://login.microsoftonline.com/contoso.com/oauth2/v2.0/token',
    );

    const imapFetch = mockFetchOnce({ access_token: 'at' });
    await mintMicrosoftAccessToken('rt', 'sales@contoso.com', 'imap', imapFetch);
    expect(scopeOf(imapFetch)).toBe('offline_access https://outlook.office.com/IMAP.AccessAsUser.All');
  });

  it('mintMicrosoftAccessToken throws when the refresh response has no access_token', async () => {
    const fetchImpl = mockFetchOnce({});
    await expect(mintMicrosoftAccessToken('stored-refresh-token', 'sales@contoso.com', 'imap', fetchImpl)).rejects.toThrow(
      /did not return an access_token/,
    );
  });

  it('mintMicrosoftAccessToken throws on a non-OK refresh response', async () => {
    const fetchImpl = mockFetchOnce({}, false, 401);
    await expect(mintMicrosoftAccessToken('expired-refresh-token', 'sales@contoso.com', 'graph', fetchImpl)).rejects.toThrow(
      /responded with 401/,
    );
  });
});
