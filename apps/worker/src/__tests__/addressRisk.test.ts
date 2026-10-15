import { describe, expect, it } from 'vitest';
import type IORedis from 'ioredis';
import { isUnprobeableDomain, riskyLeadIds, rememberVerdict } from '../addressRisk';

/** Just enough of ioredis for the risk lookups. */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    redis: {
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: string) => (store.set(key, value), 'OK'),
      mget: async (...keys: string[]) => keys.map((key) => store.get(key) ?? null),
    } as unknown as IORedis,
  };
}

describe('isUnprobeableDomain', () => {
  it('knows the providers that say yes to every address', () => {
    for (const domain of ['yahoo.com', 'yahoo.co.uk', 'aol.com', 'att.net', 'sbcglobal.net']) {
      expect(isUnprobeableDomain(domain)).toBe(true);
    }
    expect(isUnprobeableDomain('gmail.com')).toBe(false);
    expect(isUnprobeableDomain('notyahoo.com')).toBe(false);
  });
});

describe('riskyLeadIds', () => {
  it('flags catch-all verdicts and domains, unclear answers and Yahoo, not confirmed leads', async () => {
    const { redis } = fakeRedis();
    await rememberVerdict(redis, 'catch', 'ana@acme.test', { verdict: 'catch_all', detail: '' });
    await rememberVerdict(redis, 'ok', 'bob@shop.test', { verdict: 'valid', detail: '' });
    await rememberVerdict(redis, 'unclear', 'cy@slow.test', { verdict: 'unknown', detail: '' });
    const risky = await riskyLeadIds(redis, [
      { id: 'catch', email: 'ana@acme.test' },
      { id: 'sameDomain', email: 'dee@ACME.test' },
      { id: 'ok', email: 'bob@shop.test' },
      { id: 'unclear', email: 'cy@slow.test' },
      { id: 'yahoo', email: 'ed@yahoo.com' },
      { id: 'unchecked', email: 'fay@new.test' },
    ]);
    expect([...risky].sort()).toEqual(['catch', 'sameDomain', 'unclear', 'yahoo']);
  });
});
