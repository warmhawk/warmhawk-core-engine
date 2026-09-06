import { describe, it, expect } from 'vitest';
import { buildRedisUrl } from '../queue';

describe('buildRedisUrl — REDIS_PASSWORD URL-encoding (bug fix, 2026-09-04)', () => {
  it('round-trips a password containing "/", "@", ":", and "%" through the WHATWG URL parser', () => {
    // Representative of an openssl-rand-base64 password (which can contain "/" and "+") and of
    // a customer hand-setting REDIS_PASSWORD to something containing URL-meaningful characters.
    const password = 'ab/cd@ef:gh%ij+kl';
    const connectionString = buildRedisUrl('redis', 6379, password);

    // Must not throw "Invalid URL" — this is exactly what crash-looped the worker before the fix.
    const parsed = new URL(connectionString);
    expect(parsed.hostname).toBe('redis');
    expect(parsed.port).toBe('6379');
    // WHATWG URL keeps the password percent-encoded on the getter; decoding it must recover the
    // original password exactly (this is also what ioredis's own parseURL does internally).
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
    // Sanity check against the literal bug: an un-encoded "/" here throws.
    expect(() => new URL('redis://:has/slash@redis:6379')).toThrow();
    expect(() => new URL(connectionString)).not.toThrow();
  });
});
