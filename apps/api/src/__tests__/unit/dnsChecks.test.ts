import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:dns', () => ({
  default: {
    promises: {
      resolveTxt: vi.fn(),
      resolve4: vi.fn(),
      // Rejecting by default: no authoritative nameserver set, so DNSBL queries go through the
      // mocked `resolve4` above and the canary decides whether its answers count.
      resolveNs: vi.fn(),
      Resolver: vi.fn(),
    },
  },
}));

import dns from 'node:dns';
import {
  checkSpf,
  checkDkim,
  checkDmarc,
  checkBlocklists,
  normalizeDkimSelector,
  resetDnsblResolverCache,
  DKIM_SELECTOR_CANDIDATES,
} from '../../lib/dnsChecks';

const mockedResolveTxt = dns.promises.resolveTxt as unknown as ReturnType<typeof vi.fn>;
const mockedResolve4 = dns.promises.resolve4 as unknown as ReturnType<typeof vi.fn>;
const mockedResolveNs = dns.promises.resolveNs as unknown as ReturnType<typeof vi.fn>;

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
    mockedResolveNs.mockReset();
    mockedResolveNs.mockRejectedValue(servfail());
    resetDnsblResolverCache();
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

    it('queries every candidate in parallel, not serially', async () => {
      mockedResolveTxt.mockRejectedValue(enotfound());
      await checkDkim('good-domain.com');
      expect(mockedResolveTxt).toHaveBeenCalledTimes(DKIM_SELECTOR_CANDIDATES.length);
    });

    // Domains that only receive through Cloudflare Email Routing publish their sole key at
    // `cf2024-1`; before it was a candidate they sat at PENDING despite a valid key.
    it('finds the Cloudflare Email Routing selector', async () => {
      mockedResolveTxt.mockImplementation(async (name: string) =>
        name.startsWith('cf2024-1.')
          ? [['v=DKIM1; h=sha256; k=rsa; p=MIIB']]
          : Promise.reject(enotfound()),
      );
      expect(await checkDkim('good-domain.com')).toBe('PASS');
    });

    it('does not PASS a revoked key (empty p=) under a guessed selector', async () => {
      mockedResolveTxt.mockImplementation(async (name: string) =>
        name.startsWith('default.') ? [['v=DKIM1; p=']] : Promise.reject(enotfound()),
      );
      expect(await checkDkim('example.com')).toBe('PENDING');
    });

    it('does not read an unrelated TXT record sharing the name as a key', async () => {
      mockedResolveTxt.mockImplementation(async (name: string) =>
        name.startsWith('mail.') ? [['v=spf1 ip4=1.2.3.4 -all']] : Promise.reject(enotfound()),
      );
      expect(await checkDkim('example.com')).toBe('PENDING');
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

    it('FAILS a revoked key under an explicit selector', async () => {
      mockedResolveTxt.mockResolvedValueOnce([['v=DKIM1; k=rsa; p=']]);
      expect(await checkDkim('good-domain.com', 'old')).toBe('FAIL');
    });

    it('is PENDING when the explicit selector lookup itself fails', async () => {
      mockedResolveTxt.mockRejectedValueOnce(servfail());
      expect(await checkDkim('good-domain.com', 'mine')).toBe('PENDING');
    });
  });

  describe('normalizeDkimSelector', () => {
    it.each([
      [undefined, null],
      [null, null],
      ['  ', null],
      ['S1', 's1'],
      ['abc123.pm', 'abc123.pm'],
      ['s1._domainkey', 's1'],
      ['s1._domainkey.example.com', 's1'],
    ])('%j -> %j', (input, expected) => {
      expect(normalizeDkimSelector(input)).toBe(expected);
    });

    it.each(['has space', 'semi;colon', '-leading', 'a..b', 42])('rejects %j', (input) => {
      expect(normalizeDkimSelector(input)).toBeUndefined();
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
    const CANARY = 'dbltest.com.dbl.spamhaus.org';

    /** Answers the zone's always-listed canary as listed, and the domain with `domain`. */
    function zoneAnswers(domain: () => Promise<string[]>, canary = async () => ['127.0.1.2']) {
      mockedResolve4.mockImplementation((query: string) =>
        query === CANARY ? canary() : domain(),
      );
    }

    it('PASSes when the zone has no record for the domain (not listed)', async () => {
      zoneAnswers(() => Promise.reject(enotfound()));
      expect(await checkBlocklists('good-domain.com')).toEqual({ spamhausDbl: 'PASS' });
    });

    it('FAILs on a genuine listing code', async () => {
      zoneAnswers(async () => ['127.0.1.2']);
      expect(await checkBlocklists('listed-domain.com')).toEqual({ spamhausDbl: 'FAIL' });
    });

    // Through a shared resolver every Spamhaus query answers 127.255.255.254; an earlier version
    // read that as a listing and reported EVERY domain as blocklisted.
    it.each(['127.255.255.252', '127.255.255.254', '127.255.255.255'])(
      'is PENDING, never FAIL, for the query-refused code %s',
      async (code) => {
        mockedResolve4.mockResolvedValue([code]);
        expect(await checkBlocklists('any-domain.com')).toEqual({ spamhausDbl: 'PENDING' });
      },
    );

    // Google 8.8.8.8 answers NXDOMAIN even for the zone's own test listing. Read naively, that is
    // a green PASS for a domain that may well be listed.
    it('is PENDING, not PASS, when the resolver hides the canary listing too', async () => {
      mockedResolve4.mockRejectedValue(enotfound());
      expect(await checkBlocklists('any-domain.com')).toEqual({ spamhausDbl: 'PENDING' });
    });

    it('is PENDING when the lookup errors — a dead zone is not a clean result', async () => {
      zoneAnswers(() => Promise.reject(servfail()));
      expect(await checkBlocklists('any-domain.com')).toEqual({ spamhausDbl: 'PENDING' });
    });

    it('asks the zone nameservers directly when they can be found', async () => {
      mockedResolveNs.mockResolvedValue(['a.gns.spamhaus.org']);
      mockedResolve4.mockImplementation(async (query: string) => {
        if (query === 'a.gns.spamhaus.org') return ['192.0.2.53'];
        throw new Error(`system resolver must not be asked for ${query}`);
      });
      const setServers = vi.fn();
      const resolve4 = vi.fn(async (query: string) => {
        if (query === CANARY) return ['127.0.1.2'];
        throw enotfound();
      });
      (dns.promises.Resolver as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        function () {
          return { setServers, resolve4 };
        },
      );
      expect(await checkBlocklists('good-domain.com')).toEqual({ spamhausDbl: 'PASS' });
      expect(setServers).toHaveBeenCalledWith(['192.0.2.53']);
      expect(resolve4).toHaveBeenCalledWith('good-domain.com.dbl.spamhaus.org');
    });

    it('never resolves the domain A record — the website is not the sender', async () => {
      zoneAnswers(() => Promise.reject(enotfound()));
      await checkBlocklists('good-domain.com');
      for (const [query] of mockedResolve4.mock.calls) {
        expect(query).toMatch(/\.dbl\.spamhaus\.org$/);
      }
    });

    it('queries no retired or IP-based zone', async () => {
      zoneAnswers(() => Promise.reject(enotfound()));
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
