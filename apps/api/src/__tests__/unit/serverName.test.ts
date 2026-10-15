import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkServerName,
  configuredServerName,
  ehloNameFor,
  resetServerNameCache,
  type ServerNameResolver,
} from '../../lib/serverName';

function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** A resolver answering from fixed tables; a missing entry is "no such record". */
function fakeResolver(
  a: Record<string, string[]>,
  aaaa: Record<string, string[]>,
  ptr: Record<string, string[] | Error>,
): ServerNameResolver {
  const lookup = (table: Record<string, string[]>) => async (name: string) => {
    if (!table[name]) throw dnsError('ENODATA');
    return table[name];
  };
  return {
    resolve4: lookup(a),
    resolve6: lookup(aaaa),
    reverse: async (ip) => {
      const answer = ptr[ip];
      if (answer instanceof Error) throw answer;
      if (!answer) throw dnsError('ENOTFOUND');
      return answer;
    },
  };
}

describe('serverName', () => {
  beforeEach(() => {
    resetServerNameCache();
    vi.stubEnv('WARMHAWK_DOMAIN', 'api.acme.example');
    vi.stubEnv('MAIL_SERVER_NAME', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads MAIL_SERVER_NAME lowercased, without a trailing dot, null when blank', () => {
    expect(configuredServerName({ MAIL_SERVER_NAME: ' Mail.Acme.Example. ' })).toBe(
      'mail.acme.example',
    );
    expect(configuredServerName({ MAIL_SERVER_NAME: '  ' })).toBeNull();
    expect(configuredServerName({})).toBeNull();
  });

  it('passes when every address the name points at has reverse DNS naming it back', async () => {
    const resolver = fakeResolver(
      { 'mail.acme.example': ['203.0.113.7'] },
      { 'mail.acme.example': ['2001:db8::7'] },
      { '203.0.113.7': ['Mail.Acme.Example.'], '2001:db8::7': ['mail.acme.example'] },
    );
    await expect(checkServerName('mail.acme.example', resolver)).resolves.toEqual({
      status: 'PASS',
      error: null,
    });
  });

  it('fails with the reverse DNS it found, so the owner knows what to change', async () => {
    const resolver = fakeResolver(
      { 'mail.acme.example': ['203.0.113.7'] },
      {},
      { '203.0.113.7': ['static.7.113.0.203.clients.host.example'] },
    );
    const check = await checkServerName('mail.acme.example', resolver);
    expect(check?.status).toBe('FAIL');
    expect(check?.error).toContain(
      'static.7.113.0.203.clients.host.example, not mail.acme.example',
    );
  });

  it('fails when the IPv6 address has no reverse DNS, even though IPv4 matches', async () => {
    const resolver = fakeResolver(
      { 'mail.acme.example': ['203.0.113.7'] },
      { 'mail.acme.example': ['2001:db8::7'] },
      { '203.0.113.7': ['mail.acme.example'] },
    );
    const check = await checkServerName('mail.acme.example', resolver);
    expect(check).toEqual({
      status: 'FAIL',
      error:
        "2001:db8::7 has no reverse DNS. Set it to mail.acme.example in your server host's control panel.",
    });
  });

  it('fails a name with no A record, and something that is not a host name', async () => {
    const resolver = fakeResolver({}, {}, {});
    expect((await checkServerName('mail.acme.example', resolver))?.error).toContain('no A record');
    expect((await checkServerName('localhost', resolver))?.error).toContain("isn't a host name");
  });

  it('keeps the last result (null) when DNS does not answer', async () => {
    const down = fakeResolver(
      { 'mail.acme.example': ['203.0.113.7'] },
      {},
      {
        '203.0.113.7': dnsError('ETIMEOUT'),
      },
    );
    await expect(checkServerName('mail.acme.example', down)).resolves.toBeNull();
    const servfail: ServerNameResolver = {
      ...fakeResolver({}, {}, {}),
      resolve4: async () => {
        throw dnsError('ESERVFAIL');
      },
    };
    await expect(checkServerName('mail.acme.example', servfail)).resolves.toBeNull();
  });

  it('EHLO: a checked link domain first, the install domain when no server name is set', async () => {
    await expect(
      ehloNameFor({ linkDomain: 'link.brand.example', linkDomainStatus: 'PASS' }),
    ).resolves.toBe('link.brand.example');
    await expect(
      ehloNameFor({ linkDomain: 'link.brand.example', linkDomainStatus: 'FAIL' }),
    ).resolves.toBe('api.acme.example');
    await expect(ehloNameFor(null)).resolves.toBe('api.acme.example');
    vi.stubEnv('WARMHAWK_DOMAIN', '');
    await expect(ehloNameFor(null)).resolves.toBeNull();
  });
});
