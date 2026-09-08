/**
 * Unit tests for `lib/rdap.ts#checkRdapRegistration` — `fetchImpl` is injected directly (same DI
 * pattern as `lib/alertWebhook.ts#postDomainChangeAlert`), so these never touch the real network.
 * Covers all three outcomes, and specifically asserts that a network error/timeout/non-404/
 * non-200 response resolves to `"unknown"`, never `"unregistered"` — see that file's header
 * comment for why silently treating an inconclusive check as "unregistered" would be a real
 * security-relevant bug (a false "safe" reading on an actual lookalike domain).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { checkRdapRegistration, resetRdapBootstrapCacheForTests } from '../../lib/rdap';

const BOOTSTRAP_DOC = {
  services: [[['com', 'net'], ['https://rdap.example-registry.test/rdap']]],
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function plainResponse(status: number) {
  return { ok: status >= 200 && status < 300, status } as Response;
}

beforeEach(() => {
  resetRdapBootstrapCacheForTests();
});

describe('checkRdapRegistration', () => {
  it('resolves "registered" on a 200 from the RDAP server', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, BOOTSTRAP_DOC))
      .mockResolvedValueOnce(plainResponse(200));

    const result = await checkRdapRegistration('taken-lookalike.com', fetchImpl);

    expect(result).toBe('registered');
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://data.iana.org/rdap/dns.json');
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://rdap.example-registry.test/rdap/domain/taken-lookalike.com',
    );
  });

  it('resolves "unregistered" on a 404 from the RDAP server', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, BOOTSTRAP_DOC))
      .mockResolvedValueOnce(plainResponse(404));

    const result = await checkRdapRegistration('free-lookalike.com', fetchImpl);

    expect(result).toBe('unregistered');
  });

  it('resolves "unknown" — never "unregistered" — when the per-domain fetch throws (network error)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, BOOTSTRAP_DOC))
      .mockRejectedValueOnce(new Error('network timeout'));

    const result = await checkRdapRegistration('flaky-lookalike.com', fetchImpl);

    expect(result).toBe('unknown');
    expect(result).not.toBe('unregistered');
  });

  it('resolves "unknown" on a non-404/non-200 response (e.g. 500)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, BOOTSTRAP_DOC))
      .mockResolvedValueOnce(plainResponse(500));

    const result = await checkRdapRegistration('server-error-lookalike.com', fetchImpl);

    expect(result).toBe('unknown');
  });

  it('resolves "unknown" when the bootstrap lookup itself fails (network error)', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('bootstrap unreachable'));

    const result = await checkRdapRegistration('example.com', fetchImpl);

    expect(result).toBe('unknown');
    expect(fetchImpl).toHaveBeenCalledTimes(1); // never reached the per-domain call
  });

  it('resolves "unknown" when the bootstrap document has no RDAP server for the TLD', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, BOOTSTRAP_DOC));

    const result = await checkRdapRegistration('lookalike.zzz-unknown-tld', fetchImpl);

    expect(result).toBe('unknown');
  });

  it('resolves "unknown" when the bootstrap response is not ok', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(plainResponse(503));

    const result = await checkRdapRegistration('example.com', fetchImpl);

    expect(result).toBe('unknown');
  });

  it('caches the bootstrap lookup across calls within the same process', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, BOOTSTRAP_DOC))
      .mockResolvedValueOnce(plainResponse(404))
      .mockResolvedValueOnce(plainResponse(200));

    await checkRdapRegistration('first-lookalike.com', fetchImpl);
    await checkRdapRegistration('second-lookalike.com', fetchImpl);

    // 1 bootstrap fetch + 2 per-domain fetches = 3 total, not 4 — the second call never re-fetches
    // the bootstrap document.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
