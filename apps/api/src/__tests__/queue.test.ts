import { describe, it, expect } from 'vitest';
import { buildRedisUrl, queuedByDay } from '../routes/queue';

describe('queuedByDay', () => {
  const now = new Date('2026-10-14T17:00:00Z');
  const at = (iso: string) => Date.parse(iso);

  it('counts every job by its UTC due day, soonest day first', () => {
    expect(
      queuedByDay(now, [
        at('2026-10-16T01:00:00Z'),
        at('2026-10-14T18:00:00Z'),
        at('2026-10-15T09:00:00Z'),
        at('2026-10-15T23:59:59Z'),
      ]),
    ).toEqual([
      { day: '2026-10-14', count: 1 },
      { day: '2026-10-15', count: 2 },
      { day: '2026-10-16', count: 1 },
    ]);
  });

  it('counts overdue jobs toward today', () => {
    expect(queuedByDay(now, [at('2026-10-12T08:00:00Z'), at('2026-10-14T16:00:00Z')])).toEqual([
      { day: '2026-10-14', count: 2 },
    ]);
  });

  it('is not capped like the listed jobs', () => {
    const dueAts = Array.from({ length: 267 }, (_, i) => at('2026-10-15T00:00:00Z') + i * 1000);
    expect(queuedByDay(now, dueAts)).toEqual([{ day: '2026-10-15', count: 267 }]);
  });

  it('returns nothing for an empty queue', () => {
    expect(queuedByDay(now, [])).toEqual([]);
  });
});

// MUST match apps/worker/src/__tests__/queue.test.ts's coverage of the identical, deliberately
// duplicated helper (see apps/api/src/routes/queue.ts's header comment on the duplication).
describe('buildRedisUrl — REDIS_PASSWORD URL-encoding (bug fix, 2026-09-04)', () => {
  it('round-trips a password containing "/", "@", ":", and "%" through the WHATWG URL parser', () => {
    const password = 'ab/cd@ef:gh%ij+kl';
    const connectionString = buildRedisUrl('redis', 6379, password);

    const parsed = new URL(connectionString);
    expect(parsed.hostname).toBe('redis');
    expect(parsed.port).toBe('6379');
    expect(decodeURIComponent(parsed.password)).toBe(password);
  });

  it('produces the same plain connection string for a password with no special characters', () => {
    expect(buildRedisUrl('redis', 6379, 'plainhexpassword123')).toBe(
      'redis://:plainhexpassword123@redis:6379',
    );
  });

  it('percent-encodes a "/" so it cannot be mistaken for a path separator', () => {
    const connectionString = buildRedisUrl('redis', 6379, 'has/slash');
    expect(connectionString).toBe('redis://:has%2Fslash@redis:6379');
    expect(() => new URL('redis://:has/slash@redis:6379')).toThrow();
    expect(() => new URL(connectionString)).not.toThrow();
  });
});
