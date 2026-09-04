import { describe, it, expect } from 'vitest';
import { buildRedisUrl } from '../routes/queue';

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
