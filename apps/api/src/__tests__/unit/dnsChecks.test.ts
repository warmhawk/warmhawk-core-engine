import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:dns', () => ({
  default: {
    promises: {
      resolveTxt: vi.fn(),
      resolve4: vi.fn(),
    },
  },
}));

import dns from 'node:dns';
import { checkSpf, checkDkim, checkDmarc, checkBlocklists } from '../../lib/dnsChecks';

const mockedResolveTxt = dns.promises.resolveTxt as unknown as ReturnType<typeof vi.fn>;
const mockedResolve4 = dns.promises.resolve4 as unknown as ReturnType<typeof vi.fn>;

function enotfound() {
  const err = new Error('not found') as NodeJS.ErrnoException;
  err.code = 'ENOTFOUND';
  return err;
}

describe('SPF/DKIM/DMARC + blocklist DNS checks (mocked DNS layer)', () => {
  beforeEach(() => {
    mockedResolveTxt.mockReset();
    mockedResolve4.mockReset();
  });

  it('checkSpf passes when a v=spf1 TXT record exists', async () => {
    mockedResolveTxt.mockResolvedValueOnce([['v=spf1 include:_spf.example.com ~all']]);
    expect(await checkSpf('good-domain.com')).toBe('PASS');
  });

  it('checkSpf fails on a deliberately misconfigured domain with no matching TXT record', async () => {
    mockedResolveTxt.mockResolvedValueOnce([['some-unrelated-txt-record']]);
    expect(await checkSpf('misconfigured-domain.com')).toBe('FAIL');
  });

  it('checkSpf fails (not throws) on NXDOMAIN', async () => {
    mockedResolveTxt.mockRejectedValueOnce(enotfound());
    expect(await checkSpf('nonexistent-domain.com')).toBe('FAIL');
  });

  it('checkDkim passes when any candidate selector resolves', async () => {
    mockedResolveTxt
      .mockRejectedValueOnce(enotfound()) // default
      .mockResolvedValueOnce([['v=DKIM1; k=rsa; p=...']]); // google
    expect(await checkDkim('good-domain.com')).toBe('PASS');
  });

  it('checkDkim fails when no candidate selector resolves', async () => {
    mockedResolveTxt.mockRejectedValue(enotfound());
    expect(await checkDkim('misconfigured-domain.com')).toBe('FAIL');
  });

  it('checkDkim uses only the explicit selector when provided', async () => {
    mockedResolveTxt.mockResolvedValueOnce([['v=DKIM1; k=rsa; p=...']]);
    expect(await checkDkim('good-domain.com', 'custom-selector')).toBe('PASS');
    expect(mockedResolveTxt).toHaveBeenCalledWith('custom-selector._domainkey.good-domain.com');
  });

  it('checkDmarc passes when a v=DMARC1 TXT record exists at _dmarc', async () => {
    mockedResolveTxt.mockResolvedValueOnce([['v=DMARC1; p=none;']]);
    expect(await checkDmarc('good-domain.com')).toBe('PASS');
  });

  it('checkDmarc fails on a misconfigured domain with no DMARC record', async () => {
    mockedResolveTxt.mockRejectedValueOnce(enotfound());
    expect(await checkDmarc('misconfigured-domain.com')).toBe('FAIL');
  });

  it('checkBlocklists returns PASS for every source when nothing resolves (not listed)', async () => {
    mockedResolve4.mockResolvedValue(['203.0.113.5']); // for the domain's own A record lookup
    mockedResolve4.mockImplementation(async (query: string) => {
      if (query === 'good-domain.com') return ['203.0.113.5'];
      const err = enotfound();
      throw err;
    });
    const result = await checkBlocklists('good-domain.com');
    expect(Object.values(result).every((status) => status === 'PASS')).toBe(true);
  });

  it('checkBlocklists returns FAIL for a source that resolves (listed)', async () => {
    mockedResolve4.mockImplementation(async (query: string) => {
      if (query === 'listed-domain.com') return ['198.51.100.9'];
      if (query.endsWith('zen.spamhaus.org')) return ['127.0.0.2']; // listed
      throw enotfound();
    });
    const result = await checkBlocklists('listed-domain.com');
    expect(result.spamhausZen).toBe('FAIL');
  });
});
