/**
 * Regression guard for the client-IP fix in `app.ts`.
 *
 * `@fastify/rate-limit` keys on `request.ip`. Before this fix the app set no `trustProxy` and the
 * bundled nginx sent no `X-Forwarded-For`, so `request.ip` was always nginx's own container
 * address — every rate limit in the app was one bucket shared by every caller on earth. Nothing
 * looked broken: the limiter was registered, configured, and did fire, just against a subject that
 * was the same for everyone.
 *
 * The tests below pin the two halves of the answer that are easy to get subtly wrong:
 *
 *   1. the real client address is read from the END of the X-Forwarded-For chain, and
 *   2. an address a caller PREPENDS to that chain is ignored.
 *
 * Point 2 is the reason `trustProxy` is a hop count rather than `true`. With `true`, Fastify takes
 * the leftmost entry — fully caller-controlled — so anyone could mint a fresh rate-limit bucket per
 * request simply by varying a header, which is a worse bug than the one being fixed. The forged
 * chain in the second test is exactly what nginx forwards when a client sends its own
 * X-Forwarded-For: `$proxy_add_x_forwarded_for` appends the real peer, leaving the true client
 * last and the forgery first.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';

/** Builds the app and exposes the address the rate limiter would key on. */
async function appReportingIp(): Promise<FastifyInstance> {
  const app = await createApp();
  app.get('/__test/observed-ip', async (request) => ({ ip: request.ip }));
  return app;
}

async function observedIp(app: FastifyInstance, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: 'GET', url: '/__test/observed-ip', headers });
  return JSON.parse(res.body).ip as string;
}

describe('client address resolution behind the bundled proxy', () => {
  const originalHops = process.env.TRUST_PROXY_HOPS;
  const originalSecret = process.env.NEXTJS_CALLBACK_SECRET;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    process.env.NEXTJS_CALLBACK_SECRET = 'test-secret';
    delete process.env.TRUST_PROXY_HOPS;
  });

  afterEach(async () => {
    if (originalHops === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = originalHops;
    process.env.NEXTJS_CALLBACK_SECRET = originalSecret;
    await app?.close();
    app = undefined;
  });

  it('reads the caller address nginx appended, not nginx itself', async () => {
    app = await appReportingIp();
    expect(await observedIp(app, { 'x-forwarded-for': '203.0.113.7' })).toBe('203.0.113.7');
  });

  it('ignores an address the caller prepended to the chain', async () => {
    app = await appReportingIp();
    // What nginx forwards when the client sends `X-Forwarded-For: 9.9.9.9` itself: the forgery
    // first, the real peer appended last. Trusting one hop must yield the real peer.
    const ip = await observedIp(app, { 'x-forwarded-for': '9.9.9.9, 203.0.113.7' });
    expect(ip).toBe('203.0.113.7');
    expect(ip).not.toBe('9.9.9.9'); // what `trustProxy: true` would have returned
  });

  it('honours an extra trusted hop when something fronts the bundled nginx', async () => {
    process.env.TRUST_PROXY_HOPS = '2';
    app = await appReportingIp();
    // Two proxies (a CDN, then nginx) each appended one address, so the client is one further out.
    expect(await observedIp(app, { 'x-forwarded-for': '203.0.113.7, 10.0.0.9' })).toBe(
      '203.0.113.7',
    );
  });

  it('still identifies a direct caller when no proxy header is present', async () => {
    app = await appReportingIp();
    expect(await observedIp(app)).toBe('127.0.0.1');
  });

  it.each(['nope', '-1', '1.5'])('refuses to boot with TRUST_PROXY_HOPS=%s', async (value) => {
    process.env.TRUST_PROXY_HOPS = value;
    // Failing loudly at boot beats coercing: `0` would silently restore the single-shared-bucket
    // bug, and NaN surfaces much later as an error that never names this variable.
    await expect(createApp()).rejects.toThrow(/TRUST_PROXY_HOPS/);
  });
});
