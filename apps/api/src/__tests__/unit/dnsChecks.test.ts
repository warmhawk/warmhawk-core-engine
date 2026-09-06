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

function dnsError(code: string) {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

const enotfound = () => dnsError('ENOTFOUND');
const servfail = () => dnsError('ESERVFAIL');

describe('SPF/DKIM/DMARC + blocklist DNS checks (mocked DNS layer)', () => {
  beforeEach(() => {
    mockedResolveTxt.mockReset();
    mockedResolve4.mockReset();
  });

  describe('checkSpf', () => {
    it('passes when a v=spf1 TXT record exists', async () => {
      mockedResolveTxt.mockResolvedValueOnce([['v=spf1 include:_spf.example.com ~all']]);
      expect(await checkSpf('good-domain.com')).toBe('PASS');
    });

    it('fails on a deliberately misconfigured domain with no matching TXT record', async () => {
      mockedResolveTxt.mockResolvedValueOnce([['some-unrelated-txt-record']]);
      expect(await checkSpf('misconfigured-domain.com')).toBe('FAIL');
    });

    it('fails (not throws) on NXDOMAIN — absence of SPF is a real finding', async () => {
      mockedResolveTxt.mockRejectedValueOnce(enotfound());
      expect(await checkSpf('nonexistent-domain.com')).toBe('FAIL');
    });

    it('is PENDING, not FAIL, when the lookup itself fails', async () => {
      mockedResolveTxt.mockRejectedValueOnce(servfail());
      expect(await checkSpf('good-domain.com')).toBe('PENDING');
    });
  });

  describe('checkDkim', () => {
    it('passes when any candidate selector resolves', async () => {
      mockedResolveTxt.mockImplementation(async (name: string) =>
        name.startsWith('google.') ? [['v=DKIM1; k=rsa; p=...']] : Promise.reject(enotfound()),
      );
      expect(await checkDkim('good-domain.com')).toBe('PASS');
    });

    it('is PENDING when no guessed selector resolves — selectors are not enumerable', async () => {
      mockedResolveTxt.mockRejectedValue(enotfound());
      expect(await checkDkim('unknown-selector-domain.com')).toBe('PENDING');
    });

    it('queries the nine candidates in parallel, not serially', async () => {
      mockedResolveTxt.mockRejectedValue(enotfound());
      await checkDkim('good-domain.com');
      expect(mockedResolveTxt).toHaveBeenCalledTimes(9);
    });

    it('uses only the explicit selector when provided', async () => {
      mockedResolveTxt.mockResolvedValueOnce([['v=DKIM1; k=rsa; p=...']]);
      expect(await checkDkim('good-domain.com', 'custom-selector')).toBe('PASS');
      expect(mockedResolveTxt).toHaveBeenCalledTimes(1);
      expect(mockedResolveTxt).toHaveBeenCalledWith('custom-selector._domainkey.good-domain.com');
    });

    it('FAILS an explicit selector that does not resolve — the caller named it', async () => {
      mockedResolveTxt.mockRejectedValueOnce(enotfound());
      expect(await checkDkim('good-domain.com', 'wrong-selector')).toBe('FAIL');
    });
  });

  describe('checkDmarc', () => {
    it('passes when a v=DMARC1 TXT record exists at _dmarc', async () => {
      mockedResolveTxt.mockResolvedValueOnce([['v=DMARC1; p=none;']]);
      expect(await checkDmarc('good-domain.com')).toBe('PASS');
    });

    it('fails on a misconfigured domain with no DMARC record', async () => {
      mockedResolveTxt.mockRejectedValueOnce(enotfound());
      expect(await checkDmarc('misconfigured-domain.com')).toBe('FAIL');
    });

    it('is PENDING, not FAIL, when the lookup itself fails', async () => {
      mockedResolveTxt.mockRejectedValueOnce(servfail());
      expect(await checkDmarc('good-domain.com')).toBe('PENDING');
    });
  });

  describe('checkBlocklists', () => {
    it('PASSes when the zone has no record for the domain (not listed)', async () => {
      mockedResolve4.mockRejectedValue(enotfound());
      expect(await checkBlocklists('good-domain.com')).toEqual({ spamhausDbl: 'PASS' });
    });

    it('FAILs on a genuine listing code', async () => {
      mockedResolve4.mockResolvedValue(['127.0.1.2']);
      expect(await checkBlocklists('listed-domain.com')).toEqual({ spamhausDbl: 'FAIL' });
    });

    // The defect this whole change exists for. Through a shared resolver every Spamhaus query
    // answers 127.255.255.254; the old code read that as a listing and reported EVERY domain as
    // blocklisted.
    it.each(['127.255.255.252', '127.255.255.254', '127.255.255.255'])(
      'is PENDING, never FAIL, for the query-refused code %s',
      async (code) => {
        mockedResolve4.mockResolvedValue([code]);
        expect(await checkBlocklists('any-domain.com')).toEqual({ spamhausDbl: 'PENDING' });
      },
    );

    it('is PENDING when the lookup errors — a dead zone is not a clean result', async () => {
      mockedResolve4.mockRejectedValue(servfail());
      expect(await checkBlocklists('any-domain.com')).toEqual({ spamhausDbl: 'PENDING' });
    });

    it('never resolves the domain A record — the website is not the sender', async () => {
      mockedResolve4.mockRejectedValue(enotfound());
      await checkBlocklists('good-domain.com');
      for (const [query] of mockedResolve4.mock.calls) {
        expect(query).toMatch(/\.dbl\.spamhaus\.org$/);
      }
    });

    it('queries no retired or IP-based zone', async () => {
      mockedResolve4.mockRejectedValue(enotfound());
      await checkBlocklists('good-domain.com');
      const queried = mockedResolve4.mock.calls.map(([q]) => q).join(' ');
      expect(queried).not.toMatch(/sorbs|barracuda|zen\.spamhaus/);
    });

    it('does not throw when a source rejects outright', async () => {
      mockedResolve4.mockImplementation(() => {
        throw new Error('socket hang up');
      });
      await expect(checkBlocklists('any-domain.com')).resolves.toEqual({ spamhausDbl: 'PENDING' });
    });
  });
});
