/**
 * WarmHawk Connect access tokens (lib/mailboxAccessToken.ts + lib/accessTokenCache.ts): Connect
 * mailboxes refresh through the relay (Google) or as WarmHawk's public client (Microsoft), cached
 * until 5 minutes before expiry. The relay and Microsoft are a stubbed global `fetch`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prisma } from '@warmhawk/db';
import { encrypt, decrypt, loadEncryptionKey } from '../../lib/encryption';
import { mintMailboxAccessToken, type OAuthMailbox } from '../../lib/mailboxAccessToken';
import { cachedAccessToken, clearAccessTokenCache } from '../../lib/accessTokenCache';

const KEY_B64 = Buffer.alloc(32, 9).toString('base64');
const RELAY = 'https://relay.test';

function key() {
  return loadEncryptionKey(KEY_B64);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mailbox(overrides: Partial<OAuthMailbox> = {}): OAuthMailbox {
  return {
    id: 'mb-1',
    email: 'sales@acme.example',
    provider: 'GOOGLE_WORKSPACE',
    oauthVia: 'CONNECT',
    oauthClientId: 'client-id',
    oauthConnectedAt: new Date('2026-09-27T12:00:00Z'),
    oauthRefreshTokenEncrypted: encrypt('refresh-1', key()),
    ...overrides,
  };
}

describe('cachedAccessToken', () => {
  beforeEach(() => clearAccessTokenCache());

  it('reuses a token until 5 minutes before it expires', async () => {
    let now = 0;
    const mint = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: 'a', expiresInSeconds: 3600 })
      .mockResolvedValueOnce({ accessToken: 'b', expiresInSeconds: 3600 });
    expect(await cachedAccessToken('k', mint, () => now)).toBe('a');
    now = 54 * 60 * 1000;
    expect(await cachedAccessToken('k', mint, () => now)).toBe('a');
    now = 56 * 60 * 1000;
    expect(await cachedAccessToken('k', mint, () => now)).toBe('b');
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight mint between concurrent callers', async () => {
    const mint = vi.fn().mockResolvedValue({ accessToken: 'a', expiresInSeconds: 3600 });
    const tokens = await Promise.all([cachedAccessToken('k', mint), cachedAccessToken('k', mint)]);
    expect(tokens).toEqual(['a', 'a']);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed mint', async () => {
    const mint = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ accessToken: 'a', expiresInSeconds: 3600 });
    await expect(cachedAccessToken('k', mint)).rejects.toThrow('down');
    expect(await cachedAccessToken('k', mint)).toBe('a');
  });
});

describe('mintMailboxAccessToken', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.MAILBOX_CREDENTIAL_KEY = KEY_B64;
    clearAccessTokenCache();
    vi.spyOn(prisma.instanceSettings, 'findUnique').mockResolvedValue({
      connectLicenseEncrypted: encrypt('license-token', key()),
      connectRelayBaseUrl: RELAY,
    } as never);
  });

  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('refreshes a Google Connect mailbox through the relay once, for both send and IMAP', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: 'ya29.fresh', expires_in: 3599 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await mintMailboxAccessToken(mailbox(), 'send')).toBe('ya29.fresh');
    expect(await mintMailboxAccessToken(mailbox(), 'imap')).toBe('ya29.fresh');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${RELAY}/api/connect/google/token`);
    expect(JSON.parse(String(init.body))).toEqual({ grant: 'refresh', refreshToken: 'refresh-1' });
  });

  it('mints a new token after the mailbox is reconnected', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'old', expires_in: 3599 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'new', expires_in: 3599 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await mintMailboxAccessToken(mailbox(), 'send')).toBe('old');
    const reconnected = mailbox({ oauthConnectedAt: new Date('2026-09-27T13:00:00Z') });
    expect(await mintMailboxAccessToken(reconnected, 'send')).toBe('new');
  });

  it('says to reconnect when Google no longer accepts the grant', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, 400)),
    );
    await expect(mintMailboxAccessToken(mailbox(), 'send')).rejects.toThrow(/Reconnect it/);
  });

  it('refreshes Microsoft Connect as a public client per resource and stores the rotated token', async () => {
    const update = vi.spyOn(prisma.mailbox, 'update').mockResolvedValue({} as never);
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: 'ms-access', refresh_token: 'refresh-2', expires_in: 3600 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const ms = mailbox({ provider: 'MICROSOFT_365', oauthClientId: 'ms-client' });

    expect(await mintMailboxAccessToken(ms, 'send')).toBe('ms-access');
    expect(await mintMailboxAccessToken(ms, 'send')).toBe('ms-access');
    expect(await mintMailboxAccessToken(ms, 'imap')).toBe('ms-access');

    // One refresh per resource: Graph for sending, outlook.office.com for IMAP.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const forms = fetchMock.mock.calls.map(
      (call) => new URLSearchParams(String((call as unknown as [string, RequestInit])[1].body)),
    );
    expect(forms[0]!.get('scope')).toContain('https://graph.microsoft.com/Mail.Send');
    expect(forms[1]!.get('scope')).toContain('https://outlook.office.com/IMAP.AccessAsUser.All');
    for (const form of forms) {
      expect(form.get('client_id')).toBe('ms-client');
      expect(form.has('client_secret')).toBe(false);
    }
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://login.microsoftonline.com/acme.example/oauth2/v2.0/token',
    );
    const { data } = update.mock.calls[0]![0] as { data: { oauthRefreshTokenEncrypted: string } };
    expect(decrypt(data.oauthRefreshTokenEncrypted, key())).toBe('refresh-2');
  });
});
