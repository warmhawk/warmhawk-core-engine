/**
 * Seed-Inbox Placement Test (Guardrails, V12) — unit test for the IMAP config encrypt/decrypt
 * round trip (`lib/seedAccounts.ts`), same AES-256-GCM mechanism as `Mailbox` credentials
 * (`encryption.test.ts`), applied to a seed account's serialized `{host, port, username,
 * password}` blob.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_SEED_BCC_SAMPLE_RATE,
  encryptSeedImapConfig,
  decryptSeedImapConfig,
  isSeedBccSample,
  seedBccSampleRate,
  subjectSha256,
} from '../../lib/seedAccounts';

const TEST_KEY = Buffer.from('a'.repeat(32)).toString('base64');

describe('seed account IMAP config encrypt/decrypt round trip', () => {
  const originalKey = process.env.MAILBOX_CREDENTIAL_KEY;

  beforeEach(() => {
    process.env.MAILBOX_CREDENTIAL_KEY = TEST_KEY;
  });

  afterEach(() => {
    process.env.MAILBOX_CREDENTIAL_KEY = originalKey;
  });

  it('round-trips a full IMAP config', () => {
    const config = {
      host: 'imap.gmail.com',
      port: 993,
      username: 'seed1@example.com',
      password: 'super-secret-app-password',
    };
    const encrypted = encryptSeedImapConfig(config);
    expect(encrypted).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(decryptSeedImapConfig(encrypted)).toEqual(config);
  });

  it('throws on a malformed (incomplete) decrypted payload', () => {
    // Encrypt something that decrypts fine but isn't a valid SeedImapConfig shape.
    const encrypted = encryptSeedImapConfig({
      host: '',
      port: 0,
      username: '',
      password: '',
    } as never);
    expect(() => decryptSeedImapConfig(encrypted)).toThrow(/Malformed seed account IMAP config/);
  });
});

describe('seed BCC sampling', () => {
  const original = process.env.SEED_BCC_SAMPLE_RATE;
  afterEach(() => {
    if (original === undefined) delete process.env.SEED_BCC_SAMPLE_RATE;
    else process.env.SEED_BCC_SAMPLE_RATE = original;
  });

  it('samples about 1 in 20 campaign sends by default', () => {
    delete process.env.SEED_BCC_SAMPLE_RATE;
    expect(seedBccSampleRate()).toBe(DEFAULT_SEED_BCC_SAMPLE_RATE);
    expect(DEFAULT_SEED_BCC_SAMPLE_RATE).toBe(0.05);
    // Deterministic sweep of rng values: exactly 5% fall under the rate.
    const hits = Array.from({ length: 1000 }, (_, i) => isSeedBccSample(() => i / 1000)).filter(Boolean);
    expect(hits).toHaveLength(50);
  });

  it('honors SEED_BCC_SAMPLE_RATE between 0 and 1, and ignores junk', () => {
    process.env.SEED_BCC_SAMPLE_RATE = '1';
    expect(seedBccSampleRate()).toBe(1);
    expect(isSeedBccSample(() => 0.999)).toBe(true);

    process.env.SEED_BCC_SAMPLE_RATE = '0';
    expect(seedBccSampleRate()).toBe(0);
    expect(isSeedBccSample(() => 0)).toBe(false);

    for (const junk of ['abc', '-1', '2', '']) {
      process.env.SEED_BCC_SAMPLE_RATE = junk;
      expect(seedBccSampleRate()).toBe(DEFAULT_SEED_BCC_SAMPLE_RATE);
    }
  });

  it('hashes the trimmed subject so the subject itself is never stored', () => {
    const hash = subjectSha256('  Quick question about Acme  ');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(subjectSha256('Quick question about Acme'));
    expect(hash).not.toBe(subjectSha256('Quick question about acme'));
  });
});
