import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkLinkDomain,
  linkDomainProof,
  linkHostFor,
  normalizeLinkDomain,
} from '../../lib/linkDomain';

describe('linkDomain', () => {
  const saved = { secret: process.env.JWT_SECRET, domain: process.env.WARMHAWK_DOMAIN };

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-only-not-a-real-secret-value';
    process.env.WARMHAWK_DOMAIN = 'api.acme.example';
  });

  afterEach(() => {
    if (saved.secret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = saved.secret;
    if (saved.domain === undefined) delete process.env.WARMHAWK_DOMAIN;
    else process.env.WARMHAWK_DOMAIN = saved.domain;
  });

  it('cleans up a typed host and refuses what is not one', () => {
    expect(normalizeLinkDomain(' Link.Brand.Example ')).toBe('link.brand.example');
    expect(normalizeLinkDomain('https://link.brand.example/unsubscribe/')).toBe(
      'link.brand.example',
    );
    expect(normalizeLinkDomain('link.brand.example.')).toBe('link.brand.example');
    expect(normalizeLinkDomain('')).toBeNull();
    expect(normalizeLinkDomain(null)).toBeNull();
    expect(normalizeLinkDomain('localhost')).toBeUndefined();
    expect(normalizeLinkDomain('link_brand.example')).toBeUndefined();
    expect(normalizeLinkDomain('link.brand.example:8443')).toBeUndefined();
    expect(normalizeLinkDomain('-link.brand.example')).toBeUndefined();
    expect(normalizeLinkDomain(42)).toBeUndefined();
  });

  it('picks the link domain only on PASS, else the install domain, else nothing', () => {
    expect(linkHostFor({ linkDomain: 'link.brand.example', linkDomainStatus: 'PASS' })).toBe(
      'link.brand.example',
    );
    expect(linkHostFor({ linkDomain: 'link.brand.example', linkDomainStatus: 'PENDING' })).toBe(
      'api.acme.example',
    );
    expect(linkHostFor({ linkDomain: 'link.brand.example', linkDomainStatus: 'FAIL' })).toBe(
      'api.acme.example',
    );
    expect(linkHostFor(null)).toBe('api.acme.example');
    delete process.env.WARMHAWK_DOMAIN;
    expect(linkHostFor(undefined)).toBeNull();
  });

  /** A fetch that answers the ping the way a host routed to this install (or not) would. */
  function fakeFetch(answer: (nonce: string) => Response | Promise<Response>): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/unsubscribe/ping');
      expect(url.protocol).toBe('https:');
      return answer(url.searchParams.get('n') ?? '');
    }) as typeof fetch;
  }

  it('passes a host that answers with this install’s proof', async () => {
    const result = await checkLinkDomain(
      'link.brand.example',
      fakeFetch((nonce) => new Response(`${linkDomainProof(nonce)}\n`)),
    );
    expect(result).toEqual({ status: 'PASS', error: null });
  });

  it('fails a host that answers from another server', async () => {
    const result = await checkLinkDomain(
      'link.brand.example',
      fakeFetch(() => new Response('hello')),
    );
    expect(result.status).toBe('FAIL');
    expect(result.error).toContain('different server');
  });

  it('fails a host that answers without the ping page, and does not follow redirects', async () => {
    const notFound = await checkLinkDomain(
      'link.brand.example',
      fakeFetch(() => new Response('nope', { status: 404 })),
    );
    expect(notFound.error).toContain('HTTP 404');
    const moved = await checkLinkDomain(
      'link.brand.example',
      fakeFetch(
        () => new Response(null, { status: 301, headers: { location: 'https://x.example' } }),
      ),
    );
    expect(moved.error).toContain('HTTP 301');
  });

  it('says in plain words why a host could not be reached', async () => {
    const failWith = (code: string) =>
      fakeFetch(() => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code } });
      });
    expect((await checkLinkDomain('link.brand.example', failWith('ENOTFOUND'))).error).toContain(
      'no DNS record',
    );
    expect(
      (await checkLinkDomain('link.brand.example', failWith('ERR_TLS_CERT_ALTNAME_INVALID'))).error,
    ).toContain('warmhawk link-domain add link.brand.example');
    expect((await checkLinkDomain('link.brand.example', failWith('ECONNREFUSED'))).error).toContain(
      'refuses',
    );
    const timedOut = fakeFetch(() => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    expect((await checkLinkDomain('link.brand.example', timedOut)).error).toContain(
      "didn't answer",
    );
  });

  it('signs each nonce differently and only with this install’s secret', () => {
    const proof = linkDomainProof('nonce-aaaaaaaaaaaaaaaa');
    expect(linkDomainProof('nonce-bbbbbbbbbbbbbbbb')).not.toBe(proof);
    process.env.JWT_SECRET = 'a-different-secret';
    expect(linkDomainProof('nonce-aaaaaaaaaaaaaaaa')).not.toBe(proof);
  });
});
