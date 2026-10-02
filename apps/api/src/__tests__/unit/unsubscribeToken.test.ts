import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hostedUnsubscribeUrl,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from '../../lib/unsubscribeToken';

describe('unsubscribeToken', () => {
  const saved = { secret: process.env.JWT_SECRET, domain: process.env.WARMHAWK_DOMAIN };

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-only-not-a-real-secret-value';
  });

  afterEach(() => {
    if (saved.secret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = saved.secret;
    if (saved.domain === undefined) delete process.env.WARMHAWK_DOMAIN;
    else process.env.WARMHAWK_DOMAIN = saved.domain;
  });

  it('round-trips a lead id', () => {
    const token = signUnsubscribeToken('clead123');
    expect(token.startsWith('clead123.')).toBe(true);
    expect(verifyUnsubscribeToken(token)).toBe('clead123');
  });

  it('rejects a token for another lead, a tampered signature and malformed input', () => {
    const signature = signUnsubscribeToken('clead123').split('.')[1];
    expect(verifyUnsubscribeToken(`cother456.${signature}`)).toBeNull();
    expect(verifyUnsubscribeToken(`clead123.${signature.slice(0, -2)}AA`)).toBeNull();
    expect(verifyUnsubscribeToken('clead123')).toBeNull();
    expect(verifyUnsubscribeToken('clead123.')).toBeNull();
    expect(verifyUnsubscribeToken('.abc')).toBeNull();
    expect(verifyUnsubscribeToken('')).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const token = signUnsubscribeToken('clead123');
    process.env.JWT_SECRET = 'a-different-secret';
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it('builds the URL on the install domain, without the address in it', () => {
    process.env.WARMHAWK_DOMAIN = ' api.acme.example ';
    const url = hostedUnsubscribeUrl('clead123') as string;
    expect(url).toBe(`https://api.acme.example/unsubscribe/${signUnsubscribeToken('clead123')}`);
    expect(url).not.toContain('@');
  });

  it('has no URL to give on an install with no domain', () => {
    delete process.env.WARMHAWK_DOMAIN;
    expect(hostedUnsubscribeUrl('clead123')).toBeNull();
    process.env.WARMHAWK_DOMAIN = '  ';
    expect(hostedUnsubscribeUrl('clead123')).toBeNull();
  });
});
